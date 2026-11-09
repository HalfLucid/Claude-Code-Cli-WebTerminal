# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Build: **before running `dotnet build`, check if webterm is running** (`Get-Process webterm -EA SilentlyContinue`). If running, skip the build — the DLL is locked and it will fail. The user will restart webterm themselves to pick up changes.
- Run (dev): `dotnet run` — launches on `http://localhost:5265` (and `https://localhost:7044` via `https` profile) per `Properties/launchSettings.json`.
- Run (production binding): the app calls `app.Run("http://0.0.0.0:7681")` in `Program.cs`, so a published/release run listens on `:7681` on all interfaces, ignoring `launchSettings.json`.
- Publish: `dotnet publish -c Release`

No test project exists.

## Architecture

ASP.NET Core minimal API (`Program.cs`) + static frontend (`wwwroot/`) that exposes a browser-based terminal via WebSocket-to-PTY bridge with persistent, multi-tab sessions.

### Server (Program.cs)

**Endpoints:**
- `GET /` — serves `wwwroot/index.html` via `UseDefaultFiles` + `UseStaticFiles`
- `Map /ws?sid=<guid>[&from=<offset>&cols=<c>&rows=<r>]` — WebSocket upgrade; looks up or creates a `Session` keyed by `sid`; `from` resumes replay at a byte offset, `cols`/`rows` are the client's grid (see Resumable replay)
- `GET /api/settings` — returns projects, button config (no credentials)
- `POST /api/projects` — add Claude project (name, directory, color)
- `PUT /api/projects/{id}` — update project
- `DELETE /api/projects/{id}` — remove project
- `PUT /api/buttons` — update button order + custom buttons
- `GET /api/sessions` — returns all active sessions with metadata (sid, kind, label, color, projectId, launched, connected). Server is source of truth for tab list; replaces localStorage persistence.
- `GET /api/events` — SSE (Server-Sent Events) stream for real-time tab notifications. Events: `tab_opened`, `tab_closed`, `tab_attention`, `tab_idle`, `show_file`, `copy_text`. Browser subscribes via EventSource on page load.
- `POST /api/notify?token=<key>` — receives Claude Code hook notifications (`{sid, event}`). Maps `permission_request` → `tab_attention` SSE, `stop` → `tab_idle` SSE. Auth via MCP token, exempt from Basic auth.
- `POST /api/upload?sid=<sid>` — multipart upload of files pasted/dropped in the browser. Writes them to the tab's upload dir and returns `{paths: [...]}` (absolute host paths). 20 MB per file.
- `GET /api/file/{id}` — serves a file registered by the MCP `show_file` tool, by its transient id. Range-enabled so video/audio can seek. 404 once the id is gone (dismissed client-side, or evicted by the 50-entry cap).
- `DELETE /api/file/{id}` — drops the id→path reference (the source file on disk is never touched). Called when the viewer overlay is dismissed.
- `POST /api/mcp-setup` — generates DPAPI-encrypted MCP API key (if not exists), installs Claude Code hooks for tab notifications, returns `claude mcp add` command string with token. Idempotent.
- `POST /mcp?token=<key>` — MCP server endpoint (JSON-RPC 2.0, Streamable HTTP transport). Tools: `open_tab`, `close_tab`, `list_tabs`, `restart`, `show_file`, `copy_text`. Auth via token query param, exempt from Basic auth middleware.

**First-run setup:** If no `webterm-settings.json` exists beside the exe, prompts for username/password in console before starting the web server. Credentials are encrypted with Windows DPAPI (`ProtectedData`, `DataProtectionScope.CurrentUser`) and stored in the settings file.

**Browser auto-open:** On `ApplicationStarted`, opens default browser to `http://localhost:7681`.

**Middleware order:** auth (exempts `/mcp` and `/api/notify`) → WebSockets → DefaultFiles → StaticFiles → route mappings.

### Settings file (`webterm-settings.json`, beside exe)

JSON with: `credentials` (DPAPI-encrypted), `projects` (array of {id, name, directory, color}), `buttons` (order array + custom buttons), `defaultPowershellColor`, `mcpKeyProtected` (DPAPI-encrypted MCP API key, generated on first "Add MCP" click).

### Session persistence (decoupled PTY lifetime)

`Session` (sealed class in `Program.cs`) owns one `IPtyConnection` per client `sid`. Sessions live in a process-global `ConcurrentDictionary<string, Session>`. PTY lifetime is **independent of the WebSocket** — disconnecting (screen sleep, network loss) does **not** kill the shell. Reconnecting with the same `sid` reattaches.

Key pieces inside `Session`:

- **Ring buffer**: `LinkedList<(long start, byte[] data)>` capped at `MaxBuffer = 2 MB` (≈ the client's 5000-line xterm scrollback of escape-heavy Claude output). `ReadLoop` reads from `Pty.ReaderStream`, appends to buffer, evicts oldest chunks, forwards via `TryWrite` to currently-attached channel.
- **Per-attachment send pump**: each `Attach` creates an `Attachment` (socket + `Channel<(bool text, byte[] payload)>` + abort deadline); its pump is the socket's only sender. Replay frames, PTY output, pongs and the final close all go through it, so no `SendAsync`/close ever overlaps. Ending an attachment (`EndAttachment`) completes the channel; the pump drains it, sends the close frame (`CloseOutputAsync`) if there is a reason, and the deadline `Abort()`s the socket 5 s later if the handshake hasn't finished. A single send stalled for 60 s also aborts. On PTY exit, `ReadLoop` ends the attachment with `"pty-exited"` and `{"ptyExited":true}` as its `FinalFrame`: the pump drops whatever output is still queued (the client removes the tab anyway), sends the final frame after the send in flight (if any), then the close. Queued behind a big replay on a slow link, the notice could outlast the 5 s deadline; the abort would make the client reconnect, and once the reaper had removed the session that reconnect would get `{choose}` and launch a fresh shell in the tab.
- **Replacement protocol**: a second client with the same sid takes over at once: its replay is queued under the session lock and the old attachment is ended with `"replaced"` without being awaited (a phone waking from sleep leaves a dead socket that would stall the new attach for the full close timeout). The live old client still receives the `"replaced"` close, which triggers its takeover popup. Its pump drops whatever output is still queued and sends that close right after the send in flight (if any) finishes; draining first could outlast the 5 s close deadline on a slow link, and the resulting abort (code 1006, no reason) would make the old client reconnect and replace the new one. (`"pty-exited"` skips the queue the same way, via `Attachment.SkipsQueue`; its `{ptyExited}` notice is the `FinalFrame`, sent before the close, so it is not dropped with the queue.) Until it closes, a replaced socket's input and resizes are ignored, and its teardown only clears the session's attachment if it is still current.
- **Resumable replay**: the client tracks `tab.recvOffset` (absolute PTY byte offset it has rendered) and reconnects with `/ws?sid=<sid>&from=<offset>&cols=<c>&rows=<r>`. On attach the server first sends a `{"offset":N}` text frame, then replays from `N`: the client's offset if it is still inside the ring buffer **and** the PTY size stayed at the client's `cols`×`rows` from there on (`SizeUnchangedSince`; otherwise xterm would reflow the screen it already has), else a point within the last `MaxReplay = 512 KB` (or the oldest buffered byte if the buffer holds less). Chunks are arbitrary 4 KB PTY reads, not ConPTY write boundaries, so `SafeReplayStart` scans up to 16 KB forward from the cap for a byte just before an ESC or just after a LF (else the first non-UTF-8-continuation byte), so the replay never begins inside an escape or UTF-8 sequence; `N` may be mid-chunk and is exactly the first byte sent. The cap keeps a fallback replay from stalling a phone for seconds (2 MB of escape-heavy output plus a reflow per size marker) with live output and typed echo queued behind it; the 2 MB ring buffer still lets short disconnects resume. A resume is never capped. If `N` differs from `tab.recvOffset` the client `term.reset()`s before the replay so output is never stacked twice. The reset goes through `queueReset` (inside a `term.write('', cb)`, like `queueResize`), because bytes from the previous socket may still be in xterm's write queue and an immediate reset would let them parse on top of the new replay. `hardRefresh` clears `recvOffset` to force a full replay, and queues its reset and `fit()` the same way.
- **Size-faithful replay**: output is laid out for the PTY size it was produced at, so `Session._sizes` records `(offset, cols, rows)` on launch and on every resize (pruned alongside the ring buffer). The offset frame carries the size in effect at `N` (`{"offset":N,"cols":c,"rows":r}`; 0 when unlaunched), `{"size":{cols,rows}}` text frames are interleaved with the replay bytes at the offsets where the size changed after `N` (earlier markers are folded into the offset frame's size, never sent), and `{"replayEnd":true}` closes it. The client applies each size via `queueResize` (a `term.write('', cb)` so the resize lands between the right bytes, since `term.resize` is synchronous but writes are queued). On `replayEnd` it sends its own size to the server immediately (via `proposeDimensions`, so it precedes any launch message), then fits xterm back to its container once the replay has drained. `tab.replaying` blocks `sendSize`/`forceResize` meanwhile. If the tab is hidden at `replayEnd`, nothing is sent and `tab.sentCols`/`sentRows` are cleared, so the `forceResize` on tab switch sends the size (it otherwise only sends when the grid differs from `sentCols`/`sentRows`). A capped replay adds `"truncated":true` to the offset frame: rows ConPTY drew before `N` and never redrew (e.g. the top of the screen during a long spinner) are missing, as are modes set before `N` (SGR, cursor visibility). No mode prefix is sent: the client's `term.reset()` already starts from defaults, the jiggle makes ConPTY repaint with absolute positioning and full SGR, and xterm's input modes are irrelevant because the client builds its own key sequences. The client tracks the PTY's size through the replay (`tab.replayCols`/`replayRows`) and, once it knows its own size (at `replayEnd`, or on tab switch if hidden), sets `tab.pendingJiggle` only if that size equals the PTY's: a different size is a real resize that already makes ConPTY/Claude repaint, and a jiggle on top would just print the transcript again (`jiggleIfTruncated` in `connection.js`).
- **Heartbeat**: after a network switch, sleep or Wi-Fi blip the browser can keep a socket at `readyState === 1` that the server already dropped, and JS can't see protocol pings. So the client records `tab.lastRecv` on every frame (replay included) and, while open, sends `{"ping":n}` every 15s; the server's receive loop answers `{"pong":n}` through the send pump (the attachment channel carries `(text, payload)` frames, since only the pump may `SendAsync`). No frame for 35s → the socket is dropped and `scheduleReconnect` runs; `recvOffset` is kept, so it resumes rather than wipes. Hidden pages run timers late, so that check only fires on a visible, on-time tick; instead `reconnectIfNeeded` (visibilitychange/online) pings a socket that looks open but has been quiet >5s and reconnects if nothing arrives within 3s. A socket can also hang at `readyState === 0` after a network switch, before the heartbeat starts, so `connect` arms a 10s connect timeout (`tab.connectTimer`, cleared on open, close and `disconnect`) that drops it the same way and goes through `scheduleReconnect`.
- **Metadata**: each session stores `Kind`, `Label`, `Color`, `ProjectId` — set during `Launch()` or from browser's launch JSON. Enables `GET /api/sessions` and MCP `list_tabs`.
- **Reaper**: background task scans every minute and `Dispose()`s a session when `Session.ReapReason` returns a reason: its PTY has exited (reaped at the next scan); it has no PTY (never launched, or the spawn failed) and no socket has been attached for 10 minutes (`UnlaunchedReapAfter`); or its PTY is live but no socket has been attached **and** `ReadLoop` has seen no output for 24 hours (`SilentReapAfter`). Detaching alone never kills a live PTY, so a phone asleep for hours doesn't end a Claude session that is working or waiting at its prompt. The reason is logged on the `SESSION REAPED` line, and a `tab_closed` SSE event is broadcast.
- **Launch**: `Launch(kind, projectId, settingsManager, sid)` — looks up project directory from settings. PowerShell sessions spawn via `powershell.exe`. Claude sessions spawn via `cmd.exe /K claude` (or `claude --resume`), with `WEBTERM_SID` and `WEBTERM_NOTIFY_TOKEN` environment variables injected for hook notifications.

### Client (wwwroot/)

**File structure:**
- `index.html` — HTML shell with tab bar, terminal container, main screen, button overlay, modals
- `css/style.css` — all styles
- `js/settings.js` — API calls to `/api/settings`, `/api/projects`, `/api/buttons`
- `js/terminal.js` — xterm.js instance factory (create/destroy per tab); loads the Unicode 11 addon so glyph widths match ConPTY, and the WebGL renderer (grid-locked glyphs; falls back to DOM on context loss)
- `js/connection.js` — per-tab WebSocket management, reconnect logic, resize
- `js/buttons.js` — configurable button overlay with model/effort popouts
- `js/tabs.js` — multi-tab state, tab bar rendering, `createExternalTab()` for server/MCP-initiated tabs
- `js/mainscreen.js` — project launcher UI, project CRUD modals, button config modal, MCP setup button
- `js/app.js` — orchestrator (input bridge, resize handlers, visibility/online recovery, server session restore, SSE listener)

**Multi-tab architecture:**
- Each tab has its own `sid`, xterm Terminal, FitAddon, WebSocket, and container div
- Tab state sourced from server via `GET /api/sessions` on page load (replaces localStorage persistence)
- Real-time updates via SSE (`/api/events`): `tab_opened` creates tab, `tab_closed` removes tab, `tab_attention` / `tab_idle` trigger attention indicators
- Cross-device: any browser connecting sees all active sessions. Second device connecting to same sid replaces first (existing replacement protocol).
- `createExternalTab(sid, kind, projectId, label, color)` — creates tab for server-side session, sets `restored: true` (so a `{choose}` reply, meaning the server lost it, removes the tab) and `confirmed: true`
- **Tab removal vs. session deletion**: `TabManager.removeTab(tab, deleteSession)` drops a tab from this browser; it sends `DELETE /api/sessions/{sid}` (killing the PTY) only when `deleteSession` is set. Only the user's explicit close (`closeTab`) and the certainly-dead cases delete: `{ptyExited}` (process gone) and `{choose}` on a `restored` or `confirmed` tab (the server lost a session it had launched, and our socket just created an empty unlaunched one in its place). `{choose}` launches only for a tab this browser created that has never been confirmed, including after its first socket drops before the launch is processed; a confirmed tab never launches a second process. Everything inferred from the session list — `reconcileSessions`, SSE `tab_closed`, and `scheduleReconnect` after 5 failed reconnects (a 401 there reloads the page) — removes the tab locally only, so a guess can never kill a live session.
- **Confirmation**: `/api/sessions` lists a session only after its launch is processed, so a just-created local tab (slow link, socket still connecting) is legitimately absent. A tab is `confirmed` once its sid appears in `/api/sessions`, or its socket gets PTY output or an `{offset}` frame with a nonzero size (launched session). `reconcileSessions` and the 5-failure path drop only confirmed tabs that are missing from the list; tabs from `createExternalTab` start confirmed. Every route to `confirmed` is server evidence of a launch, so a `{choose}` on a confirmed tab means the session was lost (see above).

**Resize discipline:** every real PTY resize makes ConPTY repaint and Claude reprint its transcript, which stacks duplicate paragraphs in xterm's scrollback. So the mobile keyboard must never change the row count: `applyViewportSize()` keeps `#terminals` at its CSS (layout-viewport) height and `translateY`s it up by the keyboard-covered amount — but only as far as needed to keep the lowest row holding text or the cursor visible (`contentBottom()`), so a fresh session's prompt near the top isn't pushed off-screen. `term.onWriteParsed` → `Connection.scheduleSlide()` re-slides as output grows toward the keyboard. `sendSize()` only sends `{cols, rows}` (and scrolls to bottom) when the grid actually changed; `forceResize()` (tab switch, wake) always re-measures, fits and repaints but likewise only sends a changed size. On connect the size is sent at `replayEnd`, not on socket open.

**Main screen:** Full-page launcher (replaces old chooser modal). Shows PowerShell button + Claude project list from settings. Each project has "Open Claude" and "Resume Claude" buttons. Add/edit/delete projects via modal.

### Input bridge (browser ↔ PTY)

- **Binary frames** browser → server: written straight to `Pty.WriterStream`.
- **Text frames** browser → server: parsed as JSON; `{launch, projectId, label, color}` triggers `Session.Launch` (label/color stored as metadata), `{cols, rows}` triggers `Pty.Resize`.
- The hidden `#ta` textarea is the input source. On each input it diffs the current value against the text already sent (`sentText`), sends one `\x7f` (DEL) per code point after the first difference, then sends the new tail (see `rewrite()` in `app.js`). Never retransmit the whole value per keystroke — that makes long input O(n) per key and forces Claude to redraw the whole prompt. This is how mobile IME / autocorrect edits are reflected — preserve this contract if changing input handling.
- Special keys (Enter, Tab, Shift+Tab, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Insert, Esc, Ctrl+letter) are intercepted in `keydown` and translated to raw escape sequences. Arrow, Home, and End keys support Ctrl and Shift modifier variants.
- **Ctrl+C / Ctrl+V**: if text is selected in the terminal, Ctrl+C copies it (no SIGINT); Ctrl+V is a no-op in `keydown` and lets the native `paste` event on `#ta` fire instead, so `clipboardData` is read from the paste gesture itself (no clipboard-read permission chip). The right-click menu's Paste still calls `navigator.clipboard.readText()` since it has no paste gesture to hook. When nothing is selected, Ctrl+C sends raw ^C as usual. All pasted text is normalized to LF and wrapped in bracketed-paste (`\x1b[200~...\x1b[201~`) so a multi-line paste is treated as one block instead of submitting per line. A paste bypasses `#ta`, so afterwards `#ta`/`sentText` are cleared; otherwise a later DEL-based diff would erase Claude's `[Pasted text]`/`[Image]` placeholder.
- **Right-click context menu**: xterm renders on canvas so the browser's native context menu has no Copy/Paste — a custom `.term-menu` overlay (in `terminal.js`) provides Copy and Paste items on right-click.
- **Image paste / drag-drop**: the PTY is a keystroke stream, so image bytes can't be sent down it, and HTML5 drag-drop never exposes a real filesystem path. Pasting or dropping a file therefore POSTs the bytes to `/api/upload`, and the returned absolute host path is typed into the PTY (bracketed paste, quoted if it contains spaces) — the same thing a native terminal does when you drag a file onto it. Claude Code detects the image path and attaches it. `dragover`/`drop` are `preventDefault`ed on `document`; without that the browser navigates away to the dropped image.
- **Upload directory**: `<project>\.webterm\uploads\` when the tab has a project, so the path is inside Claude's cwd and needs no Read approval. A self-ignoring `.webterm\.gitignore` (containing `*`) keeps the folder out of git. Tabs with no project (PowerShell) fall back to `%TEMP%\webterm-uploads\`. A background task sweeps files older than 24h, hourly.
- **Tab input persistence**: switching tabs saves and restores textarea value and `sentText`, so in-progress input survives tab switches.

### Button overlay

Configurable button bar on right side. Two states:
- **Collapsed:** shows only the `minimizedOnly` buttons — scroll-up, scroll-down, and reload (`Connection.hardRefresh`: resets input state, wipes xterm, opens a fresh WebSocket so the ring buffer replays, then nudges the PTY one column narrower and back so ConPTY/Claude repaint the screen. A same-size resize is a no-op in ConPTY, which is why maximize/restore used to be the only reliable fix)
- **Expanded:** shows all configured buttons (enter, arrows, ctrl combos, model/effort popouts, custom buttons)

Button order and custom buttons are persisted in settings and configurable via the button config modal on the main screen. Model/effort buttons show popout panels with options (sends `/model <name>\r` to PTY).

### File viewer (`show_file` MCP tool)

Lets a Claude session push a file from the host filesystem into the browser without going through the upload path (this is host → browser; upload is browser → host).

- `McpShowFile` resolves the path, registers it in an in-memory `id -> absolute path` map (`pendingFiles`, capped at 50 entries, oldest evicted first), and broadcasts a `show_file` SSE event (`{id, name, caption, kind}`) to all connected browsers.
- The browser opens an overlay: images and video/audio play inline (video/audio autoplay with controls); other kinds show a download link. `kind` and `Content-Type` are derived from the file extension (`FileMeta` in `Program.cs`).
- Image view supports wheel-zoom, double-click-to-zoom, and pointer-based pan/pinch-zoom (mouse + touch), clamped so panning can't push the image out of view.
- Dismissing the overlay (Esc, ×, or clicking outside) calls `DELETE /api/file/{id}` to drop the id→path mapping — the source file on disk is never touched or moved.

### Clipboard push (`copy_text` MCP tool)

Lets a Claude session put text on the clipboard of the device viewing WebTerm (host → browser, like `show_file`).

- `McpCopyText` validates the text (≤ 1 MB), errors if no SSE client is connected, and broadcasts a `copy_text` SSE event (`{text, label}`) to all browsers. Nothing is stored server-side.
- The browser (`receiveCopyText` in `app.js`) first attempts a silent `navigator.clipboard.writeText`. Browsers gate this: Chrome/Edge require the document to be focused, Safari/iOS require a user gesture. On success a toast confirms the copy.
- If the silent write fails, a `copy-overlay` shows the text in a read-only textarea with a **Copy** button; the click supplies the user activation so `writeText` succeeds everywhere. If even that is blocked, it falls back to `execCommand('copy')`, and finally tells the user to select the text manually.

## Auth

Global middleware enforces HTTP Basic auth. Credentials are set on first run (console prompt), encrypted with DPAPI, stored in `webterm-settings.json`. All requests including `/ws` and static files require the `Authorization: Basic ...` header. Exception: `/mcp` is exempt from Basic auth — it uses its own DPAPI-encrypted API key validated via `?token=` query param.

### MCP Server

WebTerm exposes an MCP (Model Context Protocol) server at `POST /mcp?token=<key>`. JSON-RPC 2.0, Streamable HTTP transport. Tools:
- `open_tab(kind, projectId?, label?, command?)` — creates session, launches PTY, broadcasts SSE event. If `projectId` is omitted, defaults to the calling Claude session's own project (resolved via `X-Webterm-Sid` header). `command` is handed to the process at spawn time, never typed into the PTY (typing it after a delay raced startup and arrived mangled):
  - `kind=claude`: the initial prompt. `claude.exe` (found on PATH; for an npm install, `node.exe` + the package's `cli.js` behind the `claude.cmd` shim) is spawned **directly**, not via `cmd.exe /K`, because cmd re-parses `% ^ & "`, can't carry newlines and caps the line at 8191 chars. The tab therefore closes when Claude exits. Porta.Pty's built-in quoting mishandles backslash-before-quote, so the line is built with `VerbatimCommandLine = true` and `QuoteWindowsArg` (MSVC rules). A prompt starting with `-` gets a leading space so it isn't parsed as an option.
  - `kind=powershell`: passed as `-NoExit -EncodedCommand <base64 UTF-16LE>` (no escaping needed). The browser's "Add MCP" tab uses the same path via `defaultCommand`.
  - `kind=claude-resume`: rejected. Also rejected if the encoded command would exceed the Windows command-line limit (~32K).
- `close_tab(sid)` — disposes session, broadcasts SSE event
- `list_tabs()` — returns all active sessions with metadata
- `restart()` — rebuilds and restarts the WebTerm server, killing all sessions
- `show_file(path, caption?)` — displays a host file (by absolute path) in the browser's file viewer overlay; see below
- `copy_text(text, label?)` — puts `text` on the clipboard of every connected browser's device; see below

**Caller context (`X-Webterm-Sid`)**: the `claude mcp add` command generated by `POST /api/mcp-setup` includes `--header 'X-Webterm-Sid: ${WEBTERM_SID:-}'`. PowerShell expands `${WEBTERM_SID:-}` per-session at runtime, so each MCP call arrives with the caller's tab sid. The server uses it to inherit the caller's project when `open_tab` omits `projectId`.

Setup: click "MCP" button on main screen → calls `POST /api/mcp-setup` (generates DPAPI-encrypted key, installs Claude hooks) → opens PowerShell tab with `claude mcp add` command. Key stored as `mcpKeyProtected` in settings.

### Tab attention notifications

Claude Code hooks notify WebTerm when Claude needs approval or finishes work. Setup is automatic via `POST /api/mcp-setup`.

**Server-side flow:**
1. `POST /api/mcp-setup` writes `~/.claude/hooks/webterm-notify.ps1` and registers `PermissionRequest` + `Stop` hooks in `~/.claude/settings.json`
2. Claude sessions launch with `WEBTERM_SID` and `WEBTERM_NOTIFY_TOKEN` env vars
3. Hook fires → calls `POST /api/notify?token=<key>` with `{sid, event}`
4. Server maps events to SSE: `permission_request` → `tab_attention`, `stop` → `tab_idle`

**Client-side behavior:**
- Tab bar shows attention indicator (CSS classes `attention-permission`, `attention-idle`)
- Title flashes ("⚠ Approval needed" or "✓ Claude finished") when tab not visible
- Browser push notification via Notifications API (requests permission on load)
- Attention clears when user switches to the tab

## Platform

- Targets `net10.0`, nullable + implicit usings enabled.
- NuGet deps: `Porta.Pty` 1.0.7, `System.Security.Cryptography.ProtectedData` 10.0.8.
- The hardcoded `powershell.exe` path makes the current configuration Windows-only.
