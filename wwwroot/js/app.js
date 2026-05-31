// Orchestrator — wires up input, resize, visibility, and restores tabs

(async function(){
  const ta = document.getElementById('ta');
  let sentLen = 0;
  let composing = false;

  // Expose sentLen for ButtonBar.resetTa
  Object.defineProperty(window, 'sentLen', {
    get(){ return sentLen; },
    set(v){ sentLen = v; }
  });

  function sendActive(s){
    const tab = TabManager.getActive();
    if(tab) Connection.send(tab, s);
  }

  function rewrite(){
    const v = ta.value;
    const out = '\x7f'.repeat(sentLen) + v;
    if(out) sendActive(out);
    sentLen = v.length;
  }
  function resetTa(){ ta.value=''; sentLen=0; var t = TabManager.getActive(); if(t) t.term.scrollToBottom(); }

  ta.addEventListener('compositionstart', ()=>{ composing = true; });
  ta.addEventListener('compositionend', ()=>{ composing = false; rewrite(); });
  ta.addEventListener('input', ()=>{ if(!composing) rewrite(); });

  ta.addEventListener('keydown', e => {
    const k = e.key;
    if(k === 'Backspace'){ e.preventDefault(); sendActive('\x7f'); if(sentLen > 0) sentLen--; ta.value = ta.value.slice(0, -1); return; }
    if(k === 'Enter'){ e.preventDefault(); sendActive('\r'); resetTa(); return; }
    if(k === 'Tab'){ e.preventDefault(); sendActive(e.shiftKey ? '\x1b[Z' : '\t'); resetTa(); return; }
    if(k === 'Delete'){ e.preventDefault(); sendActive('\x1b[3~'); resetTa(); return; }
    if(k === 'PageUp'){ e.preventDefault(); sendActive('\x1b[5~'); resetTa(); return; }
    if(k === 'PageDown'){ e.preventDefault(); sendActive('\x1b[6~'); resetTa(); return; }
    if(k === 'Insert'){ e.preventDefault(); sendActive('\x1b[2~'); resetTa(); return; }
    if(k === 'ArrowUp'){ e.preventDefault(); sendActive(e.ctrlKey ? '\x1b[1;5A' : e.shiftKey ? '\x1b[1;2A' : '\x1b[A'); resetTa(); return; }
    if(k === 'ArrowDown'){ e.preventDefault(); sendActive(e.ctrlKey ? '\x1b[1;5B' : e.shiftKey ? '\x1b[1;2B' : '\x1b[B'); resetTa(); return; }
    if(k === 'ArrowRight'){ e.preventDefault(); sendActive(e.ctrlKey ? '\x1b[1;5C' : e.shiftKey ? '\x1b[1;2C' : '\x1b[C'); resetTa(); return; }
    if(k === 'ArrowLeft'){ e.preventDefault(); sendActive(e.ctrlKey ? '\x1b[1;5D' : e.shiftKey ? '\x1b[1;2D' : '\x1b[D'); resetTa(); return; }
    if(k === 'Home'){ e.preventDefault(); sendActive(e.ctrlKey ? '\x1b[1;5H' : e.shiftKey ? '\x1b[1;2H' : '\x1b[H'); resetTa(); return; }
    if(k === 'End'){ e.preventDefault(); sendActive(e.ctrlKey ? '\x1b[1;5F' : e.shiftKey ? '\x1b[1;2F' : '\x1b[F'); resetTa(); return; }
    if(k === 'Escape'){ e.preventDefault(); sendActive('\x1b'); resetTa(); return; }
    if(e.ctrlKey && k.length === 1){
      const c = k.toLowerCase().charCodeAt(0);
      if(c >= 97 && c <= 122){ e.preventDefault(); sendActive(String.fromCharCode(c - 96)); resetTa(); return; }
    }
  });

  document.addEventListener('click', e => {
    if(!e.target.closest('.btn') && !e.target.closest('.tab') && !e.target.closest('.tab-new-btn') &&
       !e.target.closest('.tab-scroll-btn') && !e.target.closest('#main-screen') &&
       !e.target.closest('.modal-overlay') && !e.target.closest('.popout')){
      ta.focus();
    }
  });

  // Resize
  let tmr = null;
  function scheduleResize(){ clearTimeout(tmr); tmr = setTimeout(() => {
    const tab = TabManager.getActive();
    if(tab) Connection.sendSize(tab);
  }, 100); }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', () => setTimeout(scheduleResize, 300));
  if(window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
  if(window.screen && screen.orientation) screen.orientation.addEventListener('change', () => setTimeout(scheduleResize, 300));

  // Notification permission
  if('Notification' in window && Notification.permission === 'default'){
    Notification.requestPermission();
  }

  // Title flash
  var titleFlashTimer = null;
  function startTitleFlash(msg){
    if(titleFlashTimer) clearInterval(titleFlashTimer);
    var flip = false;
    titleFlashTimer = setInterval(function(){
      document.title = flip ? 'WebTerm' : msg;
      flip = !flip;
    }, 1000);
  }
  function stopTitleFlash(){
    if(titleFlashTimer){
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
      document.title = 'WebTerm';
    }
  }

  // Visibility + online reconnect
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible'){
      stopTitleFlash();
      reconcileSessions();
      TabManager.getAll().forEach(tab => Connection.reconnectIfNeeded(tab));
    }
  });
  window.addEventListener('online', () => {
    reconcileSessions();
    TabManager.getAll().forEach(tab => Connection.reconnectIfNeeded(tab));
  });

  // Load settings and initialize
  const settings = await Settings.load();
  ButtonBar.setConfig(settings.buttons.order, settings.buttons.custom);

  // Reconcile local tabs against server session registry:
  // remove tabs whose session no longer exists, add sessions not yet shown.
  // Runs on startup and on every wake (visibility/online) + SSE reopen.
  async function reconcileSessions(){
    let serverSessions;
    try {
      const res = await fetch('/api/sessions');
      if(!res.ok) return;            // transient — keep current tabs
      serverSessions = await res.json();
    } catch { return; }              // network blip — keep current tabs

    const serverSids = new Set(serverSessions.map(s => s.sid));

    // Drop local tabs the server no longer has (capture refs first — indices shift).
    // Skip tabs born <8s ago: their session registers only once the WS connects,
    // so a freshly-created local tab may legitimately not be in /api/sessions yet.
    const now = Date.now();
    TabManager.getAll()
      .filter(t => !serverSids.has(t.sid) && !(t.bornAt && now - t.bornAt < 8000))
      .forEach(t => TabManager.removeStaleTab(t));

    // Add server sessions missing locally.
    const localSids = new Set(TabManager.getAll().map(t => t.sid));
    serverSessions.forEach(s => {
      if(!localSids.has(s.sid))
        TabManager.createExternalTab(s.sid, s.kind, s.projectId, s.label, s.color);
    });

    if(TabManager.getAll().length === 0) TabManager.showMainScreen();
    else if(!TabManager.getActive()) TabManager.switchTo(0);
    else TabManager.renderTabBar();
  }

  await reconcileSessions();
  if(TabManager.getAll().length === 0) TabManager.showMainScreen();

  // SSE: listen for server-pushed tab events (MCP, cross-device)
  (function initSSE(){
    var es = new EventSource('/api/events');
    var sawError = false;
    // EventSource auto-reconnects but events fired while it was down are lost.
    // On every reopen after an error, re-sync the full tab list.
    es.addEventListener('error', function(){ sawError = true; });
    es.addEventListener('open', function(){ if(sawError){ sawError = false; reconcileSessions(); } });
    es.addEventListener('tab_opened', function(e){
      var data = JSON.parse(e.data);
      if(TabManager.getAll().find(function(t){ return t.sid === data.sid; })) return;
      TabManager.createExternalTab(data.sid, data.kind, data.projectId, data.label, data.color);
      TabManager.renderTabBar();
    });
    es.addEventListener('tab_closed', function(e){
      var data = JSON.parse(e.data);
      var tab = TabManager.getAll().find(function(t){ return t.sid === data.sid; });
      if(tab) TabManager.removeStaleTab(tab);
    });
    es.addEventListener('tab_attention', function(e){
      var data = JSON.parse(e.data);
      TabManager.setAttention(data.sid, 'permission');
      var tab = TabManager.getAll().find(function(t){ return t.sid === data.sid; });
      var isActiveVisible = tab && TabManager.getActive() === tab && document.visibilityState === 'visible';
      if(!isActiveVisible){
        startTitleFlash('⚠ Approval needed');
        if('Notification' in window && Notification.permission === 'granted'){
          new Notification('Claude needs approval', {
            body: 'Tab: ' + (tab ? tab.label : 'Unknown'),
            tag: 'webterm-attention-' + data.sid
          });
        }
      }
    });
    es.addEventListener('tab_idle', function(e){
      var data = JSON.parse(e.data);
      TabManager.setAttention(data.sid, 'idle');
      var tab = TabManager.getAll().find(function(t){ return t.sid === data.sid; });
      var isActiveVisible = tab && TabManager.getActive() === tab && document.visibilityState === 'visible';
      if(!isActiveVisible){
        startTitleFlash('✓ Claude finished');
        if('Notification' in window && Notification.permission === 'granted'){
          new Notification('Claude finished', {
            body: 'Tab: ' + (tab ? tab.label : 'Unknown'),
            tag: 'webterm-idle-' + data.sid
          });
        }
      }
    });
  })();

  ta.focus();
})();
