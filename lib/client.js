// dbs — DSH BGM Service(Client 半区,浏览器端浮动播放器)
// 能力:底部左浮动迷你播放器(播放/下一首/上一首/音量/进度/当前曲目),点击展开歌单;
//      接受宿主广播的 AI 命令(bgm_* 工具 → dbsPending 轮询)自动控制播放。
// 流地址: host 通过 /dbs/stream/<id> 输出音频,播放器用 同源 location.origin + track.url。

window.__ModuleLoader__.load({
  id: "dsh-bgm-service",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var CSS = "" +
      '.dbs-root{position:fixed;left:14px;bottom:14px;z-index:9992;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;color:var(--dsw-alias-label-primary)}' +
      '.dbs-player{display:flex;flex-direction:column;align-items:flex-start;gap:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:8px 10px;box-shadow:0 8px 26px rgba(0,0,0,.3);min-width:230px;max-width:min(340px,80vw)}' +
      '.dbs-now{display:flex;align-items:center;gap:8px;width:100%;cursor:pointer}' +
      '.dbs-now-ico{font-size:16px;line-height:1}' +
      '.dbs-now-main{flex:1;min-width:0;overflow:hidden}' +
      '.dbs-now-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dbs-now-sub{color:var(--dsw-alias-label-secondary);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dbs-controls{display:flex;gap:4px;align-items:center;width:100%}' +
      '.dbs-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:3px 8px;font-size:11.5px;cursor:pointer;font:inherit}' +
      '.dbs-btn:hover{border-color:var(--dsw-alias-brand-primary)}' +
      '.dbs-btn:disabled{opacity:.5;cursor:default}' +
      '.dbs-vol{flex:1;display:flex;align-items:center;gap:4px;min-width:0}' +
      '.dbs-vol input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary)}' +
      '.dbs-prog{width:100%;height:3px;background:var(--dsw-alias-bg-layer-2);border-radius:99px;overflow:hidden;cursor:pointer}' +
      '.dbs-prog-fill{height:100%;background:var(--dsw-alias-brand-primary)}' +
      '.dbs-playlist{margin-top:4px;max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:1px;width:100%;border-top:1px solid var(--dsw-alias-border-l1);padding-top:4px}' +
      '.dbs-trow{display:flex;gap:6px;align-items:center;padding:3px 5px;border-radius:6px;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary)}' +
      '.dbs-trow:hover{background:var(--dsw-alias-bg-layer-2)}' +
      '.dbs-trow-cur{color:var(--dsw-alias-label-primary)}' +
      '.dbs-trow-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dbs-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:4px 2px}' +
      '.dbs-badge{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}' +
      // 最小化后的小球(可拖动;点击展开)
      '.dbs-ball{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer;font-size:17px;color:var(--dsw-alias-label-primary);user-select:none}' +
      '.dbs-ball:hover{border-color:var(--dsw-alias-brand-primary)}' +
      '.dbs-ball-playing{color:var(--dsw-alias-brand-primary)}' +
      '.dbs-ball:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.dbs-min{padding:1px 6px;line-height:1;color:var(--dsw-alias-label-secondary)}';

    if (typeof document !== "undefined" && !document.querySelector('style[data-plugin="dbs"]')) {
      var el = document.createElement("style");
      el.setAttribute("data-plugin", "dbs");
      el.textContent = CSS;
      document.head.append(el);
    }

    function makeCaller(getConnection) {
      return function call(method, args) {
        var connection = getConnection();
        if (!connection || typeof connection.rpc !== "object" || typeof connection.rpc.call !== "function") {
          return Promise.reject(new Error("connection 服务不可用(dbs)"));
        }
        return connection.rpc.call("/api", "dbs/" + method, { args: { args: args || {} } }).then(function (r) {
          if (r && r.ok) return r.value;
          var err = (r && r.error) || {};
          throw new Error(err.message || ("调用失败: " + method));
        });
      };
    }

    function apply(ctx) {
      var call = makeCaller(function () { return ctx.get("connection"); });
      var origin = (typeof window !== "undefined" && window.location && window.location.origin) || "";
      // 播放器拖动位置持久化(跨会话)。
      var DBS_POS_KEY = "dbs-player-pos";
      function loadPlayerPos() {
        try { var v = JSON.parse(localStorage.getItem(DBS_POS_KEY)); if (v && typeof v.left === "number" && typeof v.top === "number") return v; } catch (e) { /* ignore */ }
        return null;
      }
      function savePlayerPos(pos) {
        try { localStorage.setItem(DBS_POS_KEY, JSON.stringify(pos)); } catch (e) { /* ignore */ }
      }
      // 模块内共享播放器状态(命令与用户操作都走这里)。
      var store = {
        tracks: [], current: null, playing: false, volume: 0.6, progress: 0, duration: 0,
        playlistOpen: false, error: null, dirs: [], importDir: "",
      };
      var audio = null;
      try { audio = new Audio(); audio.preload = "auto"; } catch (e) { audio = null; }
      var listeners = [];
      function commit(patch) {
        if (patch) for (var k in patch) store[k] = patch[k];
        for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) {} }
      }
      function useDbs() {
        // store 是模块级可变对象,commit() 是**原地修改**它。
        // 若把同一个引用交给 setState,React 会用 Object.is 判定"值没变"而 bail out →
        // 播放器 UI 永远不刷新(按钮状态/歌单/进度/曲名全部卡住)。所以每次都传一个新浅拷贝。
        var pair = React.useState(Object.assign({}, store));
        React.useEffect(function () {
          var on = function () { pair[1](Object.assign({}, store)); };
          listeners.push(on);
          return function () { var i = listeners.indexOf(on); if (i >= 0) listeners.splice(i, 1); };
        }, []);
        return pair[0];
      }

      function playTrack(t, silent) {
        if (!t) return;
        if (audio) {
          try {
            audio.src = origin + t.url;
            audio.volume = store.volume;
            audio.play().catch(function () {});
          } catch (e) {}
        }
        commit({ current: t, playing: true, progress: 0, duration: 0 });
      }
      function stepPlaylist(dir) {
        if (!store.tracks.length) return;
        var idx = store.current ? store.tracks.findIndex(function (t) { return t.id === store.current.id; }) : -1;
        var n = ((idx < 0 ? 0 : idx) + dir + store.tracks.length) % store.tracks.length;
        playTrack(store.tracks[n]);
      }
      function applyCommand(cmd) {
        if (!cmd || !cmd.action) return;
        switch (cmd.action) {
          case "play": {
            var t = store.tracks.find(function (x) { return x.id === cmd.trackId; });
            if (cmd.volume !== undefined) { store.volume = Math.max(0, Math.min(1, cmd.volume)); if (audio) audio.volume = store.volume; }
            if (t) playTrack(t); else if (store.tracks.length) playTrack(store.tracks[0]);
            break;
          }
          case "next": stepPlaylist(1); break;
          case "prev": stepPlaylist(-1); break;
          case "pause": if (audio) try { audio.pause(); } catch (e) {} commit({ playing: false }); break;
          case "stop": if (audio) try { audio.pause(); audio.currentTime = 0; } catch (e) {} commit({ playing: false, progress: 0 }); break;
          case "set_volume": commit({ volume: Math.max(0, Math.min(1, cmd.volume !== undefined ? cmd.volume : store.volume)) }); if (audio) audio.volume = store.volume; break;
        }
      }
      function poll() {
        call("dbsPending", {}).then(function (r) {
          if (r && r.ok && r.commands && r.commands.length) {
            for (var i = 0; i < r.commands.length; i++) applyCommand(r.commands[i]);
          }
        }).catch(function () {});
      }
      function load() {
        call("dbsList", {}).then(function (r) {
          if (r && r.ok) commit({ tracks: r.tracks || [], dirs: r.dirs || [], importDir: r.importDir || "", error: r.tracks && r.tracks.length ? null : "未配置音乐目录(musicDir/musicDirs)或目录为空" });
        }).catch(function (e) { commit({ error: String(e && e.message ? e.message : e) }); });
      }
      load();
      var timer = setInterval(poll, 1200);
      if (audio) {
        audio.addEventListener("timeupdate", function () { commit({ progress: audio.currentTime || 0, duration: (audio.duration && isFinite(audio.duration)) ? audio.duration : 0 }); });
        audio.addEventListener("ended", function () { stepPlaylist(1); });
      }
      ctx.effect(function () { return function () { clearInterval(timer); }; }, "dbs: poll timer");

      function Player(props) {
        var st = useDbs();
        var s = st;
        var cur = s.current;
        var fileInput = React.useRef(null);
        var posPair = React.useState(loadPlayerPos());
        var pos = posPair[0];
        var drag = React.useRef(null);
        // 拖动后紧接着的 click 不应被当成"点击"(否则拖完会误触发展开/还原)。
        var dragged = React.useRef(false);
        // 最小化:变成右下角一个小球。
        var minPair = React.useState(false);
        var minimized = minPair[0];
        var setMinimized = minPair[1];

        var startDrag = function (e) {
          // 只对非按钮/输入区域启动拖动,避免误触控制键。
          var t = e.target;
          if (t && t.closest && t.closest("button,input,textarea,a")) return;
          var rootEl = e.currentTarget;
          var rect = rootEl.getBoundingClientRect();
          dragged.current = false;
          drag.current = {
            offX: e.clientX - rect.left,
            offY: e.clientY - rect.top,
            w: rect.width, h: rect.height,
            startX: e.clientX, startY: e.clientY,
          };
          var onMove = function (ev) {
            var d = drag.current;
            if (!d) return;
            if (!dragged.current && Math.abs(ev.clientX - d.startX) + Math.abs(ev.clientY - d.startY) < 3) return;
            dragged.current = true;
            // 夹在视口内,保证始终能再拖回来(含"完全贴到任意边"的情形)。
            var left = Math.max(0, Math.min(Math.max(0, window.innerWidth - d.w), ev.clientX - d.offX));
            var top = Math.max(0, Math.min(Math.max(0, window.innerHeight - d.h), ev.clientY - d.offY));
            var next = { left: Math.round(left), top: Math.round(top) };
            posPair[1](next);
            savePlayerPos(next);
          };
          var onUp = function () {
            drag.current = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          if (e.preventDefault) e.preventDefault();
        };
        // 位置样式:一旦有坐标就**必须清掉 CSS 的 bottom** ——
        // position:fixed 下同时给 top 和 bottom 会把元素纵向拉伸(旧版拖动后变形的根因)。
        var posStyle = pos
          ? { left: pos.left + "px", top: pos.top + "px", right: "auto", bottom: "auto" }
          : {};
        var playPause = function () {
          if (!audio) return;
          if (s.playing) { try { audio.pause(); } catch (e) {} commit({ playing: false }); }
          else { try { audio.play().catch(function () {}); } catch (e) {} commit({ playing: true }); }
        };
        var onPickFile = function (e) {
          var f = e.target.files && e.target.files[0];
          e.target.value = "";
          if (!f) return;
          var extMatch = /\.([A-Za-z0-9]+)$/.exec(f.name);
          var ext = (extMatch ? extMatch[1] : "mp3").toLowerCase();
          f.arrayBuffer().then(function (buf) {
            return fetch(origin + "/dbs/upload?name=" + encodeURIComponent(f.name) + "&ext=" + encodeURIComponent(ext), {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: buf,
            });
          }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.ok) load();
            else commit({ error: (j && j.error) || "上传失败" });
          }).catch(function (err) { commit({ error: String(err && err.message ? err.message : err) }); });
        };
        var addByUrl = function () {
          var url = window.prompt("粘贴音频直链（MP3/M4A 等）下载入库:");
          if (!url || !url.trim()) return;
          call("dbsDownload", { url: url.trim() }).then(function (r) {
            if (r && r.ok) { load(); commit({ error: null }); }
            else commit({ error: (r && r.error) || "下载失败" });
          }).catch(function (err) { commit({ error: String(err && err.message ? err.message : err) }); });
        };
        // 最小化:只渲染一个小球(可拖动,点击还原)。
        if (minimized) {
          return React.createElement("div", { className: "dbs-root", style: posStyle, onPointerDown: startDrag },
            React.createElement("div", {
              className: "dbs-ball" + (s.playing ? " dbs-ball-playing" : ""),
              title: (cur ? (cur.title || cur.id) : "DBS 后台音乐") + (s.playing ? " · 播放中" : "") + " · 点击展开",
              role: "button", tabIndex: 0, "aria-label": "展开 DBS 播放器",
              onClick: function () { if (dragged.current) return; setMinimized(false); },
              onKeyDown: function (e) { if (e && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setMinimized(false); } },
            }, s.playing ? "♪" : "♫")
          );
        }
        return React.createElement("div", { className: "dbs-root",
          style: posStyle,
          onPointerDown: startDrag },
          React.createElement("div", { className: "dbs-player" },
            React.createElement("div", { className: "dbs-now", onClick: function () { if (dragged.current) return; commit({ playlistOpen: !s.playlistOpen }); } },
              React.createElement("span", { className: "dbs-grip" }, "⠿"),
              React.createElement("span", { className: "dbs-now-ico" }, "♪"),
              React.createElement("div", { className: "dbs-now-main" },
                React.createElement("div", { className: "dbs-now-title" }, s.error ? "* 未配置/空曲库" : (cur ? (cur.title || cur.id) : "DBS 后台音乐")),
                cur ? React.createElement("div", { className: "dbs-now-sub" }, cur.artist || s.tracks.length + " 首 · 点击展开歌单") : React.createElement("div", { className: "dbs-now-sub" }, s.tracks.length + " 首 · 点击播放")
              ),
              React.createElement("span", { className: "dbs-badge" }, s.playing ? "▶" : "⏸"),
              React.createElement("button", { className: "dbs-btn dbs-min", title: "最小化为小球", "aria-label": "最小化为小球", onClick: function (e) { e.stopPropagation(); setMinimized(true); } }, "—")
            ),
            React.createElement("div", { className: "dbs-controls" },
              React.createElement("button", { className: "dbs-btn", disabled: !cur, onClick: function () { playPause(); } }, s.playing ? "⏸" : "▶"),
              React.createElement("button", { className: "dbs-btn", onClick: function () { stepPlaylist(-1); } }, "⏮"),
              React.createElement("button", { className: "dbs-btn", onClick: function () { stepPlaylist(1); } }, "⏭"),
              React.createElement("div", { className: "dbs-vol" },
                React.createElement("span", { className: "dbs-badge" }, "🔊"),
                React.createElement("input", { type: "range", min: 0, max: 1, step: 0.01, value: s.volume, onChange: function (e) { var v = Number(e.target.value); commit({ volume: v }); if (audio) audio.volume = v; } })
              )
            ),
            s.duration > 0 ? React.createElement("div", { className: "dbs-prog", onClick: function (e) {
              if (!audio) return;
              var rect = e.currentTarget.getBoundingClientRect();
              var ratio = (e.clientX - rect.left) / (rect.width || 1);
              try { audio.currentTime = ratio * (audio.duration || 0); } catch (err) {}
            } },
              React.createElement("div", { className: "dbs-prog-fill", style: { width: (s.duration ? (s.progress / s.duration) * 100 : 0) + "%" } })
            ) : null,
            s.playlistOpen ? React.createElement("div", { className: "dbs-playlist" },
              React.createElement("div", { className: "dbs-trow", style: { cursor: "default" } },
                React.createElement("input", { type: "file", accept: "audio/*", style: { display: "none" }, ref: fileInput, onChange: onPickFile }),
                React.createElement("span", null, "📁"),
                React.createElement("span", { className: "dbs-trow-main" }, s.dirs && s.dirs.length ? ("本地 " + s.dirs.length + " 目录") : "本地音乐库"),
                React.createElement("button", { className: "dbs-btn", onClick: function () { if (fileInput.current) fileInput.current.click(); } }, "＋添加本地"),
                React.createElement("button", { className: "dbs-btn", onClick: addByUrl }, "＋链接")
              ),
              s.tracks.length === 0 ? React.createElement("div", { className: "dbs-empty" }, s.error || "暂无曲目") : null,
              s.tracks.map(function (t) {
                return React.createElement("div", { key: t.id, className: "dbs-trow" + (cur && cur.id === t.id ? " dbs-trow-cur" : ""), onClick: function () { playTrack(t); } },
                  React.createElement("span", null, "♪"),
                  React.createElement("span", { className: "dbs-trow-main" }, (t.title || t.id) + (t.artist ? " — " + t.artist : "")),
                  t.tags && t.tags.length ? React.createElement("span", { className: "dbs-badge" }, t.tags[0]) : null
                );
              })
            ) : null
          )
        );
      }

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "dbs-player", order: 290 },
          function (props) { return React.createElement(Player, props); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
