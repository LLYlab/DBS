# Changelog

All notable changes to DBS (`dsh-bgm-service`) are documented here.

## [0.1.0] — 2026-09-18

首个发布版本（此前以本地 junction 方式接入 DSH profile）。

### 功能
- **本地音乐库**：扫描 `musicDir` / `musicDirs` 下的 `.mp3/.flac/.wav/.m4a/.aac/.ogg/.opus/.webm`；文件名按 `艺术家 - 标题` 解析曲目 / 艺术家 / 标签。
- **添加本地文件**：播放器歌单「＋添加本地」上传进音乐库（`POST /dbs/upload`）。
- **浮动播放器（左下角）**：播放/暂停/上下首/音量/进度条；点标题展开歌单；播放结束自动下一首；音频流走宿主 `GET /dbs/stream/<id>`（支持 Range 拖动）。
- **最小化**：标题栏「—」收成 38px 圆球，可继续拖动、点击还原、播放中变色。
- **AI 依据任务控制播放**：模型工具 `bgm_list` / `bgm_play` / `bgm_play_auto` / `bgm_next` / `bgm_prev` / `bgm_pause` / `bgm_stop` / `bgm_set_volume`；命令队列由播放器轮询执行；可选 `autoLink` 自动联动。
- **网络下载入库**：`dbsDownload(url)`，带 SSRF 校验（禁私网/环回/元数据）与大小上限。
- **乐评抓取（尽力而为）**：`dbsReview(query)`，按查询词缓存，默认源为豆瓣音乐「简介」。

### 安全与健壮性加固（2026-09-08 审计）
- `fetchGuarded()`：手动逐跳跟随重定向，**每一跳都复验**私网 / 环回 / 元数据，最多 5 跳（修复"302 指向内网绕过 SSRF 校验"）。
- 两处 `fetch` 统一加 15s `AbortSignal` 超时。
- 下载改为先看 `Content-Length` 再**流式**读取并按上限截断（原先整体读入内存再判大小，可被超大响应撑爆内存）。
- `dbsList` 等待首次扫描 Promise + `_ensureScanned(30s)` 新鲜度与并发去重（修复刚打开时曲库为空）。
- `bgm_list` 由只返回 `count` 改为返回曲目列表（id/title/artist/tags，默认 40、上限 200）。
- `pickFor` 改为关键词命中优先（标题 5 / 标签 4 / 艺术家 3），修复"标签多但与 query 无关"的曲子总胜出。
- 客户端 `useDbs` 每次传新的浅拷贝（修复 React `Object.is` bail out 导致播放器 UI 永不刷新）。
- 播放器拖动改为写入坐标时一并 `bottom:auto;right:auto`（修复拖完被纵向拉伸）+ 3px 拖动阈值。
- `decodeURIComponent` 畸形 `%` 转义兜底；删除死代码 `fsPath()`。

### 发布说明
- 包名从 `dbs` 改为 **`dsh-bgm-service`**：npm 上的 `dbs` 已被 2014 年的无关包占用（`charliedowler/dbs`），无法发布。
- 命名与 `dsh-essential-tools`（DET）、`dsh-light-tool`（DLT）保持一致。
- 本地开发可用 junction 接入（见 README）；正式接入改为 npm 安装。
