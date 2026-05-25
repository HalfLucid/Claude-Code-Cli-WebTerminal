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
    const { term, fitAddon } = TerminalManager.createTerminal(containerEl);

    const tab = {
      id, sid, kind, projectId,
      label: label || kind,
      color: color || '#1e6f1e',
      defaultCommand: defaultCommand || null,
      term, fitAddon, containerEl,
      ws: null,
      reconnectDelay: 500,
      reconnectTimer: null
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
    const { term, fitAddon } = TerminalManager.createTerminal(containerEl);

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
      restored: true
    };

    tabs.push(tab);
    Connection.connect(tab);
    return tab;
  }

  function switchTo(index){
    if(index < 0 || index >= tabs.length) return;
    if(activeIndex >= 0 && activeIndex < tabs.length){
      tabs[activeIndex].containerEl.classList.remove('active');
    }
    activeIndex = index;
    const tab = tabs[activeIndex];
    tab.containerEl.classList.add('active');

    document.body.classList.toggle('has-tabs', tabs.length > 0);
    hideMainScreen();
    renderTabBar();

    setTimeout(() => {
      try{ tab.fitAddon.fit(); }catch{}
      Connection.sendSize(tab);
      document.getElementById('ta').focus();
    }, 50);

    saveTabs();
  }

  function closeTab(index){
    if(index < 0 || index >= tabs.length) return;
    if(!confirm('Close "' + tabs[index].label + '" session?')) return;

    const tab = tabs[index];
    fetch('/api/sessions/' + encodeURIComponent(tab.sid), { method: 'DELETE' }).catch(() => {});
    Connection.disconnect(tab);
    TerminalManager.destroyTerminal(tab.term, tab.containerEl);
    tabs.splice(index, 1);

    if(tabs.length === 0){
      activeIndex = -1;
      document.body.classList.remove('has-tabs');
      showMainScreen();
    } else {
      const newIndex = index >= tabs.length ? tabs.length - 1 : index;
      activeIndex = -1;
      switchTo(newIndex);
    }
    renderTabBar();
    saveTabs();
  }

  function removeStaleTab(tab){
    const index = tabs.indexOf(tab);
    if(index < 0) return;
    fetch('/api/sessions/' + encodeURIComponent(tab.sid), { method: 'DELETE' }).catch(() => {});
    Connection.disconnect(tab);
    TerminalManager.destroyTerminal(tab.term, tab.containerEl);
    tabs.splice(index, 1);

    if(tabs.length === 0){
      activeIndex = -1;
      document.body.classList.remove('has-tabs');
      showMainScreen();
    } else {
      const newIndex = index >= tabs.length ? tabs.length - 1 : index;
      activeIndex = -1;
      switchTo(newIndex);
    }
    renderTabBar();
    saveTabs();
  }

  function renderTabBar(){
    const tabList = document.getElementById('tab-list');
    tabList.innerHTML = '';

    tabs.forEach((tab, i) => {
      const el = document.createElement('div');
      el.className = 'tab' + (i === activeIndex ? ' active' : '');
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
    const { term, fitAddon } = TerminalManager.createTerminal(containerEl);

    const tab = {
      id, sid, kind, projectId,
      label: label || kind,
      color: color || '#1e6f1e',
      defaultCommand: null,
      term, fitAddon, containerEl,
      ws: null,
      reconnectDelay: 500,
      reconnectTimer: null,
      restored: true
    };

    tabs.push(tab);
    Connection.connect(tab);
    saveTabs();
    return tab;
  }

  return {
    createTab, createExternalTab, restoreTab, switchTo, closeTab, removeStaleTab,
    renderTabBar, getActive, getAll,
    showMainScreen, hideMainScreen,
    loadSavedTabs, getSavedActiveIndex, migrateOldSid,
    saveTabs
  };
})();
