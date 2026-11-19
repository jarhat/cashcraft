export function setupBrowserWallet($, { network, canConnect, onConnect }) {
  const storageKey = `cashcraft:browser-wallet:v1:${network}`;
  let mode = '';
  let pendingPhrase = '';
  let busy = false;
  let generation = 0;
  let walletModule;

  const load = async () => {
    walletModule ||= await import('./browser-wallet.js');
    return walletModule;
  };
  const saved = () => localStorage.getItem(storageKey);
  const status = (text) => { $('browser-wallet-status').textContent = text; };
  const reset = () => {
    generation++;
    mode = '';
    pendingPhrase = '';
    for (const id of ['browser-wallet-phrase', 'browser-wallet-confirm', 'browser-wallet-password', 'browser-wallet-password-confirm']) {
      $(id).value = '';
    }
    $('browser-wallet-form').hidden = true;
    $('browser-wallet-copy').hidden = true;
  };
  const refresh = () => {
    let exists;
    try {
      exists = saved() !== null;
    } catch {
      for (const id of ['create', 'restore', 'unlock', 'backup', 'remove']) $(`browser-wallet-${id}`).disabled = true;
      status('Browser storage is unavailable. The browser wallet cannot be used.');
      return;
    }
    const available = canConnect();
    $('browser-wallet-create').hidden = exists;
    $('browser-wallet-restore').hidden = exists;
    $('browser-wallet-unlock').hidden = !exists;
    $('browser-wallet-backup').hidden = !exists;
    $('browser-wallet-remove').hidden = !exists;
    for (const id of ['browser-wallet-create', 'browser-wallet-restore', 'browser-wallet-unlock', 'browser-wallet-remove']) {
      $(id).disabled = !available || busy;
    }
    $('browser-wallet-backup').disabled = busy;
  };
  const start = async (nextMode) => {
    reset();
    status('');
    if (busy) return;
    if (nextMode !== 'backup' && !canConnect()) {
      status('Disconnect the current wallet or finish pairing first.');
      return;
    }
    const exists = saved() !== null;
    if ((nextMode === 'create' || nextMode === 'restore') === exists) {
      status(exists ? 'Remove the existing local wallet before creating or restoring another.' : 'No encrypted browser wallet was found.');
      refresh();
      return;
    }
    const current = generation;
    mode = nextMode;
    $('browser-wallet-form').hidden = false;
    $('browser-wallet-phrase-label').hidden = nextMode === 'unlock' || nextMode === 'backup';
    $('browser-wallet-confirm-label').hidden = nextMode !== 'create';
    $('browser-wallet-password-confirm-label').hidden = nextMode === 'unlock' || nextMode === 'backup';
    $('browser-wallet-password-label').hidden = false;
    $('browser-wallet-phrase').readOnly = nextMode !== 'restore';
    $('browser-wallet-password').autocomplete = nextMode === 'unlock' || nextMode === 'backup' ? 'current-password' : 'new-password';
    $('browser-wallet-submit').hidden = false;
    $('browser-wallet-submit').textContent = nextMode === 'backup' ? 'Reveal phrase' : nextMode === 'unlock' ? 'Unlock' : 'Save and connect';
    $('browser-wallet-instructions').textContent = {
      create: 'Write down these words offline, then re-enter them below. Copying places them on your clipboard.',
      restore: 'Enter your English BIP39 recovery phrase and choose a new password.',
      unlock: 'Enter the password for this browser wallet.',
      backup: 'Enter the password to reveal the recovery phrase. Keep it private.',
    }[nextMode];
    if (nextMode === 'create') {
      busy = true;
      refresh();
      try {
        const lib = await load();
        if (generation !== current) return;
        pendingPhrase = lib.generateBip39Mnemonic();
        $('browser-wallet-phrase').value = pendingPhrase;
        $('browser-wallet-copy').hidden = false;
      } catch (error) {
        reset();
        status(`Could not create wallet: ${error.message}`);
      } finally {
        busy = false;
        refresh();
      }
    }
  };

  for (const name of ['create', 'restore', 'unlock', 'backup']) {
    $(`browser-wallet-${name}`).addEventListener('click', () =>
      start(name).catch(() => status('Browser wallet setup could not start. Check browser storage.')));
  }
  $('browser-wallet-cancel').addEventListener('click', () => { reset(); status(''); refresh(); });
  $('connection-dialog').addEventListener('close', () => { reset(); status(''); refresh(); });
  $('browser-wallet-copy').addEventListener('click', async () => {
    try {
      if (!$('browser-wallet-phrase').value) throw new Error('No recovery phrase is visible.');
      await navigator.clipboard.writeText($('browser-wallet-phrase').value);
      status('Recovery phrase copied. Clear your clipboard after saving it securely.');
    } catch (error) {
      status(`Could not copy recovery phrase: ${error.message}`);
    }
  });
  $('browser-wallet-remove').addEventListener('click', () => {
    if (!canConnect()) return;
    if (!window.confirm('Remove this encrypted wallet from this browser? Without your recovery phrase, its funds may be permanently lost.')) return;
    if (window.prompt('Type DELETE to remove the encrypted local wallet.') !== 'DELETE') return;
    try {
      localStorage.removeItem(storageKey);
      reset();
      status('Local wallet removed. Restore it using its recovery phrase.');
      refresh();
    } catch (error) {
      status(`Could not remove local wallet: ${error.message}`);
    }
  });
  $('browser-wallet-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !mode) return;
    const current = generation;
    const action = mode;
    const password = $('browser-wallet-password').value;
    busy = true;
    $('browser-wallet-submit').disabled = true;
    status('');
    try {
      const lib = await load();
      let phrase;
      if (action === 'create' || action === 'restore') {
        if (!canConnect()) throw new Error('Disconnect the current wallet or finish pairing first.');
        if (saved() !== null) throw new Error('A browser wallet already exists; it was not replaced.');
        if (password !== $('browser-wallet-password-confirm').value) throw new Error('Passwords do not match.');
        phrase = lib.normalizeMnemonic(action === 'create' ? pendingPhrase : $('browser-wallet-phrase').value);
        if (action === 'create' && lib.normalizeMnemonic($('browser-wallet-confirm').value) !== phrase) {
          throw new Error('The recovery phrase confirmation does not match.');
        }
        const encrypted = await lib.encryptBrowserWallet(phrase, password, network);
        if (generation !== current) return;
        if (saved() !== null) throw new Error('A browser wallet already exists; it was not replaced.');
        localStorage.setItem(storageKey, encrypted);
      } else {
        const encrypted = saved();
        if (encrypted === null) throw new Error('No encrypted browser wallet was found.');
        phrase = await lib.decryptBrowserWallet(encrypted, password, network);
      }
      if (generation !== current) return;
      $('browser-wallet-password').value = '';
      $('browser-wallet-password-confirm').value = '';
      if (action === 'backup') {
        $('browser-wallet-phrase').value = phrase;
        $('browser-wallet-phrase-label').hidden = false;
        $('browser-wallet-copy').hidden = false;
        $('browser-wallet-password-label').hidden = true;
        $('browser-wallet-submit').hidden = true;
        status('Keep these words private. Anyone with them can spend your funds.');
      } else {
        if (!canConnect()) throw new Error('Wallet saved, but another wallet connected. Disconnect it and unlock this wallet.');
        await onConnect(phrase, () => generation === current);
        if (generation !== current) return;
        reset();
        status('Browser wallet connected.');
      }
    } catch (error) {
      status(error.message || 'Browser wallet operation failed.');
    } finally {
      busy = false;
      $('browser-wallet-submit').disabled = false;
      refresh();
    }
  });
  refresh();
  return refresh;
}
