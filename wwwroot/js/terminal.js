window.TerminalManager = (function(){
  function createContainer(tabId){
    const el = document.createElement('div');
    el.id = 'term-' + tabId;
    el.className = 'term-container';
    document.getElementById('terminals').appendChild(el);
    return el;
  }

  // Blend a hex color into black so the pane stays mostly black with a hue of
  // the project color. strength 0.08 subtle … 0.18 noticeable.
  function tintTheme(hex, strength){
    if(!hex || hex[0] !== '#' || hex.length < 7) return {};
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const m = v => Math.round(v * strength);
    return { background: `rgb(${m(r)},${m(g)},${m(b)})`, cursor: hex };
  }

  function createTerminal(containerEl, color){
    const term = new Terminal({
      fontSize: 14,
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      allowProposedApi: true,
      disableStdin: true,
      scrollback: 5000,
      smoothScrollDuration: 120,
      theme: tintTheme(color, 0.06)
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerEl);
    const coreEl = containerEl.querySelector('.xterm');
    if(coreEl){
      const refocus = () => setTimeout(() => document.getElementById('ta').focus(), 0);
      // Desktop: click anywhere in terminal focuses input.
      coreEl.addEventListener('mousedown', () => { if(window.inputEnabled !== false) refocus(); });
      // Mobile: only refocus on a genuine tap, never on a scroll/drag release.
      // Without this, lifting your thumb after scrolling up reopens the keyboard.
      let sx = 0, sy = 0, st = 0, moved = false;
      coreEl.addEventListener('touchstart', e => {
        const t = e.touches[0];
        if(t){ sx = t.clientX; sy = t.clientY; }
        st = Date.now(); moved = false;
      }, { passive: true });
      coreEl.addEventListener('touchmove', e => {
        const t = e.touches[0];
        if(t && (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8)) moved = true;
      }, { passive: true });
      coreEl.addEventListener('touchend', () => {
        if(window.inputEnabled === false) return;   // keyboard locked off
        if(moved || Date.now() - st > 500) return;   // was a scroll/long-press, not a tap
        refocus();
      });
    }
    return { term, fitAddon };
  }

  function destroyTerminal(term, containerEl){
    try { term.dispose(); } catch{}
    containerEl.remove();
  }

  return { createContainer, createTerminal, destroyTerminal };
})();
