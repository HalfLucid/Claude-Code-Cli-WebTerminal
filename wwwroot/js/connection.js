window.Connection = (function(){
  const enc = new TextEncoder();
  const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';

  function connect(tab){
    if(tab.ws && (tab.ws.readyState === 0 || tab.ws.readyState === 1)) return;
    const url = wsProto + location.host + '/ws?sid=' + encodeURIComponent(tab.sid);
    tab.ws = new WebSocket(url);
    tab.ws.binaryType = 'arraybuffer';

    tab.ws.onopen = () => {
      tab.reconnectDelay = 500;
      if(TabManager.getActive() === tab){
        setBanner('');
        sendSize(tab);
      }
    };

    tab.ws.onmessage = e => {
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
      const wasNearBottom = (buf.baseY - buf.viewportY) <= 3;
      tab.term.write(new Uint8Array(e.data), () => { if(wasNearBottom) tab.term.scrollToBottom(); });
    };

    tab.ws.onclose = () => { scheduleReconnect(tab); };
    tab.ws.onerror = () => { try { tab.ws.close(); } catch{} };
  }

  function scheduleReconnect(tab){
    if(tab.reconnectTimer) return;
    tab.reconnectFails = (tab.reconnectFails || 0) + 1;
    if(tab.reconnectFails >= 5){
      fetch('/api/sessions').then(r => r.json()).then(list => {
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
    if(!tab.ws || tab.ws.readyState > 1){
      if(tab.reconnectTimer){ clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
      tab.reconnectDelay = 500;
      connect(tab);
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

  return { connect, send, sendJson, sendSize, disconnect, reconnectIfNeeded, setBanner, applyViewportSize };
})();
