window.TerminalManager = (function(){
  function createContainer(tabId){
    const el = document.createElement('div');
    el.id = 'term-' + tabId;
    el.className = 'term-container';
    document.getElementById('terminals').appendChild(el);
    return el;
  }

  function createTerminal(containerEl){
    const term = new Terminal({
      fontSize: 14,
      cursorBlink: true,
      allowProposedApi: true,
      disableStdin: true,
      scrollback: 5000,
      smoothScrollDuration: 120
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerEl);
    return { term, fitAddon };
  }

  function destroyTerminal(term, containerEl){
    try { term.dispose(); } catch{}
    containerEl.remove();
  }

  return { createContainer, createTerminal, destroyTerminal };
})();
