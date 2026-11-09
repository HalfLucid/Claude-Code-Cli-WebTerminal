window.Connection = (function(){
  const enc = new TextEncoder();
  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';

  function connect(tab){
    if(tab.ws && (tab.ws.readyState === 0 || tab.ws.readyState === 1)) return;
    stopHeartbeat(tab);
    clearConnectTimer(tab);
    tab.takenOver = false;
    tab.replaying = false;                    // a socket dropped mid-replay never sends replayEnd
    let url = wsProto + location.host + '/ws?sid=' + encodeURIComponent(tab.sid);
    // Our grid size lets the server refuse the resume (and send a full replay)
    // if the PTY was resized meanwhile; see Session.SizeUnchangedSince.
    if(tab.recvOffset != null) url += '&from=' + tab.recvOffset + '&cols=' + tab.term.cols + '&rows=' + tab.term.rows;
    const sock = new WebSocket(url);
    tab.ws = sock;
    sock.binaryType = 'arraybuffer';
    // After a network switch a socket can sit in CONNECTING for minutes, and
    // the heartbeat only covers open sockets. Give up and retry instead.
    tab.connectTimer = setTimeout(() => {
      tab.connectTimer = null;
      if(tab.ws === sock && sock.readyState === 0) declareDead(tab, sock);
    }, CONNECT_TIMEOUT);

    sock.onopen = () => {
      clearConnectTimer(tab);
      tab.reconnectDelay = 500;
      if(TabManager.getActive() === tab) setBanner('');
      // Size is sent on replayEnd, once the replay has been laid out at the
      // sizes it was recorded at.
      startHeartbeat(tab, sock);
    };

    sock.onmessage = e => {
      if(tab.ws !== sock) return;             // late frame from a socket we already dropped
      tab.lastRecv = Date.now();              // any frame (replay included) proves the socket alive
      if(typeof e.data === 'string'){
        try{
          const m = JSON.parse(e.data);
          if(m.pong !== undefined) return;
          // Server announces where its replay starts. If that isn't where our
          // screen left off, the replay would stack on top of what's already
          // drawn (duplicated scrollback, garbled redraws), so start clean.
          if(typeof m.offset === 'number'){
            // The server's first frame on attach: this reconnect worked, even
            // if an idle session sends no output to reset the count below.
            tab.reconnectFails = 0;
            // Queued ahead of the size below and the replay bytes.
            if(m.offset !== tab.recvOffset) queueReset(tab);
            tab.recvOffset = m.offset;
            // A size is only recorded once the PTY launched, so the server
            // has this session and will list it.
            if(m.cols && m.rows) tab.confirmed = true;
            // Replay at the PTY size the bytes were produced at, switching in
            // step with the {size} markers; our own size returns at replayEnd.
            tab.replaying = true;
            tab.replayTruncated = !!m.truncated;
            tab.replayCols = m.cols; tab.replayRows = m.rows;
            if(m.cols && m.rows) queueResize(tab, m.cols, m.rows);
            return;
          }
          if(m.size){
            tab.replayCols = m.size.cols; tab.replayRows = m.size.rows;
            queueResize(tab, m.size.cols, m.size.rows);
            return;
          }
          if(m.replayEnd){ endReplay(tab, sock); return; }
          if(m.ptyExited){
            // The process is gone; deleting just frees the dead session.
            disconnect(tab);
            TabManager.removeTab(tab, true);
            return;
          }
          if(m.choose){
            // {choose} means the server has no launched session for this sid.
            // Only a tab we created and haven't seen launched expects that;
            // for a restored or confirmed tab the session was lost (restart,
            // PTY exited and reaped before its notice got through) and our
            // socket just created an empty, unlaunched one in its place: junk.
            // Launching here would silently start a new shell in the old tab.
            if(tab.restored || tab.confirmed){
              disconnect(tab);
              TabManager.removeTab(tab, true);
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
      tab.confirmed = true;                   // PTY output: the session is launched
      tab.reconnectFails = 0;
      if(tab.recvOffset != null) tab.recvOffset += e.data.byteLength;
      const buf = tab.term.buffer.active;
      const wasNearBottom = (buf.baseY - buf.viewportY) <= 1;
      tab.term.write(new Uint8Array(e.data), () => { if(wasNearBottom) tab.term.scrollToBottom(); });
    };

    sock.onclose = (ev) => {
      if(tab.ws !== sock) return;             // superseded locally (same-device reconnect) — ignore stale socket
      stopHeartbeat(tab);
      clearConnectTimer(tab);
      if(ev.reason === 'replaced'){           // server kicked us: another client took this sid
        showTakeover(tab);
        return;                               // do NOT reconnect — breaks the ping-pong
      }
      scheduleReconnect(tab);
    };
    sock.onerror = () => { try { sock.close(); } catch{} };
  }

  // Heartbeat. After a network switch or sleep the browser can keep a socket at
  // readyState 1 that the server dropped long ago, and JS can't see protocol
  // pings, so echo {ping}/{pong} and judge by when a frame last arrived.
  const PING_EVERY = 15000, DEAD_AFTER = 35000, PROBE_DEADLINE = 3000, CONNECT_TIMEOUT = 10000;

  function clearConnectTimer(tab){
    if(tab.connectTimer){ clearTimeout(tab.connectTimer); tab.connectTimer = null; }
  }

  function startHeartbeat(tab, sock){
    stopHeartbeat(tab);
    tab.lastRecv = Date.now();
    let lastBeat = Date.now();
    tab.hbTimer = setInterval(() => {
      if(tab.ws !== sock || sock.readyState !== 1){ stopHeartbeat(tab); return; }
      const now = Date.now();
      // Hidden pages run timers late (up to minutes), so a stale lastRecv there
      // may only mean our pings went out late. Judge on prompt ticks while
      // visible; wake re-checks via probe().
      const fair = !document.hidden && now - lastBeat < PING_EVERY + 10000;
      lastBeat = now;
      if(fair && now - tab.lastRecv > DEAD_AFTER){ declareDead(tab, sock); return; }
      sendJson(tab, {ping: now});
    }, PING_EVERY);
  }

  function stopHeartbeat(tab){
    if(tab.hbTimer){ clearInterval(tab.hbTimer); tab.hbTimer = null; }
    if(tab.probeTimer){ clearTimeout(tab.probeTimer); tab.probeTimer = null; }
  }

  // Ping now and give the socket a short deadline to show any frame.
  function probe(tab, sock){
    if(tab.probeTimer) return;
    const sent = Date.now();
    sendJson(tab, {ping: sent});
    tab.probeTimer = setTimeout(() => {
      tab.probeTimer = null;
      if(tab.ws !== sock || sock.readyState !== 1) return;
      if(document.hidden) return;             // late timer, not proof; the next wake probes again
      if(tab.lastRecv < sent) declareDead(tab, sock);
    }, PROBE_DEADLINE);
  }

  // A half-open socket may take minutes to fire onclose, so drop it now and
  // take the ordinary reconnect path. tab.recvOffset is untouched, so the new
  // socket resumes the replay where the screen left off.
  function declareDead(tab, sock){
    stopHeartbeat(tab);
    clearConnectTimer(tab);
    sock.onclose = null;
    sock.onerror = null;
    try{ sock.close(); }catch{}
    if(tab.ws === sock) tab.ws = null;
    scheduleReconnect(tab);
  }

  // term.resize() applies immediately but term.write() is queued, so a resize
  // must ride the write queue to land between the right bytes.
  function queueResize(tab, cols, rows){
    tab.term.write('', () => {
      try{ if(cols !== tab.term.cols || rows !== tab.term.rows) tab.term.resize(cols, rows); }catch{}
    });
  }

  // Same for reset(): bytes from the previous socket may still be queued, and
  // an immediate reset would let them parse on top of the fresh replay.
  function queueReset(tab, then){
    tab.term.write('', () => {
      try{ tab.term.reset(); }catch{}
      if(then) then();
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
        jiggleIfTruncated(tab, d.cols, d.rows);
      }
    } else {
      // Hidden: nothing was sent on this socket, and another device may have
      // resized the PTY meanwhile, so make the next forceResize send.
      tab.sentCols = tab.sentRows = null;
    }
    tab.term.write('', () => {
      // The socket may have dropped and a new replay started while this one
      // drained; that replay owns tab.replaying now.
      if(tab.ws !== sock) return;
      tab.replaying = false;
      // forceResize fits it (and runs a pending repaint) on tab switch.
      if(TabManager.getActive() !== tab) return;
      sendSize(tab);
      // Hidden at replayEnd but switched to during the drain.
      jiggleIfTruncated(tab, tab.term.cols, tab.term.rows);
      // Queued by hardRefresh: repaint on top of the finished replay.
      runPendingJiggle(tab);
    });
  }

  // A capped replay starts mid-stream, so rows ConPTY drew before the start
  // and never redrew (e.g. the top of the screen under a long spinner) are
  // blank. A real size change already makes ConPTY/Claude repaint; only at an
  // unchanged size is a jiggle needed, and adding one then would just print
  // the transcript twice.
  function jiggleIfTruncated(tab, cols, rows){
    if(!tab.replayTruncated) return;
    tab.replayTruncated = false;
    if(cols === tab.replayCols && rows === tab.replayRows) tab.pendingJiggle = true;
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
        // Only forget the tab locally: failing to reach the socket is not proof
        // the session is dead, and another device may still resume it. An
        // unconfirmed tab is expected to be absent, so keep retrying it.
        if(tab.confirmed && !list.find(s => s.sid === tab.sid)){
          disconnect(tab);
          TabManager.removeTab(tab, false);
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
        // Only a real change: a same-size resize just makes Claude reprint.
        if(c !== tab.sentCols || r !== tab.sentRows){
          tab.sentCols = c; tab.sentRows = r;
          sendJson(tab, {cols:c, rows:r});
        }
        jiggleIfTruncated(tab, c, r);         // capped replay that finished while hidden
        runPendingJiggle(tab);               // reload whose replay finished while hidden
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
    // Fit after the reset too, so a resize still queued from the old replay
    // can't land after it. Both run before the new socket's bytes.
    queueReset(tab, () => { try{ tab.fitAddon.fit(); }catch{} });
    tab.recvOffset = null;                    // screen wiped: ask for the full replay
    tab.pendingJiggle = true;
    tab.reconnectDelay = 500;
    connect(tab);
  }

  function disconnect(tab){
    if(tab.reconnectTimer){ clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
    stopHeartbeat(tab);
    clearConnectTimer(tab);
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
    } else if(tab.ws.readyState === 1 && Date.now() - (tab.lastRecv || 0) > 5000){
      // readyState 1 proves nothing after sleep or a network switch.
      probe(tab, tab.ws);
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
