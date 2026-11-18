const games = {
  netcraft: { title: 'CashCraft', url: '/games/netcraft/craftw.html' },
  pk2: { title: 'Pekka Kana 2', url: '/games/pk2/index.html' },
};
const netcraftServer = import.meta.env?.VITE_NETCRAFT_WS_URL || '-';

export function setupGames($, { translate, getRewardAddress = () => null, autoOpen = false }) {
  const dialog = $('game-dialog');
  const frame = $('game-frame');
  const stage = $('game-stage');
  const dock = $('game-minimized-controls');
  const restore = $('game-restore');
  const setPlayingUi = () => {
    const playing = dialog.open && !dialog.hidden;
    document.body.classList.toggle('cashcraft-playing', playing);
    dock.hidden = !dialog.open || !dialog.hidden || !activeGame;
  };
  document.querySelector('.topbar').after(dialog, dock);
  stage.addEventListener('contextmenu', (event) => event.preventDefault());
  let generation = 0;
  let activeGame = null;
  const updateRewardAddress = (address) => {
    const connected = Boolean(address);
    $('game-wallet').setAttribute('aria-label', connected ? 'Open wallet balances' : 'Connect wallet');
    $('game-wallet').setAttribute('title', connected ? 'Open wallet balances' : 'Connect wallet');
    $('game-wallet').setAttribute('aria-controls', connected ? 'earn-section' : 'connection-dialog');
    if (connected) $('game-wallet').removeAttribute('aria-haspopup');
    else $('game-wallet').setAttribute('aria-haspopup', 'dialog');
    if (activeGame) {
      const title = games[activeGame].title;
      $('game-restore').setAttribute('aria-label', `Resume ${title}`);
      $('game-restore').setAttribute('title', `Resume ${title}`);
      $('game-minimized-fullscreen').setAttribute('aria-label', `Resume ${title} in fullscreen`);
      $('game-minimized-fullscreen').setAttribute('title', `Resume ${title} in fullscreen`);
    }
    if (activeGame === 'netcraft') {
      frame.contentWindow?.postMessage({ type: 'netcraft-reward-address', address: address || '' }, '*');
    }
  };
  const overlayDialogs = ['connection-dialog', 'notifications-dialog', 'funding-dialog', 'wiki-dialog', 'invite-dialog'];
  const canFocusGame = () => dialog.open && !dialog.hidden && activeGame &&
    !overlayDialogs.some((id) => $(id).open);
  frame.addEventListener('load', () => {
    updateRewardAddress(getRewardAddress());
    if (canFocusGame() && [document.body, $('game-close'), $('game-fullscreen'),
      $('switch-netcraft'), $('switch-pk2'), frame].includes(document.activeElement)) {
      frame.focus({ preventScroll: true });
    }
  });
  for (const id of overlayDialogs) {
    $(id).addEventListener('close', () => {
      requestAnimationFrame(() => {
        if (canFocusGame() && [document.body, $('game-wallet'), $('game-notifications'), $('game-invite'), frame]
          .includes(document.activeElement)) frame.focus({ preventScroll: true });
      });
    });
  }
  for (const [id, game] of Object.entries(games)) {
    const open = async () => {
      if (dialog.open && activeGame === id) {
        generation++;
        $('game-dialog-status').textContent = '';
        dialog.hidden = false;
        setPlayingUi();
        return;
      }
      const request = ++generation;
      const status = dialog.open ? $('game-dialog-status') : $('game-status');
      status.textContent = translate('Loading game…');
      try {
        const response = await fetch(game.url, { cache: 'no-store' });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
          throw new Error(translate('Game build unavailable. Check the server mount.'));
        }
        if ((await response.text()).includes('id="game-netcraft"')) {
          throw new Error(translate('Game build unavailable. Check the server mount.'));
        }
        if (request !== generation) return;
        status.textContent = '';
        frame.title = game.title;
        frame.classList.remove('game-shift-in');
        void frame.offsetWidth;
        const address = id === 'netcraft' ? getRewardAddress() : null;
        if (id === 'netcraft' && (address || netcraftServer !== '-')) {
          const args = [netcraftServer, '4080'];
          if (address) args.push(address);
          frame.src = `${game.url}#${args.map(encodeURIComponent).join('+')}`;
        } else {
          frame.src = game.url;
        }
        activeGame = id;
        dialog.hidden = false;
        frame.classList.add('game-shift-in');
        for (const key of Object.keys(games)) {
          $(`switch-${key}`).setAttribute('aria-pressed', String(key === id));
        }
        if (!dialog.open) dialog.show();
        setPlayingUi();
      } catch (error) {
        if (request === generation) status.textContent = error.message;
      }
    };
    $(`game-${id}`).addEventListener('click', open);
    $(`switch-${id}`).addEventListener('click', open);
    if (id === 'netcraft' && autoOpen) {
      void open();
    }
  }
  const minimize = async () => {
    if (document.fullscreenElement === stage) {
      try {
        await document.exitFullscreen();
      } catch (error) {
        $('game-dialog-status').textContent = translate('Could not exit fullscreen.');
        return false;
      }
    }
    dialog.hidden = true;
    setPlayingUi();
    restore.focus({ preventScroll: true });
    return true;
  };
  $('game-close').addEventListener('click', minimize);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void minimize(); });
  restore.addEventListener('click', () => {
    dialog.hidden = false;
    setPlayingUi();
    frame.focus({ preventScroll: true });
  });
  $('game-minimized-fullscreen').addEventListener('click', async () => {
    if (!activeGame) return;
    dialog.hidden = false;
    setPlayingUi();
    try {
      await stage.requestFullscreen();
      frame.focus({ preventScroll: true });
    } catch (error) {
      $('game-dialog-status').textContent = translate('Fullscreen is unavailable.');
    }
  });
  $('game-wallet').addEventListener('click', async () => {
    if (!getRewardAddress()) {
      $('connection-open').click();
      return;
    }
    if (await minimize()) $('earn-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('game-notifications').addEventListener('click', () => $('notifications-toggle').click());
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === stage;
    stage.classList.toggle('is-fullscreen', active);
    dialog.classList.toggle('is-fullscreen', active);
    const label = translate(active ? 'Exit fullscreen' : 'Enter fullscreen');
    $('game-fullscreen').setAttribute('aria-pressed', String(active));
    $('game-fullscreen').setAttribute('aria-label', label);
    $('game-fullscreen').setAttribute('title', label);
  });
  $('game-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else {
        await stage.requestFullscreen();
        frame.focus();
      }
    } catch (error) {
      $('game-dialog-status').textContent = translate('Fullscreen is unavailable.');
    }
  });
  dialog.addEventListener('close', () => {
    if (document.fullscreenElement === stage) {
      document.exitFullscreen().catch((error) => {
        console.error('Could not exit fullscreen:', error);
      });
    }
    generation++;
    activeGame = null;
    setPlayingUi();
    frame.removeAttribute('src');
    $('game-dialog-status').textContent = '';
    for (const key of Object.keys(games)) $(`switch-${key}`).setAttribute('aria-pressed', 'false');
  });
  return updateRewardAddress;
}
