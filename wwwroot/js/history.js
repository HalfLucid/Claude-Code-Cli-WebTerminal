// History overlay: shows a Claude tab's conversation rebuilt from Claude's own
// .jsonl log (GET /api/transcript/{sid}) as HTML that reflows to any width.
// The terminal's scrollback can't: it replays PTY output laid out for the
// width it was produced at (e.g. a phone's), with hard line breaks.
// The live terminal is untouched; this only covers it while open.
window.HistoryView = (function(){
  const POLL_MS = 2000;
  let overlay = null, bodyEl = null, titleEl = null, statusEl = null;
  let openTab = null, timer = null;

  function build(){
    if(overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'history-overlay';
    const head = document.createElement('div');
    head.className = 'history-head';
    titleEl = document.createElement('span');
    titleEl.className = 'history-title';
    statusEl = document.createElement('span');
    statusEl.className = 'history-status';
    const close = document.createElement('button');
    close.className = 'history-close';
    close.title = 'Back to terminal (Esc)';
    close.textContent = '×';
    close.addEventListener('click', e => { e.preventDefault(); hide(true); });
    head.append(titleEl, statusEl, close);
    bodyEl = document.createElement('div');
    bodyEl.className = 'history-body';
    // Focusable, so keys go here (native scrolling, Ctrl+C copies a selection)
    // instead of #ta, which forwards every key to Claude.
    bodyEl.tabIndex = -1;
    // An open tool call's summary sticks to the top so it can be collapsed
    // from anywhere in a long output. Collapsing from there would leave the
    // view past the call, so bring its summary back into view. ('toggle'
    // doesn't bubble; capture catches it.)
    bodyEl.addEventListener('toggle', e => {
      const d = e.target;
      if(d.open || !d.matches || !d.matches('.h-tool, .h-compact')) return;
      if(d.getBoundingClientRect().top < bodyEl.getBoundingClientRect().top) d.scrollIntoView({block: 'start'});
    }, true);
    // Unpinned, the message box scrolls in and out of view.
    bodyEl.addEventListener('scroll', clampButtons, { passive: true });
    window.addEventListener('resize', clampButtons);
    buildInput();
    overlay.addEventListener('paste', onPaste);
    overlay.append(head, bodyEl);
    document.body.appendChild(overlay);
    // The mobile keyboard overlays the page without resizing it (100dvh stays
    // put), so size the overlay to the visual viewport to keep the input bar
    // above the keyboard.
    if(window.visualViewport){
      visualViewport.addEventListener('resize', fitViewport);
      visualViewport.addEventListener('scroll', fitViewport);
    }
    // Capture phase, ahead of #ta's keydown. Esc closes the overlay without
    // reaching Claude (where it interrupts the turn). A key aimed at #ta
    // (something refocused it, e.g. the keyboard toggle) means the user is
    // typing to Claude: close the overlay and let the key through.
    // An overlay above this one (file viewer, copy box, a dialog) owns Esc.
    window.addEventListener('keydown', e => {
      if(!openTab) return;
      if(e.key === 'Escape'){
        if(document.querySelector('.img-overlay, .modal-overlay.visible')) return;
        e.preventDefault(); e.stopImmediatePropagation(); hide(true); return;
      }
      if(e.target && e.target.id === 'ta') hide(true);
    }, true);
  }

  // Rendered entries are kept per tab, so reopening only fetches what's new.
  function stateOf(tab){
    if(!tab.hist){
      const el = document.createElement('div');
      el.className = 'history-list';
      el.dataset.empty = 'Loading…';
      tab.hist = { path: null, offset: 0, el, tools: {} };
    }
    return tab.hist;
  }

  // Each tab remembers its view (tab.view: 'html' or 'text'). Claude tabs
  // start in HTML; PowerShell has no Claude log, so it starts in the terminal.
  function wantsHtml(tab){
    return tab.view ? tab.view === 'html' : tab.kind !== 'powershell';
  }

  // HTML/TEXT button: switches the tab's view and remembers it.
  function toggle(tab){
    if(!tab) return;
    if(openTab === tab){ hide(true); return; }
    tab.view = 'html';
    terminalToDraft(tab);
    show(tab);
  }

  // The reverse of draftToTerminal: text typed in the terminal and not yet
  // sent moves into the message box (and is erased from Claude's prompt, one
  // DEL per code point as rewrite() would) instead of sitting unseen behind
  // the overlay, where sendMessage would erase it. Only what #ta mirrored
  // (sentText) is known; arrow keys reset it, so the cursor is at its end.
  // A paste's [Pasted text] placeholder can't be read back and stays put.
  function terminalToDraft(tab){
    const text = window.sentText || '';
    if(!text || !window.TabManager || TabManager.getActive() !== tab || !tab.ws || tab.ws.readyState !== 1) return;
    Connection.send(tab, '\x7f'.repeat(Array.from(text).length));
    const ta = document.getElementById('ta');
    if(ta) ta.value = '';
    window.sentText = '';
    const st = stateOf(tab);
    st.draft = st.draft ? st.draft.replace(/\s*$/, ' ') + text : text;
  }

  // On tab switch: reopen the history if that's the tab's view.
  function restore(tab){
    if(tab && openTab !== tab && wantsHtml(tab)) show(tab);
  }

  // The message box is one element shared by all tabs, so its text is kept
  // per tab: saved when the overlay leaves a tab, restored when it opens one.
  function saveDraft(){
    if(openTab && msgEl) stateOf(openTab).draft = msgEl.value;
  }

  function show(tab){
    build();
    saveDraft();
    openTab = tab;
    const st = stateOf(tab);
    msgEl.value = st.draft || '';
    renderAttach();
    // The message box ends the conversation, like Claude's prompt box ends the
    // terminal; pinned, it sticks to the bottom of the view while scrolling.
    bodyEl.replaceChildren(st.el, inputBar);
    menuSig = '';
    updateStatus();   // drop the previous tab's line before the first frame
    updateSuggestion();
    hookMenu(tab);
    scheduleMenu();
    titleEl.textContent = 'History — ' + (tab.label || '');
    statusEl.textContent = '';
    overlay.classList.add('show');
    growInput();   // after showing: a hidden textarea measures 0 high
    applyPin();
    labelButton();
    fitViewport();
    bodyEl.scrollTop = bodyEl.scrollHeight;
    bodyEl.focus({ preventScroll: true });
    if(timer) clearInterval(timer);
    timer = setInterval(() => poll(false), POLL_MS);
    poll(true);
  }

  // byUser: the user left the history (×, Esc, TEXT, typing to the terminal),
  // so the tab stays in terminal view. A tab switch or the main screen hides
  // it without changing the tab's view.
  function hide(byUser){
    scheduleStrip();   // also called on tab switch, so the strip follows the active tab
    if(!openTab) return;
    if(byUser === true){ openTab.view = 'text'; draftToTerminal(openTab); }
    saveDraft();
    openTab = null;
    labelButton();
    clampButtons();
    if(timer){ clearInterval(timer); timer = null; }
    overlay.classList.remove('show');
    const ta = document.getElementById('ta');
    if(ta && window.inputEnabled !== false) ta.focus();   // keyboard toggled off: don't pop it
  }

  // Leaving for the terminal carries the unsent message into Claude's prompt
  // (not submitted), so it can be finished there. A single line goes through
  // #ta's input diff, so it stays editable with Backspace; multi-line text is
  // a bracketed paste (a raw newline would submit), after which #ta is cleared
  // like any paste. Not connected: the draft stays in the box.
  function draftToTerminal(tab){
    if(!msgEl) return;
    const text = msgEl.value.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    if(!tab.ws || tab.ws.readyState !== 1) return;
    const ta = document.getElementById('ta');
    // With attachments, everything goes as separate pastes 40 ms apart, as
    // sendMessage sends them (minus the Enter), so each image path becomes its
    // own [Image #n]; the text can't then go through #ta's diff, which would
    // race the timed pastes.
    const st = stateOf(tab);
    if(st.attach && st.attach.length){
      const parts = st.attach.map(p => quotePath(p) + ' ');
      if(text.trim()) parts.push(text);
      parts.forEach((p, i) => setTimeout(() => Connection.send(tab, '\x1b[200~' + p + '\x1b[201~'), i * 40));
      if(ta) ta.value = '';
      window.sentText = '';
      st.attach = [];
      renderAttach();
      msgEl.value = '';
      growInput();
      return;
    }
    if(!text.trim()) return;
    if(ta && !text.includes('\n')){
      ta.value += text;
      ta.dispatchEvent(new Event('input'));
    } else {
      Connection.send(tab, '\x1b[200~' + text + '\x1b[201~');
      if(ta) ta.value = '';
      window.sentText = '';
    }
    msgEl.value = '';
    growInput();
  }

  // The button column hangs from the top right and, with the mobile keyboard
  // up, reaches down over the message box's send button. While the overlay is
  // open and the box is on screen, end the column above it (it scrolls if it
  // doesn't fit).
  function clampButtons(){
    const bar = document.querySelector('.btnbar');
    if(!bar) return;
    let max = 0;
    if(openTab && inputBar){
      const top = inputBar.getBoundingClientRect().top;
      const bottom = window.visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight;
      if(top < bottom) max = Math.max(60, top - bar.getBoundingClientRect().top - 8);
    }
    bar.style.maxHeight = max ? max + 'px' : '';
    bar.classList.toggle('clamped', !!max);
  }

  function isOpen(){ return !!openTab; }

  // Button-bar ENT/Tab while open act on the message box when that's what
  // they'd mean in Claude's prompt: ENT sends a non-empty message, Tab takes
  // the suggestion into an empty box. Otherwise (e.g. ENT on a menu) false,
  // and the key goes to the PTY.
  function key(k){
    if(!openTab || !msgEl) return false;
    if(k === 'enter'){
      if(!msgEl.value.trim() && !(stateOf(openTab).attach || []).length) return false;
      sendMessage();
      return true;
    }
    if(k === 'tab'){
      if(msgEl.value || !suggestion) return false;
      acceptSuggestion();
      return true;
    }
    return false;
  }

  // A custom button's text (one without Enter) goes into the box instead of
  // Claude's hidden prompt, where it would ride along with the next message unseen.
  function insert(text){
    if(!openTab || !msgEl) return false;
    msgEl.setRangeText(text, msgEl.selectionStart, msgEl.selectionEnd, 'end');
    growInput();
    return true;
  }

  // While open, keys belong to the overlay body, not #ta (see build()).
  function focus(){ if(openTab && bodyEl) bodyEl.focus({ preventScroll: true }); }

  // The toggle button names the view it switches to.
  function labelButton(){
    document.querySelectorAll('.btn.hist').forEach(b => { b.textContent = openTab ? 'TEXT' : 'HTML'; });
  }

  // The pin keeps somewhere to type in view while scrolled up. The history
  // always ends with a message box that types into Claude; pinning only makes
  // it stick to the bottom of the view. In terminal mode it's a strip showing
  // Claude's prompt box, copied from the bottom of the terminal, whenever
  // scrolling up has cut it off. On by default; remembered per browser.
  const PIN_KEY = 'webterm.historyPinned';
  let pinned = true;
  try{ pinned = localStorage.getItem(PIN_KEY) !== '0'; }catch{}
  let inputBar = null, msgEl = null;
  // Enter sends (as in the terminal). On desktop Shift+Enter is a new line;
  // touch keyboards have no Shift, so there a new line needs a paste.
  const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  const DEFAULT_PLACEHOLDER = touch ? 'Message Claude…' : 'Message Claude…  (Enter sends, Shift+Enter new line)';

  function buildInput(){
    inputBar = document.createElement('div');
    inputBar.className = 'history-input';
    msgEl = document.createElement('textarea');
    msgEl.className = 'history-msg';
    msgEl.rows = 2;
    msgEl.placeholder = DEFAULT_PLACEHOLDER;
    msgEl.setAttribute('autocapitalize', 'sentences');
    msgEl.addEventListener('input', growInput);
    msgEl.addEventListener('keydown', e => {
      if(e.key === 'Enter' && !e.isComposing && (e.ctrlKey || touch || !e.shiftKey)){ e.preventDefault(); sendMessage(); }
      // Tab in an empty box takes Claude's suggested next prompt (as Tab does in its prompt).
      else if(e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !msgEl.value && suggestion){
        e.preventDefault();
        acceptSuggestion();
      }
    });
    const send = document.createElement('button');
    send.className = 'history-send';
    send.title = 'Send to Claude';
    send.innerHTML = '&#10148;';
    // pointerdown keeps the mobile keyboard up (no blur before the click).
    send.addEventListener('pointerdown', e => e.preventDefault());
    send.addEventListener('click', e => { e.preventDefault(); sendMessage(); });
    // Claude's spinner line while it works (see updateStatus).
    statusEl2 = div('history-working');
    attachEl = div('history-attach');
    inputBar.append(statusEl2, attachEl, msgEl, send);
    return inputBar;
  }

  // Files pasted or dropped while the overlay shows a tab are uploaded (as in
  // the terminal) and held per tab as chips until the message is sent.
  let attachEl = null;
  const quotePath = p => window.quotePath(p);   // app.js

  // From uploadFiles in app.js: true if the tab is in the HTML view and took them.
  function attach(tab, paths){
    if(!tab || !wantsHtml(tab) || !paths || !paths.length) return false;
    const st = stateOf(tab);
    st.attach = (st.attach || []).concat(paths);
    if(openTab === tab) renderAttach();
    return true;
  }

  function renderAttach(){
    if(!attachEl) return;
    const list = openTab ? (stateOf(openTab).attach || []) : [];
    attachEl.replaceChildren();
    attachEl.classList.toggle('show', list.length > 0);
    list.forEach((p, i) => {
      const chip = div('h-attach');
      chip.title = p;
      chip.appendChild(document.createTextNode(p.split(/[\\/]/).pop()));
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove';
      x.addEventListener('pointerdown', e => e.preventDefault());
      x.addEventListener('click', e => {
        e.preventDefault();
        stateOf(openTab).attach.splice(i, 1);
        renderAttach();
      });
      chip.appendChild(x);
      attachEl.appendChild(chip);
    });
    clampButtons();
  }

  // Paste anywhere in the overlay: files are attached; text pasted outside a
  // text field goes into the message box (the body itself isn't editable).
  function onPaste(e){
    if(!openTab) return;
    const cd = e.clipboardData;
    if(!cd) return;
    const files = window.filesFrom ? window.filesFrom(cd) : [];
    if(files.length){ e.preventDefault(); if(window.uploadFiles) window.uploadFiles(files); return; }
    const t = e.target;
    if(t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;   // native text paste
    const text = cd.getData('text');
    if(!text) return;
    e.preventDefault();
    msgEl.focus({ preventScroll: true });
    msgEl.setRangeText(text, msgEl.selectionStart, msgEl.selectionEnd, 'end');
    growInput();
  }

  // Grows with its content (max-height in CSS caps it, then it scrolls).
  function growInput(){
    msgEl.style.height = 'auto';
    msgEl.style.height = (msgEl.scrollHeight + 2) + 'px';
    clampButtons();
  }

  function applyPin(){
    if(inputBar) inputBar.classList.toggle('pinned', pinned);
    document.querySelectorAll('.btn.pin').forEach(b => b.classList.toggle('on', pinned));
    scheduleStrip();
  }

  // Pin button: toggles the pinned entry for whichever mode is showing.
  function togglePin(){
    pinned = !pinned;
    try{ localStorage.setItem(PIN_KEY, pinned ? '1' : '0'); }catch{}
    applyPin();
  }

  let stripEl = null, stripQueued = false;
  const hooked = new WeakSet();

  function scheduleStrip(){
    if(stripQueued) return;
    stripQueued = true;
    requestAnimationFrame(() => { stripQueued = false; updateStrip(); });
  }

  function hookTerm(tab){
    if(hooked.has(tab.term)) return;
    hooked.add(tab.term);
    const kick = () => { if(window.TabManager && TabManager.getActive() === tab) scheduleStrip(); };
    tab.term.onScroll(kick);
    tab.term.onWriteParsed(kick);
    tab.term.onResize(kick);
  }

  // Rows (absolute buffer lines) of Claude's prompt box on the live screen:
  // from the rule above the prompt to the last drawn row (the footer under
  // the box). Without two rules (not Claude, or a menu is up), the cursor row
  // and what's drawn below it.
  function entryRows(buf, rows){
    const top = buf.baseY, text = y => { const l = buf.getLine(y); return l ? l.translateToString(true) : ''; };
    let last = top + rows - 1;
    while(last > top && !text(last).trim()) last--;
    const rules = [];
    for(let y = last; y >= top && rules.length < 2; y--) if(isPlainRule(text(y))) rules.push(y);   // same rule test as the menu/status parser
    let start = rules.length === 2 ? rules[1] : Math.max(top, top + buf.cursorY - 1);
    last = Math.max(last, top + buf.cursorY);
    start = Math.max(start, last - 15);   // a huge paste: keep the tail
    return { start, last };
  }

  // One row as HTML, with the cursor cell marked. Walks cells (not the
  // string) so wide glyphs keep the cursor column right.
  function rowHtml(line, cols, cursorX){
    let h = '';
    for(let x = 0; x < cols; x++){
      const cell = line.getCell(x);
      if(!cell) break;
      if(cell.getWidth() === 0) continue;
      const ch = esc(cell.getChars() || ' ');
      h += x === cursorX ? '<span class="cur">' + ch + '</span>' : ch;
    }
    return cursorX >= 0 ? h : h.replace(/\s+$/, '');
  }

  function updateStrip(){
    const tab = window.TabManager && TabManager.getActive();
    const term = tab && tab.term;
    const show = pinned && !openTab && term && tab.containerEl && tab.containerEl.classList.contains('active');
    if(!show){ if(stripEl) stripEl.classList.remove('show'); return; }
    hookTerm(tab);
    const buf = term.buffer.active;
    const { start, last } = entryRows(buf, term.rows);
    // Only while the bottom of the prompt box is scrolled out of view.
    if(last <= buf.viewportY + term.rows - 1){ if(stripEl) stripEl.classList.remove('show'); return; }
    if(!stripEl){
      stripEl = document.createElement('pre');
      stripEl.className = 'term-entry-strip';
      stripEl.title = 'Claude\'s prompt (scrolled out of view). Tap to jump to the bottom.';
      stripEl.addEventListener('click', () => {
        const t = TabManager.getActive();
        if(t && t.term) t.term.scrollToBottom();
      });
      document.body.appendChild(stripEl);
      if(window.visualViewport){
        visualViewport.addEventListener('resize', scheduleStrip);
        visualViewport.addEventListener('scroll', scheduleStrip);
      }
    }
    const cy = buf.baseY + buf.cursorY, out = [];
    // Claude's spinner line sits above the box (a todo list may be between),
    // so it isn't in start..last; add it on top so the status stays in view.
    for(let y = start - 1; y >= Math.max(buf.baseY, start - 25); y--){
      const line = buf.getLine(y);
      if(line && SPINNER.test(line.translateToString(true))){ out.push(rowHtml(line, term.cols, -1)); break; }
    }
    for(let y = start; y <= last; y++){
      const line = buf.getLine(y);
      if(line) out.push(rowHtml(line, term.cols, y === cy ? buf.cursorX : -1));
    }
    stripEl.innerHTML = out.join('\n');
    const o = term.options;
    stripEl.style.fontFamily = o.fontFamily || 'monospace';
    stripEl.style.fontSize = (o.fontSize || 14) + 'px';
    stripEl.style.background = (o.theme && o.theme.background) || '#000';
    // Pin to the bottom of what's visible (above the mobile keyboard).
    const vv = window.visualViewport;
    stripEl.style.bottom = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) + 'px' : '0';
    stripEl.classList.add('show');
  }

  function isPinned(){ return pinned; }

  // Claude's interactive screens (approval prompts, the --resume session
  // picker, /model, ...) aren't in its log. While one is on the live terminal
  // screen it's mirrored here as buttons that send the keys a user would:
  // arrows to move the selection, then Enter.
  let menuEl = null, menuSig = '', menuQueued = false, lastMenu = null;
  const menuHooked = new WeakSet();

  function scheduleMenu(){
    if(menuQueued) return;
    menuQueued = true;
    requestAnimationFrame(() => { menuQueued = false; updateMenu(); updateStatus(); updateSuggestion(); });
  }

  // When Claude's prompt is empty it may draw a suggested next prompt there as
  // ghost text (dim or grey) that Tab accepts. It isn't in the log, so read it
  // off the live screen: the row under the prompt box's top rule, after the
  // `❯`, up to the bottom rule (a long one wraps). Any character in the
  // normal colour means the user's own text is in the prompt: no suggestion.
  // Claude's 'Try "…"' placeholder examples aren't suggestions.
  let suggestion = '';

  function isGhost(c){ return !!(c.isDim() || c.isInverse() || !c.isFgDefault()); }

  function parseSuggestion(term){
    const buf = term.buffer.active, top = buf.baseY;
    const text = i => { const l = buf.getLine(top + i); return l ? l.translateToString(true) : ''; };
    const rules = [];
    for(let i = term.rows - 1; i >= 0 && rules.length < 2; i--) if(isPlainRule(text(i))) rules.push(i);
    if(rules.length < 2) return '';
    const [bottom, ruleTop] = rules;
    const m = /^\s*[❯>]\s/.exec(text(ruleTop + 1));
    if(!m) return '';
    const parts = [];
    for(let i = ruleTop + 1; i < bottom; i++){
      const l = buf.getLine(top + i);
      if(!l) break;
      let s = '';
      for(let x = i === ruleTop + 1 ? m[0].length : 0; x < term.cols; x++){
        const c = l.getCell(x);
        if(!c) break;
        if(c.getWidth() === 0) continue;
        const ch = c.getChars();
        if(ch && ch.trim() && !isGhost(c)) return '';
        s += ch || ' ';
      }
      if(s.trim()) parts.push(s.trim());
    }
    const out = parts.join(' ');
    return /^Try "/.test(out) ? '' : out;
  }

  function updateSuggestion(){
    const s = openTab && openTab.term ? parseSuggestion(openTab.term) : '';
    if(s === suggestion) return;
    suggestion = s;
    if(msgEl) msgEl.placeholder = s ? s + (touch ? '' : '   (Tab to accept)') : DEFAULT_PLACEHOLDER;
  }

  function acceptSuggestion(){
    msgEl.value = suggestion;
    msgEl.setSelectionRange(suggestion.length, suggestion.length);
    growInput();
  }

  // Claude's spinner line ("✻ Frosting… (5m 21s · ↓ 33.9k tokens · esc to
  // interrupt)") isn't in its log either. It sits just above the prompt box
  // (with the todo list, if any, between), so look in the rows above the
  // box's top rule. Only the in-progress form (with "…") counts; the
  // past-tense "✻ Worked for 5m" left after a turn doesn't.
  const SPINNER = /^\s*[·✢✳✶✻✽*]\s+(\S.{0,80}?(?:…|\.\.\.))\s*(?:\((.*?)\)?)?\s*$/;   // ")" may wrap off a narrow line
  let statusEl2 = null, statusSig = '';

  function parseStatus(term){
    const buf = term.buffer.active, top = buf.baseY;
    const text = i => { const l = buf.getLine(top + i); return l ? l.translateToString(true) : ''; };
    let rules = 0, i = term.rows - 1;
    for(; i >= 0 && rules < 2; i--) if(isPlainRule(text(i))) rules++;
    if(rules < 2) return '';
    for(let stop = Math.max(0, i - 25); i >= stop; i--){
      const m = SPINNER.exec(text(i));
      if(!m) continue;
      // Esc here closes the overlay, so its hint is noise.
      const info = (m[2] || '').split('·').map(s => s.trim())
        .filter(s => s && !/esc to interrupt|ctrl\+/i.test(s));
      return m[1] + (info.length ? '  (' + info.join(' · ') + ')' : '');
    }
    return '';
  }

  function updateStatus(){
    const s = openTab && openTab.term ? parseStatus(openTab.term) : '';
    if(s === statusSig) return;
    statusSig = s;
    if(!statusEl2) return;
    statusEl2.textContent = s;
    statusEl2.classList.toggle('show', !!s);
  }

  function hookMenu(tab){
    if(!tab.term || menuHooked.has(tab.term)) return;
    menuHooked.add(tab.term);
    const kick = () => { if(openTab === tab) scheduleMenu(); };
    tab.term.onWriteParsed(kick);
    tab.term.onResize(kick);
  }

  const isPlainRule = s => /^[─━-]{6,}$/.test(s.trim());
  const isBoxEdge = s => /^[╭╰┌└├]?[─━╌┄┈-]{6,}[╮╯┐┘┤]?$/.test(s.trim());

  const isNumRow = s => /^\s*(?:[❯›>]\s+)?\d+[.)]\s/.test(s || '');
  // Options that take typed text: highlighting one and typing replaces its
  // label in place ("❯ 4. purple"), then Enter sends it.
  const TEXT_OPT = /^(?:\d+[.)]\s+)?(?:\[.\]\s+)?(?:Type something\.?|Tell Claude what to change)$/i;

  // Finds a selection list on the live screen: a row starting with a pointer
  // (❯, ›, >) followed by sibling rows at the pointer's text column. Lines
  // indented deeper continue the option above. Scanning stops at a plain
  // rule: Claude's prompt box is drawn between two, so a pointer above it is
  // scrollback, not a menu (menus replace the prompt box). The exception is
  // a rule with a numbered option right under it (AskUserQuestion draws one
  // above "Chat about this").
  function parseMenu(term){
    const buf = term.buffer.active, top = buf.baseY, rows = term.rows;
    const L = [], boxed = [];
    for(let i = 0; i < rows; i++){
      const l = buf.getLine(top + i), s = l ? l.translateToString(true) : '';
      boxed.push(/[│┃]/.test(s));
      L.push(s.replace(/[│┃]/g, ' ').replace(/\s+$/, ''));
    }
    const indent = s => s.search(/\S/);
    let y = -1, c = -1;
    for(let i = rows - 1; i >= 0; i--){
      const s = L[i], k = indent(s);
      if(isPlainRule(s)){ if(isNumRow(L[i + 1])) continue; return null; }
      if(k < 0 || !/[❯›>]/.test(s[k]) || s[k + 1] !== ' ' || !s.slice(k + 2).trim()) continue;
      if(i > 0 && isBoxEdge(L[i - 1]) && !isNumRow(s)) return null;   // the prompt line itself
      y = i; c = k; break;
    }
    if(y < 0) return null;
    const col = c + 2;
    // A rule between two menu rows, one of them numbered, is part of the menu.
    const near = i => i === y || indent(L[i]) >= col;
    const crossable = i => isPlainRule(L[i]) && i > 0 && i + 1 < rows && near(i - 1) && near(i + 1) &&
      (isNumRow(L[i - 1]) || isNumRow(L[i + 1]));
    const inMenu = i => { const k = indent(L[i]); return k < 0 || crossable(i) || (k >= col && !isBoxEdge(L[i])); };
    let a = y, b = y;
    for(let i = y - 1, blanks = 0; i >= 0 && inMenu(i); i--){
      if(indent(L[i]) < 0){ if(++blanks > 1) break; } else { blanks = 0; a = i; }
    }
    for(let i = y + 1, blanks = 0; i < rows && inMenu(i); i++){
      if(indent(L[i]) < 0){ if(++blanks > 1) break; } else { blanks = 0; b = i; }
    }
    const rule = i => isPlainRule(L[i]);
    const text = i => (i === y ? L[i].slice(col) : L[i]).trim();
    let items = [], sel = null;
    // Blank lines between rows mean each blank-separated block is one option
    // (the --resume picker: title, then "2 hours ago · master · 1MB" at the
    // same indent). Otherwise a row at the option column starts an option and
    // deeper rows continue it (approval menus).
    // A numbered pointer row is always the line-per-option kind (the
    // AskUserQuestion review has its answers, then a blank, then options).
    let gapped = false;
    if(!isNumRow(L[y])) for(let i = a + 1; i < b; i++) if(indent(L[i]) < 0){ gapped = true; break; }
    if(gapped){
      let cur = null;
      for(let i = a; i <= b; i++){
        if(indent(L[i]) < 0){ cur = null; continue; }
        if(!cur){ cur = { lines: [] }; items.push(cur); }
        cur.lines.push(text(i));
        if(i === y) sel = cur;
      }
      // Shorter blocks are headings (the picker's project name), not options.
      if(sel) items = items.filter(it => it.lines.length >= sel.lines.length);
    } else {
      for(let i = a; i <= b; i++){
        const k = indent(L[i]);
        if(k < 0 || rule(i)) continue;
        // Multi-select's "Submit" row sits at the description indent but is
        // its own option.
        const own = i === y || k === col || text(i) === 'Submit';
        if(own) items.push({ lines: [text(i)] });
        else if(items.length) items[items.length - 1].lines.push(text(i));
        if(i === y) sel = items[items.length - 1];
      }
      // A numbered menu (approvals, /model): only the numbered rows are options.
      const numbered = items.filter(it => /^\d+[.)]\s/.test(it.lines[0]) || it.lines[0] === 'Submit');
      if(numbered.length >= 2) items = numbered;
    }
    const idx = items.indexOf(sel);
    if(idx < 0 || items.length < 2) return null;
    // Question: the lines above, up to a rule, minus boxes (the search field).
    const title = [];
    for(let i = a - 1; i >= 0 && i >= a - 10 && !isPlainRule(L[i]); i--)
      if(L[i].trim() && !boxed[i] && !isBoxEdge(L[i])) title.unshift(L[i].trim());
    // Hint: the key help, the last block of text under the list.
    let hint = [], gap = true;
    for(let i = b + 1; i < rows; i++){
      if(indent(L[i]) < 0){ gap = true; continue; }
      if(gap){ hint = []; gap = false; }
      hint.push(L[i].trim());
    }
    return { title: title.join('\n'), items: items.map(it => it.lines), sel: idx, hint: hint.join(' ') };
  }

  function updateMenu(){
    const tab = openTab;
    const m = tab && tab.term ? parseMenu(tab.term) : null;
    const sig = m ? JSON.stringify(m) : '';
    if(sig === menuSig) return;
    menuSig = sig;
    lastMenu = m;
    if(!m){ if(menuEl) menuEl.remove(); return; }
    if(!menuEl){
      menuEl = div('h-menu');
      menuEl.addEventListener('pointerdown', e => { if(e.target.closest('button')) e.preventDefault(); });
    }
    const stick = !menuEl.isConnected || bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 80;
    menuEl.replaceChildren();
    menuEl.classList.remove('busy');
    if(m.title) menuEl.appendChild(div('h-menu-q', m.title));
    const list = div('h-menu-list');
    let selBtn = null;
    m.items.forEach((lines, i) => {
      const btn = document.createElement('button');
      btn.className = 'h-opt' + (i === m.sel ? ' sel' : '');
      btn.textContent = lines[0];
      for(const sub of lines.slice(1)){
        const s = document.createElement('span');
        s.className = 'h-opt-sub';
        s.textContent = sub;
        btn.appendChild(s);
      }
      if(TEXT_OPT.test(lines[0])){
        // Opens a field; sending moves to the option, types the text, Enter.
        btn.classList.add('h-opt-text');
        btn.addEventListener('click', () => {
          const row = div('h-opt-input');
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = lines[0].replace(/^\d+[.)]\s+(\[.\]\s+)?/, '');
          const go = document.createElement('button');
          go.innerHTML = '&#10148;';
          go.title = 'Send';
          const send = () => { const t = inp.value.replace(/[\r\n]+/g, ' ').trim(); if(t) choose(i, t); };
          inp.addEventListener('keydown', e => { if(e.key === 'Enter' && !e.isComposing){ e.preventDefault(); send(); } });
          go.addEventListener('click', send);
          row.append(inp, go);
          btn.replaceWith(row);
          inp.focus();
        });
      } else btn.addEventListener('click', () => choose(i));
      if(i === m.sel) selBtn = btn;
      list.appendChild(btn);
    });
    menuEl.appendChild(list);
    const keys = div('h-menu-keys');
    const key = (label, title, seq) => {
      const k = document.createElement('button');
      k.innerHTML = label;
      k.title = title;
      k.addEventListener('click', () => pressKeys([seq]));
      keys.appendChild(k);
    };
    key('&#9650;', 'Up', '\x1b[A');
    key('&#9660;', 'Down', '\x1b[B');
    key('&#9664;', 'Left (previous question, or adjust)', '\x1b[D');
    key('&#9654;', 'Right (next question, or adjust)', '\x1b[C');
    key('Enter', 'Choose the highlighted option', '\r');
    key('Esc', 'Cancel', '\x1b');
    menuEl.appendChild(keys);
    if(m.hint) menuEl.appendChild(div('h-menu-hint', m.hint));
    if(menuEl.parentNode !== bodyEl) bodyEl.insertBefore(menuEl, inputBar);
    if(selBtn) list.scrollTop = selBtn.offsetTop - (list.clientHeight - selBtn.offsetHeight) / 2;
    if(stick) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // Keys go one per frame with a gap, so Claude reads each as its own keypress.
  function pressKeys(keys){
    const tab = openTab;
    if(!tab) return;
    if(!tab.ws || tab.ws.readyState !== 1){ statusEl.textContent = 'not connected'; return; }
    keys.forEach((k, i) => setTimeout(() => {
      if(tab.ws && tab.ws.readyState === 1) Connection.send(tab, k);
    }, i * 40));
  }

  // text: for a text option, typed once the option is highlighted.
  function choose(i, text){
    if(!lastMenu) return;
    const d = i - lastMenu.sel;
    const keys = new Array(Math.abs(d)).fill(d > 0 ? '\x1b[B' : '\x1b[A');
    if(text) keys.push(text);
    keys.push('\r');
    pressKeys(keys);
    if(menuEl) menuEl.classList.add('busy');
    setTimeout(() => { if(menuEl) menuEl.classList.remove('busy'); }, 1000);
  }

  // Typed into Claude's prompt like a paste (bracketed, so newlines don't
  // submit early), then Enter. Whatever #ta had already mirrored into the
  // prompt is erased first (one DEL per code point, as rewrite() would), so
  // half-typed terminal input doesn't get glued onto the message.
  function sendMessage(){
    const tab = openTab;
    const text = msgEl.value.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
    const st = tab && stateOf(tab);
    const files = (st && st.attach) || [];
    if(!tab || (!text && !files.length)) return;
    if(!tab.ws || tab.ws.readyState !== 1){ statusEl.textContent = 'not connected, message not sent'; return; }
    const pending = Array.from(window.sentText || '').length;
    if(pending) Connection.send(tab, '\x7f'.repeat(pending));
    const ta = document.getElementById('ta');
    if(ta) ta.value = '';
    window.sentText = '';
    // Each attachment is its own paste, as a terminal drop is, so Claude turns
    // an image path into an [Image #n] attachment; 40 ms apart so the pastes
    // stay separate. Then the text, then Enter a beat later so it isn't read
    // as part of the paste.
    const parts = files.map(p => quotePath(p) + ' ');
    if(text) parts.push(text);
    parts.forEach((p, i) => setTimeout(() => Connection.send(tab, '\x1b[200~' + p + '\x1b[201~'), i * 40));
    setTimeout(() => Connection.send(tab, '\r'), (parts.length - 1) * 40 + 80);
    st.attach = [];
    renderAttach();
    msgEl.value = '';
    growInput();
    bodyEl.scrollTop = bodyEl.scrollHeight;
    // Claude logs the message as soon as it takes it; show it without waiting a full poll.
    setTimeout(() => poll(false), 700);
  }

  function fitViewport(){
    if(!overlay || !openTab || !window.visualViewport) return;
    const top = overlay.getBoundingClientRect().top;
    const bottom = visualViewport.offsetTop + visualViewport.height;
    overlay.style.height = Math.max(120, bottom - top) + 'px';
    clampButtons();
  }

  // SCR buttons while open: page the history instead of the hidden terminal.
  function scrollPage(dir){
    bodyEl.scrollBy({ top: dir * Math.max(40, bodyEl.clientHeight - 60) });
  }

  // ●↑/●↓ while open: previous/next Claude reply that is the first after a user
  // message or the last before the next one (the end-of-turn summary); tool
  // calls between are fine. Relative to the viewport top (same stateless rule
  // as the terminal's jump buttons).
  function jump(dir){
    const top = bodyEl.scrollTop, base = bodyEl.getBoundingClientRect().top;
    const seq = Array.from(bodyEl.querySelectorAll('.h-user, .h-assistant'))
      .filter(el => !el.closest('.h-compact'));
    const isUser = el => !el || el.classList.contains('h-user');
    const marks = seq
      .filter((el, i) => !isUser(el) && (isUser(seq[i - 1]) || isUser(seq[i + 1])))
      .map(el => el.getBoundingClientRect().top - base + top - 8);
    const target = dir < 0 ? marks.filter(y => y < top - 2).pop()
                           : marks.find(y => y > top + 2);
    if(target === undefined){
      if(dir < 0) return false;
      bodyEl.scrollTop = bodyEl.scrollHeight;
      return true;
    }
    bodyEl.scrollTop = target;
    return true;
  }

  async function poll(first){
    const tab = openTab;
    if(!tab || document.hidden) return;
    const st = stateOf(tab);
    // Per tab: another tab's request still in flight mustn't delay this one.
    if(st.busy) return;
    st.busy = true;
    try{
      const url = '/api/transcript/' + encodeURIComponent(tab.sid) +
        '?from=' + st.offset + '&path=' + encodeURIComponent(st.path || '');
      const r = await fetch(url);
      if(openTab !== tab) return;
      if(r.status === 404){ st.el.dataset.empty = 'This session no longer exists on the server.'; return; }
      if(!r.ok){ statusEl.textContent = 'read failed, retrying'; return; }
      const d = await r.json();
      if(openTab !== tab) return;
      statusEl.textContent = '';
      if(!d.path){
        if(!st.path) st.el.dataset.empty = tab.kind === 'powershell'
          ? 'History is only available for Claude tabs.'
          : 'No Claude conversation found for this tab yet. It appears once Claude has written its first message.';
        return;
      }
      const stick = first || bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
      if(d.reset){ st.el.replaceChildren(); st.tools = {}; }
      st.path = d.path;
      st.sid = tab.sid;
      st.offset = d.offset;
      st.el.dataset.empty = 'This conversation has no messages yet.';
      // offset already moved past these, so one bad entry must not drop the rest.
      for(const it of d.items){ try{ render(st, it); }catch(err){ console.warn('history entry', it, err); } }
      if(stick) bodyEl.scrollTop = bodyEl.scrollHeight;
    }catch{
      if(openTab === tab) statusEl.textContent = 'offline, retrying';
    }finally{
      st.busy = false;
    }
  }

  function div(cls, text){
    const el = document.createElement('div');
    el.className = cls;
    if(text != null) el.textContent = text;
    return el;
  }

  function pre(cls, text){
    const el = document.createElement('pre');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function render(st, it){
    switch(it.k){
      case 'user': {
        st.el.appendChild(div('h-user', it.text || ''));
        break;
      }
      case 'assistant': {
        const el = div('h-assistant');
        el.innerHTML = markdown(it.text || '');
        st.el.appendChild(el);
        break;
      }
      // Slash and `!` commands are what the user typed, so they get the same bubble.
      case 'cmd': st.el.appendChild(div('h-user', it.text || '')); break;
      case 'out': st.el.appendChild(pre('h-out', it.text || '')); break;
      case 'note': st.el.appendChild(div('h-note', it.text || '')); break;
      // Thumbnail, full size in the file viewer on click. In a tool result it
      // goes in the call (the result follows), or a plain row if the call
      // isn't rendered; otherwise in the user's bubble (Claude logs the
      // "[Image #1]" text just before it), or its own.
      case 'image': {
        const at = String(it.img || '').split(':');
        const src = '/api/transcript/' + encodeURIComponent(st.sid) + '/image?path=' + encodeURIComponent(st.path) +
          '&at=' + encodeURIComponent(at[0]) + '&n=' + encodeURIComponent(at[1] || '0');
        const img = document.createElement('img');
        img.className = 'h-img';
        img.loading = 'lazy';
        img.alt = 'image';
        img.src = src;
        img.addEventListener('click', e => { e.preventDefault(); if(window.showImage) showImage(src, 'image'); });
        const owner = it.id && st.tools[it.id];
        let host = owner;
        // Not h-user: jump() would count a tool's image as a user prompt.
        if(!host && it.id) host = st.el.appendChild(div('h-media'));
        if(!host){
          const last = st.el.lastElementChild;
          host = last && last.classList.contains('h-user') ? last : st.el.appendChild(div('h-user'));
        }
        host.appendChild(img);
        break;
      }
      case 'compact': {
        const d = document.createElement('details');
        d.className = 'h-compact';
        const s = document.createElement('summary');
        s.textContent = 'Summary of earlier conversation';
        const b = div('h-assistant');
        b.innerHTML = markdown(it.text || '');
        d.append(s, b);
        st.el.appendChild(d);
        break;
      }
      case 'tool': {
        const d = document.createElement('details');
        d.className = 'h-tool';
        const s = document.createElement('summary');
        const name = document.createElement('b');
        name.textContent = it.name || 'tool';
        s.appendChild(name);
        if(it.arg) s.appendChild(document.createTextNode(' ' + it.arg));
        d.appendChild(s);
        if(it.text) d.appendChild(pre('h-input', it.text));
        st.el.appendChild(d);
        if(it.id) st.tools[it.id] = d;
        break;
      }
      case 'result': {
        const res = pre('h-result' + (it.err ? ' err' : ''), it.text || '(no output)');
        const owner = it.id && st.tools[it.id];
        if(owner){
          owner.appendChild(res);
          if(it.err) owner.classList.add('err');
          delete st.tools[it.id];
        } else {
          const d = document.createElement('details');
          d.className = 'h-tool' + (it.err ? ' err' : '');
          const s = document.createElement('summary');
          s.textContent = 'Tool result';
          d.append(s, res);
          st.el.appendChild(d);
        }
        break;
      }
    }
  }

  // Minimal markdown for Claude's replies: fenced code, headings, lists,
  // quotes, tables, rules, and inline code/bold/italic/links. All text is
  // escaped first; only tags generated here reach innerHTML.
  function esc(s){
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(s){
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[+i]) + '</code>');
  }

  function cells(line){
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inline(c.trim()));
  }

  function markdown(src){
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => { if(para.length){ out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    for(let i = 0; i < lines.length; i++){
      const line = lines[i];
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
      if(fence){
        flush();
        const code = [];
        for(i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
        out.push('<pre class="h-code"><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if(!line.trim()){ flush(); continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if(h){ flush(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
      if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)){ flush(); out.push('<hr>'); continue; }
      if(/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])){
        flush();
        let t = '<div class="h-table"><table><thead><tr>' + cells(line).map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
        for(i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++)
          t += '<tr>' + cells(lines[i]).map(c => '<td>' + c + '</td>').join('') + '</tr>';
        i--;
        out.push(t + '</tbody></table></div>');
        continue;
      }
      if(/^\s*>/.test(line)){
        flush();
        const q = [];
        for(; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
        i--;
        out.push('<blockquote>' + markdown(q.join('\n')) + '</blockquote>');
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if(li){
        flush();
        const ordered = /\d/.test(li[2]);
        let l = ordered ? '<ol>' : '<ul>';
        for(; i < lines.length; i++){
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if(m && /\d/.test(m[2]) !== ordered && !m[1].length) break;   // bullets <-> numbers: new list
          if(m){
            l +='<li' + (m[1].length >= 2 ? ' class="h-sub"' : '') + '>' + inline(m[3]) + '</li>';
          } else if(lines[i].trim() && /^\s{2,}/.test(lines[i])){
            l = l.replace(/<\/li>$/, '<br>' + inline(lines[i].trim()) + '</li>');
          } else break;
        }
        i--;
        out.push(l + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      para.push(line);
    }
    flush();
    return out.join('');
  }

  return { toggle, restore, hide, isOpen, focus, attach, key, insert, scrollPage, jump, togglePin, isPinned };
})();
