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
- `Map /ws?sid=<guid>` — WebSocket upgrade; looks up or creates a `Session` keyed by `sid`
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

- **Ring buffer**: `LinkedList<(long start, byte[] data)>` capped at `MaxBuffer = 256 KB`. `ReadLoop` reads from `Pty.ReaderStream`, appends to buffer, evicts oldest chunks, forwards via `TryWrite` to currently-attached channel.
- **Per-attachment send pump**: each `Attach` creates a fresh `Channel<byte[]>`; pump reads it and calls `ws.SendAsync`. Avoids concurrent `SendAsync` calls.
- **Replacement protocol**: second client with same sid closes old socket with `"replaced"`, replays ring buffer to new socket.
- **Metadata**: each session stores `Kind`, `Label`, `Color`, `ProjectId` — set during `Launch()` or from browser's launch JSON. Enables `GET /api/sessions` and MCP `list_tabs`.
- **Reaper**: background task scans every minute, `Dispose()`s sessions idle 30+ minutes. Broadcasts `tab_closed` SSE event on reap.
- **Launch**: `Launch(kind, projectId, settingsManager, sid)` — looks up project directory from settings. PowerShell sessions spawn via `powershell.exe`. Claude sessions spawn via `cmd.exe /K claude` (or `claude --resume`), with `WEBTERM_SID` and `WEBTERM_NOTIFY_TOKEN` environment variables injected for hook notifications.

### Client (wwwroot/)

**File structure:**
- `index.html` — HTML shell with tab bar, terminal container, main screen, button overlay, modals
- `css/style.css` — all styles
- `js/settings.js` — API calls to `/api/settings`, `/api/projects`, `/api/buttons`
- `js/terminal.js` — xterm.js instance factory (create/destroy per tab)
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
- `createExternalTab(sid, kind, projectId, label, color)` — creates tab for server-side session, sets `restored: true` so stale sessions auto-remove

**Main screen:** Full-page launcher (replaces old chooser modal). Shows PowerShell button + Claude project list from settings. Each project has "Open Claude" and "Resume Claude" buttons. Add/edit/delete projects via modal.

### Input bridge (browser ↔ PTY)

- **Binary frames** browser → server: written straight to `Pty.WriterStream`.
- **Text frames** browser → server: parsed as JSON; `{launch, projectId, label, color}` triggers `Session.Launch` (label/color stored as metadata), `{cols, rows}` triggers `Pty.Resize`.
- The hidden `#ta` textarea is the input source. It sends `\x7f` (DEL) once per previously-sent character before retransmitting the current value (see `rewrite()` in `app.js`). This is how mobile IME / autocorrect edits are reflected — preserve this contract if changing input handling.
- Special keys (Enter, Tab, Shift+Tab, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Insert, Esc, Ctrl+letter) are intercepted in `keydown` and translated to raw escape sequences. Arrow, Home, and End keys support Ctrl and Shift modifier variants.
- **Ctrl+C / Ctrl+V**: if text is selected in the terminal, Ctrl+C copies it (no SIGINT); Ctrl+V is a no-op in `keydown` and lets the native `paste` event on `#ta` fire instead, so `clipboardData` is read from the paste gesture itself (no clipboard-read permission chip). The right-click menu's Paste still calls `navigator.clipboard.readText()` since it has no paste gesture to hook. When nothing is selected, Ctrl+C sends raw ^C as usual. All pasted text is normalized to LF and wrapped in bracketed-paste (`\x1b[200~...\x1b[201~`) so a multi-line paste is treated as one block instead of submitting per line.
- **Right-click context menu**: xterm renders on canvas so the browser's native context menu has no Copy/Paste — a custom `.term-menu` overlay (in `terminal.js`) provides Copy and Paste items on right-click.
- **Image paste / drag-drop**: the PTY is a keystroke stream, so image bytes can't be sent down it, and HTML5 drag-drop never exposes a real filesystem path. Pasting or dropping a file therefore POSTs the bytes to `/api/upload`, and the returned absolute host path is typed into the PTY (bracketed paste, quoted if it contains spaces) — the same thing a native terminal does when you drag a file onto it. Claude Code detects the image path and attaches it. `dragover`/`drop` are `preventDefault`ed on `document`; without that the browser navigates away to the dropped image.
- **Upload directory**: `<project>\.webterm\uploads\` when the tab has a project, so the path is inside Claude's cwd and needs no Read approval. A self-ignoring `.webterm\.gitignore` (containing `*`) keeps the folder out of git. Tabs with no project (PowerShell) fall back to `%TEMP%\webterm-uploads\`. A background task sweeps files older than 24h, hourly.
- **Tab input persistence**: switching tabs saves and restores textarea value and `sentLen`, so in-progress input survives tab switches.

### Button overlay

Configurable button bar on right side. Two states:
- **Collapsed:** shows only the `minimizedOnly` buttons — scroll-up, scroll-down, and reload (forces a PTY resize via `Connection.forceResize`, useful when the terminal renders stale after a tab switch)
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
- `open_tab(kind, projectId?, label?, command?)` — creates session, launches PTY, broadcasts SSE event. If `projectId` is omitted, defaults to the calling Claude session's own project (resolved via `X-Webterm-Sid` header).
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
