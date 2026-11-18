const games = {
  netcraft: { title: 'CashCraft', url: '/games/netcraft/craftw.html' },
  pk2: { title: 'Pekka Kana 2', url: '/games/pk2/index.html' },
};
const netcraftServer = import.meta.env?.VITE_NETCRAFT_WS_URL || '-';

export function setupGames($, { translate, getRewardAddress = () => null, autoOpen = false }) {
  const dialog = $('game-dialog');
  const frame = $('game-frame');
  const stage = $('game-stage');
  const restore = $('game-restore');
  document.querySelector('.topbar').after(dialog, restore);
  stage.addEventListener('contextmenu', (event) => event.preventDefault());
  let generation = 0;
  let activeGame = null;
  const updateRewardAddress = (address) => {
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
        if (canFocusGame() && [document.body, $('game-wallet'), $('game-invite'), frame]
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
        restore.hidden = true;
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
        restore.hidden = true;
        frame.classList.add('game-shift-in');
        for (const key of Object.keys(games)) {
          $(`switch-${key}`).setAttribute('aria-pressed', String(key === id));
        }
        if (!dialog.open) dialog.show();
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
    restore.hidden = false;
    restore.focus({ preventScroll: true });
    return true;
  };
  $('game-close').addEventListener('click', minimize);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void minimize(); });
  restore.addEventListener('click', () => {
    dialog.hidden = false;
    restore.hidden = true;
    frame.focus({ preventScroll: true });
  });
  $('game-wallet').addEventListener('click', async () => {
    if (!getRewardAddress()) {
      $('connection-open').click();
      return;
    }
    if (await minimize()) $('earn-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('game-invite-fullscreen').addEventListener('click', () => $('game-invite').click());
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === stage;
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
    frame.removeAttribute('src');
    $('game-dialog-status').textContent = '';
    for (const key of Object.keys(games)) $(`switch-${key}`).setAttribute('aria-pressed', 'false');
  });
  return updateRewardAddress;
}
