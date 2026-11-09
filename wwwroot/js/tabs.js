window.TabManager = (function(){
  const tabs = [];
  let activeIndex = -1;

  function uuid(){
    if(crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8);
      return v.toString(16);
    });
  }

  function createTab(kind, projectId, label, color, defaultCommand){
    const id = uuid();
    const sid = uuid();
    const containerEl = TerminalManager.createContainer(id);
    const { term, fitAddon } = TerminalManager.createTerminal(containerEl, color || '#1e6f1e');

    const tab = {
      id, sid, kind, projectId,
      label: label || kind,
      color: color || '#1e6f1e',
      defaultCommand: defaultCommand || null,
      term, fitAddon, containerEl,
      ws: null,
      reconnectDelay: 500,
      reconnectTimer: null,
      // /api/sessions lists a session only once its launch is processed, so
      // until the server confirms it, absence from that list proves nothing.
      confirmed: false
    };

    tabs.push(tab);
    switchTo(tabs.length - 1);
    Connection.connect(tab);
    saveTabs();
    return tab;
  }

  function restoreTab(saved){
    const id = uuid();
    const containerEl = TerminalManager.createContainer(id);
    const { term, fitAddon } = TerminalManager.createTerminal(containerEl, saved.color || '#1e6f1e');

    const tab = {
      id,
      sid: saved.sid,
      kind: saved.kind,
      projectId: saved.projectId,
      label: saved.label || saved.kind,
      color: saved.color || '#1e6f1e',
      term, fitAddon, containerEl,
      ws: null,
      reconnectDelay: 500,
      reconnectTimer: null,
      restored: true,
      confirmed: true
    };

    tabs.push(tab);
    Connection.connect(tab);
    return tab;
  }

  function switchTo(index){
    if(index < 0 || index >= tabs.length) return;
    const prevTab = (activeIndex >= 0 && activeIndex < tabs.length) ? tabs[activeIndex] : null;
    if(prevTab){
      prevTab.containerEl.classList.remove('active');
    }
    activeIndex = index;
    const tab = tabs[activeIndex];
    tab.attention = null;
    tab.containerEl.classList.add('active');

    document.body.classList.toggle('has-tabs', tabs.length > 0);
    hideMainScreen();
    renderTabBar();
    Connection.refreshTakeover(tab);

    var ta = document.getElementById('ta');
    if(prevTab){
      prevTab.savedInput = ta.value;
      prevTab.savedSent = window.sentText;
    }
    ta.value = tab.savedInput || '';
    window.sentText = tab.savedSent || '';

    setTimeout(() => {
      Connection.forceResize(tab);
      ta.focus();
    }, 50);

    saveTabs();
  }

  async function closeTab(index){
    if(index < 0 || index >= tabs.length) return;
    // Hold the tab, not the index: the list can change while the dialog is up
    // (SSE tab_closed, reconcile), and removeTab ignores a tab already gone.
    const tab = tabs[index];
    if(!await Dialog.confirm('Close "' + tab.label + '" session?')) return;
    if(!tabs.includes(tab)) return;
    removeTab(tab, true);
  }

  // Drops the tab from this browser. The server session (and its PTY) is
  // killed only when deleteSession is set: the user closed it, or it is
  // certainly dead/junk. Anything inferred from a guess must leave it alone,
  // so it stays resumable from here or another device.
  function removeTab(tab, deleteSession){
    const index = tabs.indexOf(tab);
    if(index < 0) return;
    if(deleteSession) fetch('/api/sessions/' + encodeURIComponent(tab.sid), { method: 'DELETE' }).catch(() => {});
    Connection.disconnect(tab);
    TerminalManager.destroyTerminal(tab.term, tab.containerEl);
    tabs.splice(index, 1);
    const wasActive = index === activeIndex;

    if(tabs.length === 0){
      activeIndex = -1;
      document.body.classList.remove('has-tabs');
      showMainScreen();
    } else if(wasActive){
      const newIndex = index >= tabs.length ? tabs.length - 1 : index;
      // -1 so switchTo doesn't save the removed tab's #ta input onto another tab.
      activeIndex = -1;
      switchTo(newIndex);
    } else if(index < activeIndex){
      // A background tab went away (reconcile, SSE, reconnect failure): keep
      // the user where they are. Only the index shifts; no switch, so #ta and
      // the PTY size are left alone.
      activeIndex--;
    }
    renderTabBar();
    saveTabs();
  }

  function renderTabBar(){
    const tabList = document.getElementById('tab-list');
    tabList.innerHTML = '';

    tabs.forEach((tab, i) => {
      const el = document.createElement('div');
      var attCls = tab.attention === 'permission' ? ' attention-permission' : tab.attention === 'idle' ? ' attention-idle' : '';
      el.className = 'tab' + (i === activeIndex ? ' active' : '') + attCls;
      el.style.borderColor = tab.color;
      if(i === activeIndex){
        el.style.background = tab.color + '33';
      }

      const labelSpan = document.createElement('span');
      labelSpan.className = 'tab-label';
      labelSpan.textContent = tab.label;
      el.appendChild(labelSpan);

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.addEventListener('click', e => { e.stopPropagation(); closeTab(i); });
      el.appendChild(closeBtn);

      el.addEventListener('click', () => switchTo(i));
      tabList.appendChild(el);
    });

    document.getElementById('tab-bar').style.display = tabs.length > 0 ? 'flex' : 'none';

    const tl = document.getElementById('tab-list');
    const scrollNeeded = tl.scrollWidth > tl.clientWidth;
    document.getElementById('tab-scroll-left').style.display = scrollNeeded ? '' : 'none';
    document.getElementById('tab-scroll-right').style.display = scrollNeeded ? '' : 'none';
  }

  document.getElementById('tab-scroll-left').addEventListener('click', () => {
    document.getElementById('tab-list').scrollLeft -= 120;
  });
  document.getElementById('tab-scroll-right').addEventListener('click', () => {
    document.getElementById('tab-list').scrollLeft += 120;
  });
  document.getElementById('tab-new').addEventListener('click', () => {
    showMainScreen();
  });

  function showMainScreen(){
    document.getElementById('main-screen').style.display = 'flex';
    document.getElementById('btn-back-to-session').style.display = tabs.length > 0 ? '' : 'none';
    if(typeof MainScreen !== 'undefined' && MainScreen.refresh) MainScreen.refresh();
  }

  function hideMainScreen(){
    document.getElementById('main-screen').style.display = 'none';
  }

  function getActive(){
    return (activeIndex >= 0 && activeIndex < tabs.length) ? tabs[activeIndex] : null;
  }

  function getAll(){ return tabs; }

  function saveTabs(){
    const data = tabs.map(t => ({
      sid: t.sid, kind: t.kind, projectId: t.projectId,
      label: t.label, color: t.color
    }));
    localStorage.setItem('webterm.tabs', JSON.stringify(data));
    localStorage.setItem('webterm.activeTab', String(activeIndex));
  }

  function loadSavedTabs(){
    const raw = localStorage.getItem('webterm.tabs');
    if(!raw) return [];
    try{ return JSON.parse(raw); }catch{ return []; }
  }

  function getSavedActiveIndex(){
    const v = localStorage.getItem('webterm.activeTab');
    return v ? parseInt(v, 10) : 0;
  }

  function migrateOldSid(){
    const oldSid = localStorage.getItem('webterm.sid');
    if(oldSid && !localStorage.getItem('webterm.tabs')){
      localStorage.removeItem('webterm.sid');
      return oldSid;
    }
    return null;
  }

  function createExternalTab(sid, kind, projectId, label, color){
    const id = uuid();
    const containerEl = TerminalManager.createContainer(id);
    const { term, fitAddon } = TerminalManager.createTerminal(containerEl, color || '#1e6f1e');

    const tab = {
      id, sid, kind, projectId,
      label: label || kind,
      color: color || '#1e6f1e',
      defaultCommand: null,
      term, fitAddon, containerEl,
      ws: null,
      reconnectDelay: 500,
      reconnectTimer: null,
      restored: true,
      confirmed: true                         // the server told us about it
    };

    tabs.push(tab);
    Connection.connect(tab);
    saveTabs();
    return tab;
  }

  function setAttention(sid, type){
    var tab = tabs.find(function(t){ return t.sid === sid; });
    if(!tab) return;
    tab.attention = type;
    renderTabBar();
  }

  function clearAttention(sid){
    var tab = tabs.find(function(t){ return t.sid === sid; });
    if(!tab) return;
    tab.attention = null;
    renderTabBar();
  }

  return {
    createTab, createExternalTab, restoreTab, switchTo, closeTab, removeTab,
    renderTabBar, getActive, getAll,
    showMainScreen, hideMainScreen,
    loadSavedTabs, getSavedActiveIndex, migrateOldSid,
    saveTabs, setAttention, clearAttention
  };
})();
