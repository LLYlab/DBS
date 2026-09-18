# DBS — DSH BGM Service（独立于 DET 的音乐播放器插件）

`npm i dsh-bgm-service` · MIT · 与 DET（`dsh-essential-tools`）、DLT（`dsh-light-tool`）命名一致

> 一个**不属于 DET** 的 DeepSeek Harness（DSH）插件：本地音乐库 + 浏览器浮动播放器 + **AI 依据任务控制播放**（模型工具 + 自动联动）+ 网络下载入库 + 乐评爬取（尽力而为）。
>
> 包名说明：npm 上的 `dbs` 已被 2014 年的无关包占用（`charliedowler/dbs`），因此发布名为 **`dsh-bgm-service`**；插件自身的短名仍是 DBS，宿主端点与 Web 路由仍是 `dbs/*`、`/dbs/stream/<id>`（与包名无关）。

## ✨ 功能
- 🎵 **本地音乐库**：扫描配置的 `musicDir`（或 `musicDirs` 多个目录）下 `.mp3/.flac/.wav/.m4a/.aac/.ogg/.opus/.webm`，文件名按 `艺术家 - 标题` 智能解析出曲目/艺术家/标签。
- 📁 **添加本地文件**：播放器歌单里「＋添加本地」选择本机音频文件，上传进音乐库（`POST /dbs/upload`）。
- 🖥 **浮动播放器（左下角）**：播放/暂停/上下首/音量/进度条/当前曲目；点「♪ 标题」展开歌单；点击任意曲目即播；播放结束自动下一首。流地址走宿主内建 HTTP（`/dbs/stream/<id>`，支持 Range 拖动进度）。
- 🤖 **AI 依据任务控制**（后台音乐）：
  - 模型工具：`bgm_list` / `bgm_play{trackId|query}` / `bgm_play_auto{query}` / `bgm_next` / `bgm_prev` / `bgm_pause` / `bgm_stop` / `bgm_set_volume`。
  - 命令队列：宿主工具把动作压入队列，播放器定期轮询并执行——AI 可依当前任务/心情选曲（按标题/艺术家/标签关键词匹配）。
  - **自动联动**（`autoLink: true`）：会话开始 / 工具调用密集时自动切一段合适的 BGM（尽力而为）。
- ⬇️ **网络下载入库**：`dbsDownload(url)` —— 从公网 URL 下载音频到本地音乐库（SSRF 校验：禁私网/环回；大小上限；按 Content-Type/扩展名落盘）。
- 📝 **乐评爬取**（尽力而为）：`dbsReview(query)` 默认抓取**豆瓣音乐**「简介」作为乐评，按查询词缓存；反爬时给出可读失败提示（请自行评估合规与频率限制）。

## 🚀 安装与接入

### A. 从 npm 安装（推荐）
```powershell
# 在 DSH 的 web profile 目录里
cd $env:USERPROFILE\.dsh\profiles
npm i dsh-bgm-service --cache .\.npm-cache
```
依赖 `@deepseek-ai/schemastery` 会随包一起装上；`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-tools` 由 DSH 本体提供。

### B. 本地开发（源码 junction）
1. 把本仓库放到你要的位置（例：`D:\plugins\DSHBgmService`）。
2. 建立符号链接（**链接名必须等于包名 `dsh-bgm-service`**，与 DLT 的 `dsh-light-tool` 同一约定）：
   `New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-bgm-service" -Target "D:\plugins\DSHBgmService"`

### 注册（A / B 都要做）
在 `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml` **追加注册行**：
```yaml
- insert:
    - id: dbs
      name: 'dsh-bgm-service'
      config:
        musicDir: 'D:\Music'                     # 本地音乐主目录(自动扫描)
        musicDirs: []                            # 额外本地目录(可选,可多个)
        importDir: ''                            # 上传/下载落盘目录;为空则用第一个根
        autoLink: false
        defaultVolume: 0.6
        reviewBase: 'https://music.douban.com'
```

### 生效
**重启 DSH** → 左下角出现 DBS 播放器；进入设置/对话即可见 `bgm_*` 工具（供 AI 调用）。
宿主改动需重启；客户端改动需刷新/重建。

## 🔒 安全口径
- 下载 URL 走 **SSRF 防护**（仅 http/https、禁私网/环回/元数据、无内嵌凭据）；文件路径始终限制在 `musicDir` 内。
- 音频仅由宿主在本机浏览器同源提供（`/dbs/stream/<id>`），无第三方地址。
- 乐评抓取为**尽力而为**的公开页面解析，可能受目标站反爬限制；请遵守目标站点服务条款与合理频率，本插件不绕过验证码/登录。
- 不涉及任何 API key；无遥测/上报。

## 🧩 端点（宿主 `dbs/*`）
`dbsList` `dbsScan` `dbsPending` `dbsCommand` `dbsDownload` `dbsReview`
模型工具：`bgm_list` `bgm_play` `bgm_play_auto` `bgm_next` `bgm_prev` `bgm_pause` `bgm_stop` `bgm_set_volume`
Web 路由：`GET /dbs/stream/<id>`（音频流，Range 支持）

## 🔧 审计与加固（2026-09-08）

| 类别 | 问题 | 处理 |
| --- | --- | --- |
| **安全（SSRF）** | `dbsDownload` / 乐评抓取用 `fetch(..., {redirect:"follow"})` —— 只校验了**初始** URL，服务器回一个 302 指向 `http://127.0.0.1/...` 即可绕过 SSRF 防护 | 新增 `fetchGuarded()`：手动逐跳跟随、**每跳复验**私网/环回/元数据、最多 5 跳（已用桩测试验证：重定向到内网时**第二跳根本不会发出**） |
| **安全（超时）** | 两处 fetch 均无 `AbortSignal` —— 不响应主机会把端点挂死 | 统一加 15s 超时 |
| **安全（DoS）** | 下载先 `arrayBuffer()` 整体读入内存**再**判大小 —— 超大响应可撑爆内存 | 先看 `Content-Length`，再**流式**读取并按上限截断 |
| **功能** | 页面刚打开时 `dbsList` 可能返回空曲库（构造函数的首次扫描还没跑完），而客户端只在 apply 时拉一次列表 → 曲库一直空着 | 保存首次扫描的 Promise，`dbsList` 等待它；`_ensureScanned(30s)` 做新鲜度与并发去重 |
| **功能** | `bgm_list` 只返回 `count`，模型拿不到任何 id/标题 —— 与工具描述不符，实际无法挑曲 | 返回曲目列表（id/title/artist/tags，默认 40 首、上限 200），并在卡片里逐行渲染 |
| **质量** | `pickFor` 无条件 `+标签数`，导致「标签多但与 query 毫不相关」的曲子总是胜出 | 改为关键词命中优先（标题 5 / 标签 4 / 艺术家 3），标签数只在**有命中**时轻微加分 |
| **功能** | 客户端 `useDbs` 把**同一个对象引用**交给 `setState`（`store` 是原地修改的），React 因 `Object.is` 相同而 bail out → **播放器 UI 永不刷新** | 每次传新的浅拷贝 |
| **功能** | 播放器**拖完会被纵向拉伸、拖不到位** | `.dbs-root` 的 CSS 带 `bottom:14px`；拖动写入 `left/top` 后 `top` 与 `bottom` 同时存在 → `position:fixed` 元素被拉伸。已改为写坐标时一并 `bottom:auto;right:auto`，并加 3px 拖动阈值避免误触 |
| **新增** | **最小化（变成小球）** | 标题栏右侧「—」→ 收成 38px 圆球：可继续拖动、点击还原、播放中变色 |
| **健壮性** | `decodeURIComponent` 遇畸形 `%` 转义会抛 | 加兜底 |
| **清理** | 死代码 `fsPath()` | 删除 |

> 宿主改动需**重启 DSH** 生效；客户端改动需刷新/重建。

## License
MIT
