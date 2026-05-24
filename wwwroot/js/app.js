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
  if(settings.buttons){
    ButtonBar.setConfig(settings.buttons.order, settings.buttons.custom);
  } else {
    ButtonBar.render();
  }

  // Restore tabs or show main screen
  const oldSid = TabManager.migrateOldSid();
  const savedTabs = TabManager.loadSavedTabs();

  if(savedTabs.length > 0){
    savedTabs.forEach(t => TabManager.restoreTab(t));
    const savedActive = TabManager.getSavedActiveIndex();
    const all = TabManager.getAll();
    TabManager.switchTo(Math.min(savedActive, all.length - 1));
  } else if(oldSid){
    // Migration from single-session
    const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
    const containerEl = TerminalManager.createContainer(id);
    const { term, fitAddon } = TerminalManager.createTerminal(containerEl);
    // Create a powershell-like tab from the old sid
    TabManager.getAll().push({
      id, sid: oldSid, kind: 'powershell', projectId: null,
      label: 'Session', color: '#1e6f1e',
      term, fitAddon, containerEl,
      ws: null, reconnectDelay: 500, reconnectTimer: null
    });
    TabManager.switchTo(0);
    Connection.connect(TabManager.getActive());
    TabManager.saveTabs();
  } else {
    TabManager.showMainScreen();
  }

  ta.focus();
})();
