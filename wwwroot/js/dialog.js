// In-page replacement for native confirm()/alert().
// Native dialogs can be permanently suppressed by the browser ("don't show
// again" checkbox), which silently breaks confirm-gated actions. These don't.
const Dialog = (() => {
  const overlay = document.getElementById('dialog-modal');
  const titleEl = document.getElementById('dialog-title');
  const msgEl = document.getElementById('dialog-message');
  const okBtn = document.getElementById('dialog-ok');
  const cancelBtn = document.getElementById('dialog-cancel');
  let resolver = null;

  function close(result){
    overlay.classList.remove('visible');
    document.removeEventListener('keydown', onKey);
    const r = resolver; resolver = null;
    if(r) r(result);
  }

  function onKey(e){
    if(e.key === 'Escape'){ e.preventDefault(); close(false); }
    else if(e.key === 'Enter'){ e.preventDefault(); close(true); }
  }

  function open({ title, message, okLabel, showCancel }){
    return new Promise(resolve => {
      // If a dialog is already open, resolve it falsy before reusing the modal.
      if(resolver) close(false);
      resolver = resolve;
      titleEl.textContent = title;
      msgEl.textContent = message;
      okBtn.textContent = okLabel;
      cancelBtn.style.display = showCancel ? '' : 'none';
      overlay.classList.add('visible');
      document.addEventListener('keydown', onKey);
      okBtn.focus();
    });
  }

  okBtn.addEventListener('click', () => close(true));
  cancelBtn.addEventListener('click', () => close(false));
  overlay.addEventListener('click', e => { if(e.target === overlay) close(false); });

  return {
    // Returns Promise<bool>: true = confirmed, false = cancelled/dismissed.
    confirm: (message, opts = {}) => open({
      title: opts.title || 'Confirm',
      message,
      okLabel: opts.okLabel || 'OK',
      showCancel: true,
    }),
    // Returns Promise<void> (resolves true) once dismissed.
    alert: (message, opts = {}) => open({
      title: opts.title || 'Notice',
      message,
      okLabel: opts.okLabel || 'OK',
      showCancel: false,
    }),
  };
})();
