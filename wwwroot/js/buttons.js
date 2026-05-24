window.ButtonBar = (function(){
  const BUILTIN_BUTTONS = {
    'enter':       { label:'ENT',    fn:()=>{ sendActive('\r'); resetTa(); } },
    'up':          { label:'&#8593;', fn:()=>{ sendActive('\x1b[A'); resetTa(); } },
    'down':        { label:'&#8595;', fn:()=>{ sendActive('\x1b[B'); resetTa(); } },
    'left':        { label:'&#8592;', fn:()=>{ sendActive('\x1b[D'); resetTa(); } },
    'right':       { label:'&#8594;', fn:()=>{ sendActive('\x1b[C'); resetTa(); } },
    'ctrl-c':      { label:'^C',     fn:()=>{ sendActive('\x03'); resetTa(); } },
    'esc':         { label:'Esc',    fn:()=>{ sendActive('\x1b'); resetTa(); } },
    'tab':         { label:'Tab',    fn:()=>{ sendActive('\t'); resetTa(); } },
    'shift-tab':   { label:'S-Tab',  fn:()=>{ sendActive('\x1b[Z'); resetTa(); } },
    'ctrl-b':      { label:'^B',     fn:()=>{ sendActive('\x02'); resetTa(); } },
    'ctrl-o':      { label:'^O',     fn:()=>{ sendActive('\x0f'); resetTa(); } },
    'clr':         { label:'CLR',    fn:()=>{ resetTa(); sendActive('/clear\r'); } },
    'cmpt':        { label:'CMPT',   fn:()=>{ resetTa(); sendActive('/compact\r'); } },
    'scroll-up':   { label:'SCR &#8593;',  fn:()=>{ var t = getActiveTerm(); if(t) t.scrollLines(-Math.max(1, t.rows - 2)); }, minimizedOnly:true },
    'scroll-down': { label:'SCR &#8595;',  fn:()=>{ var t = getActiveTerm(); if(t) t.scrollLines(Math.max(1, t.rows - 2)); }, minimizedOnly:true },
    'model':       { label:'Model',  fn:showModelPopout, isPopout:true },
    'effort':      { label:'Effort', fn:showEffortPopout, isPopout:true },
  };

  const MODEL_OPTIONS = [
    { label:'Opus',   command:'/model opus\r' },
    { label:'Sonnet', command:'/model sonnet\r' },
    { label:'Haiku',  command:'/model haiku\r' },
  ];
  const EFFORT_OPTIONS = [
    { label:'XHigh',  command:'/model xhigh\r' },
    { label:'High',   command:'/model high\r' },
    { label:'Medium', command:'/model medium\r' },
    { label:'Low',    command:'/model low\r' },
  ];

  function sendActive(s){
    var tab = TabManager.getActive();
    if(tab) Connection.send(tab, s);
  }
  function getActiveTerm(){
    var tab = TabManager.getActive();
    return tab ? tab.term : null;
  }
  function resetTa(){ var ta = document.getElementById('ta'); ta.value=''; window.sentLen=0; var t = getActiveTerm(); if(t) t.scrollToBottom(); }

  let expanded = false;
  let buttonOrder = null;
  let customButtons = [];
  let currentPage = 0;
  const PAGE_SIZE = 6;
  const blist = document.getElementById('blist');
  const btoggle = document.getElementById('btoggle');
  const popout = document.getElementById('popout');

  function makeBtn(cls, label, fn){
    const el = document.createElement('div');
    el.className = 'btn' + (cls ? (' ' + cls) : '');
    el.setAttribute('role', 'button');
    el.innerHTML = label;
    el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(el); });
    return el;
  }

  function getExpandedButtons(){
    const order = buttonOrder || Object.keys(BUILTIN_BUTTONS);
    const btns = [];
    for(const key of order){
      const b = BUILTIN_BUTTONS[key];
      if(b && !b.minimizedOnly){
        btns.push({ cls: b.isPopout ? 'nav' : '', label: b.label, fn: b.fn });
      } else if(!b){
        const custom = customButtons.find(c => c.id === key);
        if(custom){
          btns.push({ cls: '', label: custom.label, fn: () => { sendActive(custom.command); resetTa(); } });
        }
      }
    }
    return btns;
  }

  function render(){
    blist.innerHTML = '';
    if(!expanded){
      blist.style.display = 'flex';
      btoggle.innerHTML = '&#8595;';
      for(const key of Object.keys(BUILTIN_BUTTONS)){
        const b = BUILTIN_BUTTONS[key];
        if(b.minimizedOnly) blist.appendChild(makeBtn('', b.label, b.fn));
      }
      return;
    }
    blist.style.display = 'flex';
    btoggle.innerHTML = '&#8593;';
    const allBtns = getExpandedButtons();
    const totalPages = Math.max(1, Math.ceil(allBtns.length / PAGE_SIZE));
    if(currentPage >= totalPages) currentPage = totalPages - 1;
    const start = currentPage * PAGE_SIZE;
    const pageBtns = allBtns.slice(start, start + PAGE_SIZE);
    for(const b of pageBtns){
      blist.appendChild(makeBtn(b.cls, b.label, b.fn));
    }
    if(totalPages > 1){
      const pager = document.createElement('div');
      pager.className = 'pager';
      const leftBtn = document.createElement('div');
      leftBtn.className = 'btn pager-btn';
      leftBtn.innerHTML = '&#9664;';
      leftBtn.style.opacity = currentPage === 0 ? '0.25' : '';
      leftBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if(currentPage > 0){ currentPage--; render(); } });
      pager.appendChild(leftBtn);
      const rightBtn = document.createElement('div');
      rightBtn.className = 'btn pager-btn';
      rightBtn.innerHTML = '&#9654;';
      rightBtn.style.opacity = currentPage >= totalPages - 1 ? '0.25' : '';
      rightBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if(currentPage < totalPages - 1){ currentPage++; render(); } });
      pager.appendChild(rightBtn);
      blist.appendChild(pager);
    }
  }

  btoggle.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    expanded = !expanded;
    hidePopout();
    render();
  });

  function showPopout(options, anchorEl){
    popout.innerHTML = '';
    for(const opt of options){
      const btn = document.createElement('div');
      btn.className = 'popout-option';
      btn.textContent = opt.label;
      btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        sendActive(opt.command);
        resetTa();
        hidePopout();
      });
      popout.appendChild(btn);
    }
    const rect = anchorEl.getBoundingClientRect();
    popout.style.top = rect.top + 'px';
    popout.style.display = 'flex';
  }

  function hidePopout(){ popout.style.display = 'none'; }

  function showModelPopout(el){ showPopout(MODEL_OPTIONS, el); }
  function showEffortPopout(el){ showPopout(EFFORT_OPTIONS, el); }

  document.addEventListener('click', e => {
    if(!e.target.closest('.popout') && !e.target.closest('.btn')) hidePopout();
  });

  function setConfig(order, custom){
    buttonOrder = order;
    customButtons = custom || [];
    render();
  }

  function getBuiltinKeys(){ return Object.keys(BUILTIN_BUTTONS); }
  function getConfigurableKeys(){ return Object.keys(BUILTIN_BUTTONS).filter(k => !BUILTIN_BUTTONS[k].minimizedOnly); }
  function getBuiltinLabel(key){ return BUILTIN_BUTTONS[key]?.label || key; }
  function isBuiltin(key){ return !!BUILTIN_BUTTONS[key]; }
  function isMinimizedOnly(key){ return !!BUILTIN_BUTTONS[key]?.minimizedOnly; }

  return { render, setConfig, getBuiltinKeys, getConfigurableKeys, getBuiltinLabel, isBuiltin, isMinimizedOnly, sendActive, resetTa, expanded: () => expanded };
})();
