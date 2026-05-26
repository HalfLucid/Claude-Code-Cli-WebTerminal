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
    if(k === 'Enter'){ e.preventDefault(); sendActive('\r'); resetTa(); return; }
    if(k === 'Tab'){ e.preventDefault(); sendActive('\t'); resetTa(); return; }
    if(k === 'ArrowUp'){ e.preventDefault(); sendActive('\x1b[A'); resetTa(); return; }
    if(k === 'ArrowDown'){ e.preventDefault(); sendActive('\x1b[B'); resetTa(); return; }
    if(k === 'ArrowRight'){ e.preventDefault(); sendActive('\x1b[C'); resetTa(); return; }
    if(k === 'ArrowLeft'){ e.preventDefault(); sendActive('\x1b[D'); resetTa(); return; }
    if(k === 'Home'){ e.preventDefault(); sendActive('\x1b[H'); resetTa(); return; }
    if(k === 'End'){ e.preventDefault(); sendActive('\x1b[F'); resetTa(); return; }
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

  // Visibility + online reconnect
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible'){
      TabManager.getAll().forEach(tab => Connection.reconnectIfNeeded(tab));
    }
  });
  window.addEventListener('online', () => {
    TabManager.getAll().forEach(tab => Connection.reconnectIfNeeded(tab));
  });

  // Load settings and initialize
  const settings = await Settings.load();
  ButtonBar.setConfig(settings.buttons.order, settings.buttons.custom);

  // Restore tabs from server session registry
  try {
    const res = await fetch('/api/sessions');
    const serverSessions = await res.json();
    if(serverSessions.length > 0){
      serverSessions.forEach(s => TabManager.createExternalTab(s.sid, s.kind, s.projectId, s.label, s.color));
      TabManager.switchTo(0);
    } else {
      TabManager.showMainScreen();
    }
  } catch {
    TabManager.showMainScreen();
  }

  // SSE: listen for server-pushed tab events (MCP, cross-device)
  (function initSSE(){
    var es = new EventSource('/api/events');
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
  })();

  ta.focus();
})();
