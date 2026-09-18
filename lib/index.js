// dbs — DSH BGM Service(独立于 DET 的 DeepSeek Harness 音乐播放器插件)
// Host 半区:音乐库扫描 + Web 路由音频流(Range 支持) + typert 端点 + 模型工具 bgm_*(AI 依任务控制)。
//
// 能力:
//   - 本地音乐库:扫描 musicDir 下 .mp3/.flac/.wav/.m4a/.aac/.ogg/.opus/.webm
//   - 音频流:  /dbs/stream/<id>  (网络流,支持 Range 拖动进度)
//   - 网络下载入库: dbsDownload(url) (SSRF 校验 + 大小上限)
//   - 乐评爬取(尽力而为): dbsReview(query) —— 默认豆瓣音乐简介,可能被反爬,失败给出可读提示
//   - AI 工具: bgm_list/play/play_auto/next/prev/pause/stop/set_volume —— 通过命令队列交给浏览器播放器
//   - 自动联动: config.autoLink 时,会话开始/工具调用时自动为你选曲切换(尽力而为,事件缺失则静默)
//
// 安全口径:下载 URL 走 SSRF 防护(禁私网/环回);音频文件路径始终限制在 musicDir 内;API key 不涉及。

import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
import { join, relative, dirname, extname, basename, sep, resolve } from "node:path";
import { promises as fsp, createReadStream } from "node:fs";
import { statSync } from "node:fs";

const name = "dbs";
const inject = ["typert", "webServer"];

/** 插件配置。 */
const Config = z.object({
  /** 音乐库根目录(必须配置;本地扫描 + 下载/上传落盘目录)。 */
  musicDir: z.string().default(""),
  /** 额外本地音乐目录(可多个,均会被扫描进库)。 */
  musicDirs: z.array(z.string()).default([]),
  /** 上传/下载的落盘目录;缺省取第一个已配置根目录。 */
  importDir: z.string().default(""),
  /** 自动联动:会话/工具活跃时自动选曲。 */
  autoLink: z.boolean().default(false),
  /** 自动播放基础音量 0-1。 */
  defaultVolume: z.number().default(0.6),
  /** 乐评抓取源(music.douban.com 等)。为空则禁用乐评抓取。 */
  reviewBase: z.string().default("https://music.douban.com"),
  /** 单文件下载/上传大小上限(字节)。 */
  maxDownloadBytes: z.number().default(60 * 1024 * 1024),
});

const AUDIO_EXT = { ".mp3": 1, ".flac": 1, ".wav": 1, ".m4a": 1, ".aac": 1, ".ogg": 1, ".opus": 1, ".webm": 1 };
const MIME = {
  ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".webm": "audio/webm",
};

/** 相对文件名 → 曲目元数据(artist - title 启发式)。 */
function metaOf(file, title) {
  const base = basename(file, extname(file)).replace(/[_]+/g, " ").trim();
  const parts = base.split(" - ");
  let artist = "", t = base;
  if (parts.length >= 2) { artist = parts.slice(0, -1).join(" - ").trim(); t = parts[parts.length - 1].trim(); }
  return {
    title: (title || t || base).slice(0, 200),
    artist: artist.slice(0, 120),
    tags: tagFromName(base),
  };
}
function tagFromName(s) {
  const low = String(s).toLowerCase();
  const tags = [];
  for (const k of ["focus", "focus音乐", "chill", "relax", "study", "work", "loop", "game", "coding", "lofi", "jazz", "classical", "piano", "epic", "energy", "calm", "rain", "night"]) {
    if (low.indexOf(k) >= 0) tags.push(k);
  }
  return tags;
}

/** SSRF 防护(分离插件,内联实现)。 */
function isPrivateHost(host) {
  let h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (h.charAt(0) === "[" && h.charAt(h.length - 1) === "]") h = h.slice(1, -1);
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  if (h.indexOf(":") !== -1) {
    if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
    if (h.startsWith("::ffff:")) {
      const tail = h.slice(7);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return v4Private(tail);
      return true;
    }
    return false;
  }
  return v4Private(h);
}
function v4Private(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
function safeHttpUrl(raw) {
  let u = null;
  try { u = new URL(String(raw)); } catch (e) { return { ok: false, error: "非法 URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "仅允许 http/https" };
  if (u.username !== "" || u.password !== "") return { ok: false, error: "URL 不允许内嵌凭据" };
  if (isPrivateHost(u.hostname)) return { ok: false, error: "不允许访问内网/本机地址(SSRF 防护)" };
  return { ok: true, url: u.toString() };
}

/** 单跳超时(毫秒)。没有它,一个不响应的主机会把端点挂死。 */
const FETCH_TIMEOUT_MS = 15000;

/**
 * 受控抓取:手动逐跳跟随重定向 + **每一跳都复验 SSRF** + 超时 + 大小上限。
 *
 * 为什么不能用 fetch(..., {redirect:"follow"}):那样只校验了**初始** URL,
 * 服务器只要回一个 302 指向 http://127.0.0.1/... 就能绕过 safeHttpUrl(经典 SSRF 绕过)。
 * 另外:先按 Content-Length 预检、再流式读取并按上限截断,避免把超大响应整体读进内存(DoS)。
 *
 * @param {string} url 目标 URL
 * @param {{maxBytes?:number, headers?:object, text?:boolean}} [opts]
 * @returns {Promise<{ok:true, buf?:Buffer, text?:string, contentType:string, finalUrl:string}|{ok:false, error:string}>}
 */
async function fetchGuarded(url, opts) {
  const maxBytes = (opts && opts.maxBytes) || 60 * 1024 * 1024;
  const headers = (opts && opts.headers) || {};
  const wantText = !!(opts && opts.text);
  let current = String(url);
  for (let hop = 0; hop < 5; hop++) {
    const safe = safeHttpUrl(current);
    if (!safe.ok) return { ok: false, error: safe.error };
    let resp = null;
    try {
      resp = await fetch(safe.url, { headers, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      return { ok: false, error: "网络请求失败: " + String(e && e.message ? e.message : e) };
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return { ok: false, error: "HTTP " + resp.status + " 重定向无 location" };
      current = new URL(loc, current).toString();
      continue;
    }
    if (!resp.ok) return { ok: false, error: "HTTP " + resp.status };
    const contentType = resp.headers.get("content-type") || "";
    const declared = Number(resp.headers.get("content-length") || "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: "响应过大(声明 " + Math.floor(declared / 1024 / 1024) + "MB)" };
    }
    if (wantText) {
      let text = "";
      try { text = await resp.text(); } catch (e) { return { ok: false, error: "读取响应失败: " + String(e && e.message ? e.message : e) }; }
      if (text.length > maxBytes) return { ok: false, error: "响应过大" };
      return { ok: true, text, contentType, finalUrl: current };
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of resp.body) {
        total += chunk.length;
        if (total > maxBytes) {
          try { resp.body.cancel(); } catch (e) { /* ignore */ }
          return { ok: false, error: "文件过大(>" + Math.floor(maxBytes / 1024 / 1024) + "MB)" };
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      return { ok: false, error: "读取响应失败: " + String(e && e.message ? e.message : e) };
    }
    return { ok: true, buf: Buffer.concat(chunks), contentType, finalUrl: current };
  }
  return { ok: false, error: "重定向超过 5 跳" };
}

class BgmService extends TypertRemoteService {
  constructor(ctx, config) {
    super(ctx, "dbs");
    this.config = config;
    this.library = []; // [{id,title,artist,file,ext,size,tags,mtime}]
    this.libraryAt = 0;
    this.commands = []; // 待浏览器播放器消费的命令队列
    this._cmdId = 0;
    this.reviewCache = new Map();
    /** 进行中的扫描 Promise(并发去重 + 供 dbsList 等待)。 */
    this._scanning = null;
    // 首次扫描:保留 Promise,让 dbsList 能等到它完成——否则页面刚打开时 dbsList 会返回空曲库,
    // 而客户端只在 apply 时拉一次列表,曲库就一直是空的(需手动 rescan)。
    this._scanning = this._scan().catch(() => { /* 目录未配置/不存在时静默 */ }).finally(() => { this._scanning = null; });
    // 自动联动(尽力而为):会话开始 / 工具调用时自动选曲。
    if (config.autoLink) {
      ctx.effect(() => ctx.on("session/created", () => { this._autoQueue("session").catch(() => {}); }), "dbs: autoLink session");
      ctx.effect(() => ctx.on("tool/call", () => { this._autoQueue("tool").catch(() => {}); }), "dbs: autoLink tool");
    }
  }

  async rescan() {
    await this._scan();
    return this.listForWire();
  }

  async _scan() {
    // 本地根目录(单 musicDir + 多个 musicDirs)合并扫描。
    const roots = [];
    const addRoot = (d) => { if (typeof d === "string" && d.trim() !== "") roots.push(d.trim()); };
    addRoot(this.config.musicDir);
    if (Array.isArray(this.config.musicDirs)) for (const d of this.config.musicDirs) addRoot(d);
    this.library = [];
    if (!roots.length) return;
    for (const dir of roots) await this._scanRoot(dir);
    this.library.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    this.libraryAt = Date.now();
  }

  async _scanRoot(dir) {
    let rootDir;
    try { rootDir = await fsp.realpath(dir); } catch (e) { return; }
    const out = [];
    const walk = async (d) => {
      let entries = [];
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of entries) {
        if (en.name.charAt(0) === ".") continue;
        if (en.isDirectory()) { if (out.length < 5000) await walk(join(d, en.name)); continue; }
        if (!en.isFile()) continue;
        const ext = extname(en.name).toLowerCase();
        if (!AUDIO_EXT[ext]) continue;
        const full = join(d, en.name);
        const rel = relative(rootDir, full).split(sep).join("/");
        let size = 0, mtime = 0;
        try { const st = statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) { continue; }
        const id = createHash("sha1").update(rootDir + "/" + rel).digest("hex").slice(0, 20);
        out.push(Object.assign({ id, file: full, rel, ext, size, mtime }, metaOf(rel, "")));
        if (out.length >= 5000) break;
      }
    };
    await walk(rootDir);
    for (const t of out) { if (this.library.length >= 5000) break; this.library.push(t); }
  }

  listForWire() {
    const base = "/dbs/stream/";
    return this.library.map((t) => ({
      id: t.id, title: t.title, artist: t.artist, tags: t.tags || [],
      ext: t.ext, size: t.size, url: base + t.id,
    }));
  }

  /** 确保曲库已扫描且不过期(maxAgeMs 内视为新鲜;0 = 强制重扫)。并发调用共用同一个扫描。 */
  async _ensureScanned(maxAgeMs) {
    const fresh = this.libraryAt > 0 && (Date.now() - this.libraryAt) < (maxAgeMs || 0);
    if (fresh) return;
    if (this._scanning) { try { await this._scanning; } catch (e) { /* 静默 */ } return; }
    this._scanning = this._scan().catch(() => { /* 静默 */ }).finally(() => { this._scanning = null; });
    try { await this._scanning; } catch (e) { /* 静默 */ }
  }

  /** typert 端点:播放列表(客户端建立 UI)。 */
  async dbsList(args) {
    await this._ensureScanned(30 * 1000);
    return { ok: true, tracks: this.listForWire(), dirs: this._roots(), importDir: this._importDir() || "", conn: this._connInfo() };
  }
  async dbsScan(args) { await this._ensureScanned(0); return { ok: true, tracks: this.listForWire() }; }
  /** 消费当前待执行命令队列(播放器轮询)。 */
  async dbsPending(args) {
    const cmds = this.commands;
    this.commands = [];
    return { ok: true, commands: cmds };
  }
  /** 手动发起一条播放器命令(供设置/测试)。 */
  async dbsCommand(args) {
    const action = args && args.action ? String(args.action) : "";
    const trackId = args && args.trackId ? String(args.trackId) : "";
    const volume = args && typeof args.volume === "number" ? args.volume : undefined;
    if (!["play", "next", "prev", "pause", "stop", "set_volume"].includes(action)) return { ok: false, error: "未知动作 " + action };
    return this._pushCommand({ action, trackId, volume, source: "manual" });
  }

  /** 网络下载入库(SSRF 校验 + 大小上限);落盘到 importDir(缺省第一个根)。 */
  async dbsDownload(args) {
    const url = args && args.url ? String(args.url).trim() : "";
    const dir = this._importDir();
    if (!dir) return { ok: false, error: "未配置音乐目录(musicDir/musicDirs/importDir)" };
    // 逐跳复验 SSRF + 超时 + 流式大小上限(见 fetchGuarded 注释)。
    const got = await fetchGuarded(url, { maxBytes: this.config.maxDownloadBytes, headers: { "User-Agent": "dbs/0.1" } });
    if (!got.ok) return got;
    const buf = got.buf;
    if (!buf || buf.length === 0) return { ok: false, error: "下载为空" };
    const fromUrl = extname(new URL(got.finalUrl).pathname).toLowerCase();
    const fromType = { "audio/mpeg": ".mp3", "audio/flac": ".flac", "audio/wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/webm": ".webm" }[String(got.contentType).split(";")[0].trim().toLowerCase()];
    let ext = AUDIO_EXT[fromUrl] ? fromUrl : (fromType || ".mp3");
    // decodeURIComponent 对畸形 %转义会抛;兜底用原始文件名。
    let rawTitle = "";
    try { rawTitle = decodeURIComponent(basename(new URL(got.finalUrl).pathname, ext) || "track"); }
    catch (e) { rawTitle = basename(new URL(got.finalUrl).pathname, ext) || "track"; }
    const title = (args && args.title ? String(args.title) : "") || rawTitle;
    const safeTitle = String(title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "track";
    const fn = safeTitle + "_" + Date.now() + ext;
    const target = join(dir, fn);
    try { await fsp.writeFile(target, buf); }
    catch (e) { return { ok: false, error: "写入失败: " + String(e && e.message ? e.message : e) }; }
    await this._scan();
    const rec = this.library.find((t) => t.file.replace(/\\/g, "/") === target.replace(/\\/g, "/"));
    return {
      ok: true, track: rec ? this.listForWire().find((t) => t.id === rec.id) : null,
      file: target, size: buf.length, note: "已下载到本地音乐库",
    };
  }

  /** 乐评抓取(尽力而为;默认豆瓣音乐简介,可能被反爬)。 */
  async dbsReview(args) {
    const query = args && args.query ? String(args.query).trim() : "";
    if (query === "") return { ok: false, error: "缺少乐评查询词" };
    if (this.config.reviewBase === "") return { ok: false, error: "未配置乐评来源(reviewBase)" };
    const key = query.toLowerCase();
    if (this.reviewCache.has(key)) return { ok: true, cached: true, query, review: this.reviewCache.get(key) };
    try {
      const text = await this._fetchReview(query);
      if (!text) return { ok: false, error: "未抓取到乐评(来源或反爬限制)" };
      const review = text.slice(0, 2000);
      this.reviewCache.set(key, review);
      return { ok: true, cached: false, query, review, source: this.config.reviewBase };
    } catch (e) {
      return { ok: false, error: "乐评抓取失败: " + String(e && e.message ? e.message : e) };
    }
  }

  /** 豆瓣音乐搜索 + 简介抓取(尽力而为;反爬时会抛错/空)。 */
  async _fetchReview(query) {
    const base = this.config.reviewBase.replace(/\/$/, "");
    const searchUrl = base + "/subject_search?search_text=" + encodeURIComponent(query);
    const hdrs = { "User-Agent": "Mozilla/5.0 (dbs/0.1)" };
    // 同样走受控抓取(逐跳 SSRF 复验 + 超时 + 大小上限);单页 2MB 足够。
    const r1 = await fetchGuarded(searchUrl, { text: true, maxBytes: 2 * 1024 * 1024, headers: hdrs });
    if (!r1.ok || !r1.text) return "";
    const m = r1.text.match(/\/subject\/(\d+)/);
    if (!m) return "";
    const subj = base + "/subject/" + m[1] + "/";
    const r2 = await fetchGuarded(subj, { text: true, maxBytes: 2 * 1024 * 1024, headers: hdrs });
    if (!r2.ok || !r2.text) return "";
    const h2 = r2.text;
    // 提取简介(音)区文本(尽力而为)
    const intro = h2.match(/<div[^>]*class="[^"]*intro[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (intro) {
      const txt = intro[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (txt) return txt;
    }
    const desc = h2.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (desc) return desc[1].replace(/&#\d+;/g, " ").trim();
    return "";
  }

  _connInfo() {
    // 宿主 web 端口可读取(webserver.port);供客户端拼流地址(亦可直接用 window.location.origin)。
    try { const ws = this.ctx.get("webServer"); if (ws && typeof ws.port === "number") return { port: ws.port, host: ws.host }; } catch (e) { /* ignore */ }
    return null;
  }

  /** 合并后的本地根目录列表。 */
  _roots() {
    const roots = [];
    const add = (d) => { if (typeof d === "string" && d.trim() !== "") roots.push(d.trim()); };
    add(this.config.musicDir);
    if (Array.isArray(this.config.musicDirs)) for (const d of this.config.musicDirs) add(d);
    return roots;
  }

  /** 上传/下载落盘目录:importDir 优先,否则第一个根目录。 */
  _importDir() {
    if (typeof this.config.importDir === "string" && this.config.importDir.trim() !== "") return this.config.importDir.trim();
    const roots = this._roots();
    return roots[0] || "";
  }

  /** 读取请求体到 Buffer(带大小上限)。 */
  async _readBody(req, cap) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > (cap || this.config.maxDownloadBytes)) throw new Error("上传过大");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** Web 路由:POST /dbs/upload —— 上传本地音频文件进音乐库。 */
  async _upload(req, res) {
    const json = (code, obj) => { try { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); } catch (e) {} };
    try {
      const u = new URL(req.url || "/dbs/upload", "http://x");
      const name = u.searchParams.get("name") || "";
      let ext = (u.searchParams.get("ext") || "").toLowerCase();
      if (!ext && name) ext = extname(name).toLowerCase();
      if (!AUDIO_EXT[ext]) { json(415, { ok: false, error: "不支持该音频扩展名: " + ext }); return; }
      const dir = this._importDir();
      if (!dir) { json(400, { ok: false, error: "未配置音乐目录(musicDir/musicDirs/importDir)" }); return; }
      if (String(req.method).toUpperCase() !== "POST") { json(405, { ok: false, error: "仅支持 POST" }); return; }
      const buf = await this._readBody(req, this.config.maxDownloadBytes);
      if (!buf.length) { json(400, { ok: false, error: "空请求体" }); return; }
      const safe = (String(name || "track").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "track") + "_" + Date.now() + ext;
      await fsp.writeFile(join(dir, safe), buf);
      await this._scan();
      json(200, { ok: true, file: safe, size: buf.length });
    } catch (e) {
      json(500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  _pushCommand(cmd) {
    const rec = Object.assign({ id: "c" + (++this._cmdId), ts: Date.now() }, cmd);
    this.commands.push(rec);
    if (this.commands.length > 20) this.commands.shift();
    return { ok: true, command: rec };
  }

  /** 依任务/场景选曲并下发(AI 工具与自动联动共用)。 */
  pickFor(query) {
    if (!this.library.length) return null;
    const words = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    const score = (t) => {
      const title = String(t.title || "").toLowerCase();
      const artist = String(t.artist || "").toLowerCase();
      const tags = (t.tags || []).map((x) => String(x).toLowerCase());
      let s = 0, matched = false;
      for (const w of words) {
        if (title.indexOf(w) >= 0) { s += 5; matched = true; }
        else if (tags.some((x) => x.indexOf(w) >= 0)) { s += 4; matched = true; }
        else if (artist.indexOf(w) >= 0) { s += 3; matched = true; }
      }
      // 标签数只在「确实有词命中」时才轻微加分。
      // 旧实现无条件 +标签数,导致"标签多但和 query 毫不相关"的曲子总是胜出。
      if (matched) s += Math.min(tags.length, 3) * 0.5;
      return s;
    };
    let best = null, bestScore = -1;
    for (const t of this.library) { const s = score(t); if (s > bestScore) { best = t; bestScore = s; } }
    return best;
  }

  async _autoQueue(ctxLabel) {
    const pick = this.pickFor(ctxLabel === "tool" ? "focus work coding" : "loop chill");
    if (!pick) return;
    this._pushCommand({ action: "play", trackId: pick.id, volume: this.config.defaultVolume, source: "auto", label: ctxLabel });
  }

  // ── Web 路由: /dbs/stream/<id>(音频流,支持 Range)──────────────────────
  async _stream(req, res) {
    const pathname = (req.url || "").split("?")[0];
    const id = pathname.replace(/^\/dbs\/stream\/?/, "");
    const rec = this.library.find((t) => t.id === id);
    if (!rec) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
    if (!AUDIO_EXT[rec.ext]) { res.writeHead(415); res.end("unsupported"); return; }
    let size;
    try { size = statSync(rec.file).size; } catch (e) { res.writeHead(404); res.end("missing"); return; }
    const type = MIME[rec.ext] || "audio/mpeg";
    const range = req.headers.range;
    const base = (code, extra) => {
      res.writeHead(code, Object.assign({
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-DBS-File": encodeURIComponent(rec.title || rec.id),
      }, extra));
    };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end)) end = size - 1;
      if (start > end || start >= size) { base(416, { "Content-Range": "bytes */" + size }); res.end(); return; }
      end = Math.min(end, size - 1);
      base(206, { "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": end - start + 1 });
      const stream = createReadStream(rec.file, { start, end });
      stream.on("error", () => res.end());
      stream.pipe(res);
      return;
    }
    base(200, { "Content-Length": size });
    const stream = createReadStream(rec.file);
    stream.on("error", () => res.end());
    stream.pipe(res);
  }
}

const METHOD_NAMES = ["dbsList", "dbsScan", "dbsPending", "dbsCommand", "dbsDownload", "dbsReview"];

function buildInvocations() {
  return METHOD_NAMES.map((method) => ({
    id: "dbs-" + method,
    service: "dbs",
    namespace: "dbs",
    method,
    parameters: [{ name: "args", wire: "args", source: "json", codec: { mode: "src-json" } }],
    result: { mode: "src-json" },
    invocation: { kind: "direct" },
  }));
}

/** 注册模型工具 bgm_*(AI 依据任务控制播放;命令经命令队列交给浏览器播放器)。 */
function registerBgmTools(ctx, service) {
  const tools = ctx.get("tools");
  if (!tools || typeof tools.register !== "function") return;
  const wire = (rec) => rec && rec.ok ? rec : null;
  tools.register(defineTool({
    name: "bgm_list",
    description: "列出 DBS 音乐库中的曲目(id/标题/艺术家/标签),用于按任务或心情挑选背景音乐。需要播放时用 bgm_play 传入 trackId 或按关键词匹配。",
    parameters: { limit: { type: "number", description: "可选:最多返回多少首(默认 40,上限 200)。" } },
    output: {
      schema: {
        type: "object", additionalProperties: false, properties: {
          count: { type: "number", required: true },
          tracks: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            id: { type: "string", required: true },
            title: { type: "string", required: true },
            artist: { type: "string", required: true },
            tags: { type: "array", items: { type: "string" } },
          } } },
        },
      },
      render: (_a, v) => [{
        type: "text",
        text: "音乐库共 " + (v.count || 0) + " 首" + ((v.tracks || []).length < (v.count || 0) ? "(列出前 " + (v.tracks || []).length + " 首)" : "") + ":\n" +
          (v.tracks || []).map((t) => "· " + t.id + "  " + t.title + (t.artist ? " - " + t.artist : "") + (t.tags && t.tags.length ? "  [" + t.tags.join(",") + "]" : "")).join("\n"),
      }],
    },
    async execute(args) {
      // 旧实现只返回 count —— 模型拿不到任何 id/标题,根本无法挑曲(与工具描述不符)。
      const limit = Math.max(1, Math.min(200, Number((args && args.limit) || 40)));
      const tracks = service.library.slice(0, limit).map((t) => ({
        id: String(t.id), title: String(t.title || ""), artist: String(t.artist || ""),
        tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
      }));
      return { count: service.library.length, tracks };
    },
  }));
  const playDef = {
    name: "bgm_play",
    description: "指定播放 DBS 音乐库中的一首曲目。可传 trackId(精确,来自 bgm_list)或 query(按标题/艺术家/标签关键词匹配,适合按当前任务选曲)。播放器已存在时会切到该曲。",
    parameters: { trackId: { type: "string", description: "曲目 id(来自 bgm_list)。" }, query: { type: "string", description: "关键词(按任务/心情匹配标题/标签)。" } },
    output: { schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true }, title: { type: "string" }, message: { type: "string", required: true } } }, render: (_a, v) => [{ type: "text", text: v.message }] },
    async execute(args) {
      const id = args && args.trackId ? String(args.trackId) : "";
      const query = args && args.query ? String(args.query) : "";
      let rec = null;
      if (id) rec = service.library.find((t) => t.id === id) || null;
      if (!rec && query) rec = service.pickFor(query) || null;
      if (!rec) return { ok: false, message: query ? ("未在音乐库中匹配到「" + query + "」") : "未指定 trackId 且未匹配(query)。请先用 bgm_list 查看。" };
      service._pushCommand({ action: "play", trackId: rec.id, volume: service.config.defaultVolume, source: "ai" });
      return { ok: true, title: rec.title, message: "播放「" + rec.title + "」" + (rec.artist ? " - " + rec.artist : "") };
    },
  };
  tools.register(defineTool(Object.assign({}, playDef, { name: "bgm_play_auto", description: "根据当前任务描述自动挑选并播放一首合适的背景音乐(按标题/艺术家/标签匹配;建议在任务开始时调用)。" , parameters: { query: { type: "string", required: true, description: "任务/场景描述,用于匹配曲风。" } } })));
  for (const meta of [
    { name: "bgm_next", desc: "播放下一首。" },
    { name: "bgm_prev", desc: "播放上一首。" },
    { name: "bgm_pause", desc: "暂停播放。" },
    { name: "bgm_stop", desc: "停止播放并清空进度。" },
  ]) {
    tools.register(defineTool({
      name: meta.name,
      description: meta.desc,
      parameters: {},
      output: { schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } }, render: (_a, v) => [{ type: "text", text: "已执行 " + meta.name }] },
      async execute() { service._pushCommand({ action: meta.name.replace("bgm_", ""), source: "ai" }); return { ok: true }; },
    }));
  }
  tools.register(defineTool({
    name: "bgm_set_volume",
    description: "设置播放器音量(0-1,浮点;默认 0.6)。",
    parameters: { volume: { type: "number", required: true, description: "音量 0-1。" } },
    output: { schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true }, volume: { type: "number" } } }, render: (_a, v) => [{ type: "text", text: "音量已设为 " + v.volume }] },
    async execute(args) {
      let v = Number(args && args.volume);
      if (!isFinite(v)) v = 0.6;
      v = Math.max(0, Math.min(1, v));
      service._pushCommand({ action: "set_volume", volume: v, source: "ai" });
      return { ok: true, volume: v };
    },
  }));
  const sp = ctx.get("systemPrompt");
  if (sp && typeof sp.section === "function") {
    sp.section({
      name: "tool:dbs-bgm",
      order: 117,
      text: "# DBS 背景音乐\n\nDBS 维护一个本地音乐库并可在浏览器播放背景音乐。你可以根据当前任务/心情用 bgm_play / bgm_play_auto(传 query 关键词)选曲,用 bgm_next / bgm_prev / bgm_pause / bgm_stop / bgm_set_volume 控制播放;bgm_list 查看曲目。播放是辅助性功能,不应影响主任务推进。",
    });
  }
}

function apply(ctx, config) {
  const service = new BgmService(ctx, config);
  ctx.typert.register({
    package: "dbs",
    face: "host",
    model: {},
    schemas: [],
    invocations: buildInvocations(),
  });
  // 音频流路由(前缀;浏览器 <audio src="/dbs/stream/<id>"> )。
  ctx.effect(() => {
    return ctx.get("webServer").register({
      kind: "prefix",
      path: "/dbs/stream",
      handler: (req, res) => { service._stream(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (e) {} }); },
    });
  }, "dbs: audio stream route");
  // 本地上传路由(POST /dbs/upload?name=..&ext=.. ,体为原始音频字节)。
  ctx.effect(() => {
    return ctx.get("webServer").register({
      kind: "exact",
      path: "/dbs/upload",
      handler: (req, res) => { service._upload(req, res).catch(() => { try { res.writeHead(500); res.end("{}"); } catch (e) {} }); },
    });
  }, "dbs: upload route");
  registerBgmTools(ctx, service);
  return service;
}

export { Config, BgmService, apply, inject, name };
export default { name, inject, Config, apply };
