// Orchestrator — wires up input, resize, visibility, and restores tabs

(async function(){
  const ta = document.getElementById('ta');
  let sentLen = 0;
  let composing = false;

  // Keyboard (text entry) toggle. When off, taps never refocus #ta, so the
  // on-screen keyboard stays dismissed and you can thumb-scroll the full screen.
  window.inputEnabled = true;
  const kbtoggle = document.getElementById('kbtoggle');
  function setInputEnabled(on){
    window.inputEnabled = on;
    document.body.classList.toggle('input-off', !on);
    if(kbtoggle) kbtoggle.classList.toggle('off', !on);
    if(on){ ta.focus(); } else { ta.blur(); }
    scheduleResize();   // refit after keyboard show/hide changes viewport height
  }
  if(kbtoggle) kbtoggle.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    setInputEnabled(window.inputEnabled === false);
  });

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
    if(e.ctrlKey && !e.altKey && k.length === 1){
      const lc = k.toLowerCase();
      // Ctrl+C: copy if there's a selection, otherwise fall through to send ^C (SIGINT).
      if(lc === 'c'){
        const t = TabManager.getActive();
        const sel = t && t.term.getSelection();
        if(sel){ e.preventDefault(); copyText(sel); t.term.clearSelection(); return; }
      }
      // Ctrl+V: let the native 'paste' event on #ta handle it (no clipboard
      // permission chip). Just don't send raw 0x16.
      if(lc === 'v'){ return; }
      const c = lc.charCodeAt(0);
      if(c >= 97 && c <= 122){ e.preventDefault(); sendActive(String.fromCharCode(c - 96)); resetTa(); return; }
    }
  });

  function copyText(s){
    if(navigator.clipboard) return navigator.clipboard.writeText(s).catch(()=>{});
  }
  // Normalize CRLF/CR to LF, then wrap in bracketed-paste so the target app
  // (Claude CLI / shell readline) treats a multi-line paste as one block
  // instead of submitting on each embedded newline.
  function sendPaste(t){
    if(!t) return;
    t = t.replace(/\r\n?/g, '\n');
    sendActive('\x1b[200~' + t + '\x1b[201~');
  }
  // Native paste event (Ctrl+V, browser's own menu). clipboardData is granted
  // during a real paste gesture, so this never triggers the clipboard-read
  // permission chip. preventDefault keeps the text out of #ta (no double-send
  // via the input/rewrite path).
  ta.addEventListener('paste', e => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    if(!cd) return;
    const files = filesFrom(cd);
    if(files.length){ uploadFiles(files); return; }
    sendPaste(cd.getData('text'));
  });
  // Programmatic paste for the custom right-click menu (canvas has no native
  // menu). readText() may show Chrome's permission chip the first time until
  // the site is granted persistent clipboard-read permission.
  function pasteClipboard(){
    if(navigator.clipboard && navigator.clipboard.readText){
      navigator.clipboard.readText().then(sendPaste).catch(()=>{});
    }
  }
  window.copyText = copyText;
  window.pasteClipboard = pasteClipboard;

  function filesFrom(dt){
    if(dt.files && dt.files.length) return Array.from(dt.files);
    const out = [];
    if(dt.items) for(const it of dt.items){
      if(it.kind !== 'file') continue;
      const f = it.getAsFile();
      if(f) out.push(f);
    }
    return out;
  }
  function hasFiles(dt){
    return !!dt && !!dt.types && Array.from(dt.types).indexOf('Files') !== -1;
  }

  let toastEl = null, toastTimer = null;
  function showToast(msg, sticky){
    if(!toastEl){
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    if(!sticky) toastTimer = setTimeout(hideToast, 3000);
  }
  function hideToast(){
    clearTimeout(toastTimer);
    if(toastEl) toastEl.classList.remove('visible');
  }

  async function uploadFiles(files){
    if(!files || !files.length) return;
    const tab = TabManager.getActive();
    if(!tab){ showToast('Open a tab first'); return; }

    const fd = new FormData();
    for(const f of files) fd.append('file', f, f.name || 'image.png');
    showToast('Uploading ' + (files.length > 1 ? files.length + ' files' : (files[0].name || 'image')) + '…', true);

    let data;
    try {
      const res = await fetch('/api/upload?sid=' + encodeURIComponent(tab.sid), { method: 'POST', body: fd });
      data = await res.json().catch(() => null);
      if(!res.ok){ showToast((data && data.error) || 'Upload failed'); return; }
    } catch(_){
      showToast('Upload failed');
      return;
    }
    if(!data || !data.paths || !data.paths.length){ showToast('Nothing uploaded'); return; }

    // Quote paths containing spaces, matching what a terminal inserts on drop.
    // Trailing space so the next thing typed doesn't run into the path.
    sendPaste(data.paths.map(p => /\s/.test(p) ? '"' + p + '"' : p).join(' ') + ' ');
    hideToast();
  }

  // Without preventDefault on dragover the browser navigates away to the dropped
  // image — the "opens a new tab" behaviour this replaces.
  let dropHint = null, dragDepth = 0;
  function setDropHint(on){
    if(!dropHint){
      dropHint = document.createElement('div');
      dropHint.className = 'drop-hint';
      dropHint.textContent = 'Drop to send to this tab';
      document.body.appendChild(dropHint);
    }
    dropHint.classList.toggle('visible', on);
  }
  document.addEventListener('dragenter', e => {
    if(!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if(++dragDepth === 1) setDropHint(true);
  });
  document.addEventListener('dragover', e => {
    if(!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', e => {
    if(dragDepth && --dragDepth <= 0){ dragDepth = 0; setDropHint(false); }
  });
  document.addEventListener('drop', e => {
    if(!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth = 0;
    setDropHint(false);
    uploadFiles(filesFrom(e.dataTransfer));
  });

  document.addEventListener('click', e => {
    if(window.inputEnabled === false) return;   // keyboard locked off — don't refocus
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

  function showFileOverlay(fileId, name, caption, kind){
    var existing = document.getElementById('img-overlay');
    if(existing) existing._dismiss ? existing._dismiss() : existing.remove();

    var src = '/api/file/' + fileId;
    var overlay = document.createElement('div');
    overlay.id = 'img-overlay';
    overlay.className = 'img-overlay';

    var box = document.createElement('div');
    box.className = 'img-box';

    var media, imgView;
    if(kind === 'image'){
      media = document.createElement('img');
      media.src = src;
      media.alt = name || 'image';
      imgView = document.createElement('div');
      imgView.className = 'img-view';
      imgView.appendChild(media);
    } else if(kind === 'video'){
      media = document.createElement('video');
      media.src = src;
      media.controls = true;
      media.autoplay = true;
    } else if(kind === 'audio'){
      media = document.createElement('audio');
      media.src = src;
      media.controls = true;
      media.autoplay = true;
    } else {
      // Non-media: offer a download link.
      media = document.createElement('a');
      media.className = 'img-download';
      media.href = src;
      media.download = name || 'file';
      media.textContent = '⬇ Download ' + (name || 'file');
    }
    box.appendChild(imgView || media);

    if(caption || name){
      var cap = document.createElement('div');
      cap.className = 'img-caption';
      cap.textContent = caption || name;
      box.appendChild(cap);
    }

    var close = document.createElement('button');
    close.className = 'img-close';
    close.textContent = '×';

    overlay.appendChild(box);
    overlay.appendChild(close);
    document.body.appendChild(overlay);

    if(imgView) setupImageZoom(imgView, media);

    function dismiss(){
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      // Drop the server-side id->path reference (source file untouched).
      try { fetch(src, { method: 'DELETE' }); } catch(_){}
    }
    overlay._dismiss = dismiss;
    function onKey(ev){ if(ev.key === 'Escape') dismiss(); }
    close.addEventListener('click', dismiss);
    overlay.addEventListener('click', function(ev){ if(ev.target === overlay) dismiss(); });
    document.addEventListener('keydown', onKey);
  }

  function setupImageZoom(view, img){
    var scale = 1, tx = 0, ty = 0;
    var MIN = 1, MAX = 8;
    function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }
    function apply(){
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      view.classList.toggle('zoomed', scale > 1.001);
    }
    // Keep translate within bounds so panning can't fling the image out of view.
    function clampPan(){
      var vw = view.clientWidth, vh = view.clientHeight;
      var iw = img.clientWidth * scale, ih = img.clientHeight * scale;
      // Larger than view: pan across the overflow (translate in [vw-iw, 0]); else center.
      tx = iw <= vw ? (vw - iw) / 2 : clamp(tx, vw - iw, 0);
      ty = ih <= vh ? (vh - ih) / 2 : clamp(ty, vh - ih, 0);
    }
    function zoomAt(cx, cy, factor){
      var next = clamp(scale * factor, MIN, MAX);
      factor = next / scale;
      if(factor === 1) return;
      // Point under (cx,cy) stays fixed: tx' = cx - factor*(cx - tx)
      tx = cx - factor * (cx - tx);
      ty = cy - factor * (cy - ty);
      scale = next;
      clampPan();
      apply();
    }
    img.addEventListener('load', function(){ tx = 0; ty = 0; scale = 1; clampPan(); apply(); });
    view.addEventListener('wheel', function(e){
      e.preventDefault();
      var r = view.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1/1.15);
    }, { passive: false });
    view.addEventListener('dblclick', function(e){
      var r = view.getBoundingClientRect();
      if(scale > 1.001){ scale = 1; clampPan(); apply(); }
      else zoomAt(e.clientX - r.left, e.clientY - r.top, 2.5);
    });

    var pts = {};
    var last = null, pinchStart = null;
    view.addEventListener('pointerdown', function(e){
      view.setPointerCapture(e.pointerId);
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pts);
      if(ids.length === 1){ last = { x: e.clientX, y: e.clientY }; }
      else if(ids.length === 2){
        var a = pts[ids[0]], b = pts[ids[1]];
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: scale };
      }
    });
    view.addEventListener('pointermove', function(e){
      if(!pts[e.pointerId]) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pts);
      var r = view.getBoundingClientRect();
      if(ids.length >= 2 && pinchStart){
        var a = pts[ids[0]], b = pts[ids[1]];
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        var target = clamp(pinchStart.scale * (dist / pinchStart.dist), MIN, MAX);
        var mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
        zoomAt(mx, my, target / scale);
      } else if(ids.length === 1 && last && scale > 1.001){
        tx += e.clientX - last.x;
        ty += e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        clampPan();
        apply();
      }
    });
    function up(e){
      delete pts[e.pointerId];
      try { view.releasePointerCapture(e.pointerId); } catch(_){}
      if(Object.keys(pts).length < 2) pinchStart = null;
      last = null;
    }
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
  }

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
    es.addEventListener('show_file', function(e){
      var data = JSON.parse(e.data);
      showFileOverlay(data.id, data.name, data.caption, data.kind);
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
