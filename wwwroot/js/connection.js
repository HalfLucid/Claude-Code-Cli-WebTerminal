window.Connection = (function(){
  const enc = new TextEncoder();
  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';

  function connect(tab){
    if(tab.ws && (tab.ws.readyState === 0 || tab.ws.readyState === 1)) return;
    tab.takenOver = false;
    const url = wsProto + location.host + '/ws?sid=' + encodeURIComponent(tab.sid);
    const sock = new WebSocket(url);
    tab.ws = sock;
    sock.binaryType = 'arraybuffer';

    sock.onopen = () => {
      tab.reconnectDelay = 500;
      if(TabManager.getActive() === tab){
        setBanner('');
        sendSize(tab);
      }
      // Queued by hardRefresh. Sent on the new socket, so the server handles it
      // after the ring-buffer replay and the repaint lands on top of it.
      if(tab.pendingJiggle){ tab.pendingJiggle = false; jiggle(tab); }
    };

    sock.onmessage = e => {
      if(typeof e.data === 'string'){
        try{
          const m = JSON.parse(e.data);
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

  function sendSize(tab){
    if(!tab) return;
    applyViewportSize();
    try{ tab.fitAddon.fit(); }catch{ return; }
    const c = tab.term.cols, r = tab.term.rows;
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
      try{ tab.fitAddon.fit(); }catch{ return; }
      requestAnimationFrame(() => {
        try{ tab.fitAddon.fit(); }catch{ return; }
        const c = tab.term.cols, r = tab.term.rows;
        try{ tab.term.refresh(0, r - 1); }catch{}
        tab.term.scrollToBottom();
        sendJson(tab, {cols:c, rows:r});
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

  function applyViewportSize(){
    const vv = window.visualViewport;
    if(!vv) return;
    const offset = document.body.classList.contains('has-tabs') ? 37 : 0;
    const h = (vv.height - offset) + 'px';
    const terminals = document.getElementById('terminals');
    const ta = document.getElementById('ta');
    terminals.style.height = h;
    ta.style.height = h;
  }

  return { connect, send, sendJson, sendSize, forceResize, hardRefresh, disconnect, reconnectIfNeeded, refreshTakeover, setBanner, applyViewportSize };
})();
