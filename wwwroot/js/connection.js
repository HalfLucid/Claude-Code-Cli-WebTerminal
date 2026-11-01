window.Connection = (function(){
  const enc = new TextEncoder();
  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';

  function connect(tab){
    if(tab.ws && (tab.ws.readyState === 0 || tab.ws.readyState === 1)) return;
    tab.takenOver = false;
    tab.replaying = false;                    // a socket dropped mid-replay never sends replayEnd
    let url = wsProto + location.host + '/ws?sid=' + encodeURIComponent(tab.sid);
    // Our grid size lets the server refuse the resume (and send a full replay)
    // if the PTY was resized meanwhile; see Session.SizeUnchangedSince.
    if(tab.recvOffset != null) url += '&from=' + tab.recvOffset + '&cols=' + tab.term.cols + '&rows=' + tab.term.rows;
    const sock = new WebSocket(url);
    tab.ws = sock;
    sock.binaryType = 'arraybuffer';

    sock.onopen = () => {
      tab.reconnectDelay = 500;
      if(TabManager.getActive() === tab) setBanner('');
      // Size is sent on replayEnd, once the replay has been laid out at the
      // sizes it was recorded at.
    };

    sock.onmessage = e => {
      if(tab.ws !== sock) return;             // late frame from a socket we already dropped
      if(typeof e.data === 'string'){
        try{
          const m = JSON.parse(e.data);
          // Server announces where its replay starts. If that isn't where our
          // screen left off, the replay would stack on top of what's already
          // drawn (duplicated scrollback, garbled redraws), so start clean.
          if(typeof m.offset === 'number'){
            if(m.offset !== tab.recvOffset){ try{ tab.term.reset(); }catch{} }
            tab.recvOffset = m.offset;
            // Replay at the PTY size the bytes were produced at, switching in
            // step with the {size} markers; our own size returns at replayEnd.
            tab.replaying = true;
            if(m.cols && m.rows) queueResize(tab, m.cols, m.rows);
            return;
          }
          if(m.size){ queueResize(tab, m.size.cols, m.size.rows); return; }
          if(m.replayEnd){ endReplay(tab, sock); return; }
          if(m.ptyExited){
            disconnect(tab);
            TabManager.removeStaleTab(tab);
            return;
          }
          if(m.choose){
            if(tab.restored){
              disconnect(tab);
              TabManager.removeStaleTab(tab);
              return;
            }
            const msg = JSON.stringify({launch: tab.kind, projectId: tab.projectId || undefined, defaultCommand: tab.defaultCommand || undefined, label: tab.label || undefined, color: tab.color || undefined});
            tab.ws.send(msg);
            tab.defaultCommand = null;
          }
        }catch{}
        return;
      }
      if(tab.restored) tab.restored = false;
      tab.reconnectFails = 0;
      if(tab.recvOffset != null) tab.recvOffset += e.data.byteLength;
      const buf = tab.term.buffer.active;
      const wasNearBottom = (buf.baseY - buf.viewportY) <= 1;
      tab.term.write(new Uint8Array(e.data), () => { if(wasNearBottom) tab.term.scrollToBottom(); });
    };

    sock.onclose = (ev) => {
      if(tab.ws !== sock) return;             // superseded locally (same-device reconnect) — ignore stale socket
      if(ev.reason === 'replaced'){           // server kicked us: another client took this sid
        showTakeover(tab);
        return;                               // do NOT reconnect — breaks the ping-pong
      }
      scheduleReconnect(tab);
    };
    sock.onerror = () => { try { sock.close(); } catch{} };
  }

  // term.resize() applies immediately but term.write() is queued, so a resize
  // must ride the write queue to land between the right bytes.
  function queueResize(tab, cols, rows){
    tab.term.write('', () => {
      try{ if(cols !== tab.term.cols || rows !== tab.term.rows) tab.term.resize(cols, rows); }catch{}
    });
  }

  function endReplay(tab, sock){
    // Tell the server our size now, synchronously, so it precedes any launch
    // message for a fresh session. Measured without touching xterm, which is
    // still working through the replay at recorded sizes.
    if(TabManager.getActive() === tab){
      applyViewportSize();
      let d = null;
      try{ d = tab.fitAddon.proposeDimensions(); }catch{}
      if(d && d.cols && d.rows){
        tab.sentCols = d.cols; tab.sentRows = d.rows;
        sendJson(tab, {cols: d.cols, rows: d.rows});
      }
    }
    tab.term.write('', () => {
      // The socket may have dropped and a new replay started while this one
      // drained; that replay owns tab.replaying now.
      if(tab.ws !== sock) return;
      tab.replaying = false;
      // forceResize fits it (and runs a pending repaint) on tab switch.
      if(TabManager.getActive() !== tab) return;
      sendSize(tab);
      // Queued by hardRefresh: repaint on top of the finished replay.
      runPendingJiggle(tab);
    });
  }

  function runPendingJiggle(tab){
    if(tab.pendingJiggle){ tab.pendingJiggle = false; jiggle(tab); }
  }

  function showTakeover(tab){
    tab.takenOver = true;
    if(tab.reconnectTimer){ clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    if(TabManager.getActive() === tab){
      currentTakeoverTab = tab;
      document.getElementById('takeover-overlay').classList.add('show');
    }
  }

  function scheduleReconnect(tab){
    if(tab.reconnectTimer) return;
    tab.reconnectFails = (tab.reconnectFails || 0) + 1;
    if(tab.reconnectFails >= 5){
      fetch('/api/sessions').then(r => {
        if(r.status === 401){ location.reload(); return null; }
        return r.json();
      }).then(list => {
        if(!list) return;
        if(!list.find(s => s.sid === tab.sid)){
          disconnect(tab);
          TabManager.removeStaleTab(tab);
        }
      }).catch(() => {});
    }
    if(TabManager.getActive() === tab) setBanner('Disconnected — reconnecting…');
    tab.reconnectTimer = setTimeout(() => {
      tab.reconnectTimer = null;
      connect(tab);
    }, tab.reconnectDelay);
    tab.reconnectDelay = Math.min(tab.reconnectDelay * 2, 8000);
  }

  function send(tab, s){
    if(tab && tab.ws && tab.ws.readyState === 1) tab.ws.send(enc.encode(s));
  }

  function sendJson(tab, obj){
    if(tab && tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify(obj));
  }

  // Viewport resize events fire constantly on mobile (keyboard animation, URL
  // bar). Only touch the PTY, and only yank the view to the bottom, when the
  // grid actually changed — every real resize makes Claude reprint.
  function sendSize(tab, force){
    if(!tab || tab.replaying) return;         // endReplay sizes it once the replay is laid out
    applyViewportSize();
    try{ tab.fitAddon.fit(); }catch{ return; }
    const c = tab.term.cols, r = tab.term.rows;
    if(!force && c === tab.sentCols && r === tab.sentRows) return;
    tab.sentCols = c; tab.sentRows = r;
    tab.term.scrollToBottom();
    sendJson(tab, {cols:c, rows:r});
  }

  // Full recompute for tab switch / wake. Char-size + renderer caches drift
  // while a container is display:none; a plain fit() that lands on the same
  // cols/rows is a no-op and leaves the stale layout in place (the bug that
  // un/re-maximizing fixes). Re-measure, fit across two frames, then repaint.
  function forceResize(tab){
    if(!tab) return;
    remeasure(tab);
    requestAnimationFrame(() => {
      if(tab.replaying) return;               // endReplay fits it when the replay is done
      try{ tab.fitAddon.fit(); }catch{ return; }
      requestAnimationFrame(() => {
        if(tab.replaying) return;
        try{ tab.fitAddon.fit(); }catch{ return; }
        const c = tab.term.cols, r = tab.term.rows;
        try{ tab.term.refresh(0, r - 1); }catch{}
        tab.term.scrollToBottom();
        tab.sentCols = c; tab.sentRows = r;
        sendJson(tab, {cols:c, rows:r});
        runPendingJiggle(tab);                // reload whose replay finished while hidden
      });
    });
  }

  // xterm pauses rendering via IntersectionObserver while its container is
  // hidden. If the observer misses the unhide, output keeps arriving but never
  // paints (looks like dead input) until a real window resize fires it.
  function remeasure(tab){
    applyViewportSize();
    const core = tab.term._core;
    try{ core && core._charSizeService && core._charSizeService.measure(); }catch{}
    try{ const rs = core && core._renderService; if(rs && rs._isPaused) rs._isPaused = false; }catch{}
  }

  // ConPTY only repaints (and Claude only re-renders) on a real size change;
  // resizing to the current size is a no-op. That's why maximize/restore fixes
  // a garbled screen. Nudge one column narrower, then back. The gap lets the
  // app observe the intermediate size instead of coalescing it away.
  function jiggle(tab){
    const r = tab.term.rows;
    sendJson(tab, {cols: Math.max(tab.term.cols - 1, 2), rows: r});
    setTimeout(() => sendJson(tab, {cols: tab.term.cols, rows: tab.term.rows}), 150);
  }

  // Reload button: rebuild everything from scratch. Wipes xterm state, opens a
  // fresh socket (replaces a half-open one after sleep), replays the server
  // ring buffer, then forces the app to repaint the screen over the replay.
  function hardRefresh(tab){
    if(!tab) return;
    if(window.resetInput) window.resetInput();
    disconnect(tab);
    tab.takenOver = false;
    refreshTakeover(tab);
    remeasure(tab);
    try{ tab.term.reset(); }catch{}
    tab.recvOffset = null;                    // screen wiped: ask for the full replay
    try{ tab.fitAddon.fit(); }catch{}
    tab.pendingJiggle = true;
    tab.reconnectDelay = 500;
    connect(tab);
  }

  function disconnect(tab){
    if(tab.reconnectTimer){ clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    if(tab.ws){
      tab.ws.onclose = null;
      tab.ws.onerror = null;
      try{ tab.ws.close(); }catch{}
      tab.ws = null;
    }
  }

  function reconnectIfNeeded(tab){
    if(tab.takenOver) return;   // user must explicitly reconnect via takeover popup
    if(!tab.ws || tab.ws.readyState > 1){
      if(tab.reconnectTimer){ clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
      tab.reconnectDelay = 500;
      connect(tab);
    }
  }

  let currentTakeoverTab = null;
  const overlay = document.getElementById('takeover-overlay');
  function hideTakeover(){ overlay.classList.remove('show'); currentTakeoverTab = null; }
  document.getElementById('takeover-reconnect').addEventListener('click', () => {
    const tab = currentTakeoverTab;
    hideTakeover();
    if(!tab) return;
    tab.takenOver = false;
    tab.reconnectDelay = 500;
    connect(tab);                 // deliberate takeover-back (one-shot, not a loop)
  });
  document.getElementById('takeover-menu').addEventListener('click', () => {
    hideTakeover();
    TabManager.showMainScreen();
  });

  // Called by TabManager on tab switch: show/hide overlay for the now-active tab.
  function refreshTakeover(tab){
    if(tab && tab.takenOver){
      currentTakeoverTab = tab;
      overlay.classList.add('show');
    } else {
      hideTakeover();
    }
  }

  const banner = document.getElementById('banner');
  function setBanner(msg){
    if(!msg){ banner.style.display='none'; banner.textContent=''; }
    else { banner.textContent = msg; banner.style.display='block'; }
  }

  // Keyboard must never change the row count (see CLAUDE.md "Resize
  // discipline"): keep the CSS height and slide up by the covered amount.
  function applyViewportSize(){
    const vv = window.visualViewport;
    const terminals = document.getElementById('terminals');
    terminals.style.height = '';
    if(!vv){ terminals.style.transform = ''; return; }
    let covered = document.documentElement.clientHeight - (vv.offsetTop + vv.height);
    if(Math.abs(vv.scale - 1) > 0.01) covered = 0;   // pinch-zoom, not a keyboard
    covered = Math.max(0, Math.round(covered));
    let shift = covered;
    if(covered){
      const bottom = contentBottom(terminals);
      if(bottom != null) shift = Math.min(covered, Math.max(0, Math.ceil(bottom - (terminals.offsetHeight - covered))));
    }
    terminals.style.transform = shift ? 'translateY(' + (-shift) + 'px)' : '';
    const offset = document.body.classList.contains('has-tabs') ? 37 : 0;
    document.getElementById('ta').style.height = (vv.height - offset) + 'px';
  }

  // Bottom edge (px from the top of #terminals) of the lowest visible row that
  // holds text or the cursor, in the active tab. null if it can't be measured.
  function contentBottom(terminals){
    const tab = TabManager.getActive();
    if(!tab || !tab.term) return null;
    const term = tab.term, buf = term.buffer.active;
    const screen = tab.containerEl.querySelector('.xterm-screen');
    if(!screen) return null;
    let cellH = 0;
    try{ cellH = term._core._renderService.dimensions.css.cell.height; }catch{}
    if(!cellH) return null;
    let last = buf.cursorY + buf.baseY - buf.viewportY;   // cursor row within the viewport
    for(let i = term.rows - 1; i > last; i--){
      const line = buf.getLine(buf.viewportY + i);
      if(line && line.translateToString(true).trim()){ last = i; break; }
    }
    if(last < 0 || last >= term.rows) last = term.rows - 1;   // cursor scrolled out of view
    // Both rects carry the same transform, so their difference is unaffected.
    const top = screen.getBoundingClientRect().top - terminals.getBoundingClientRect().top;
    return top + (last + 1) * cellH;
  }

  let slideQueued = false;
  function scheduleSlide(){
    if(slideQueued || !keyboardCovers()) return;
    slideQueued = true;
    requestAnimationFrame(() => { slideQueued = false; applyViewportSize(); });
  }
  function keyboardCovers(){
    const vv = window.visualViewport;
    return !!vv && document.documentElement.clientHeight - (vv.offsetTop + vv.height) > 1;
  }

  return { connect, send, sendJson, sendSize, forceResize, hardRefresh, disconnect, reconnectIfNeeded, refreshTakeover, setBanner, applyViewportSize, scheduleSlide };
})();
