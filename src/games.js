const games = {
  netcraft: { title: 'Netcraft', url: '/games/netcraft/craftw.html' },
  pk2: { title: 'Pekka Kana 2', url: '/games/pk2/index.html' },
};
const netcraftServer = import.meta.env?.VITE_NETCRAFT_WS_URL || '-';

export function setupGames($, { claimBeer, translate, getRewardAddress = () => null }) {
  const dialog = $('game-dialog');
  const frame = $('game-frame');
  const stage = $('game-stage');
  let generation = 0;
  let activeGame = null;
  for (const [id, game] of Object.entries(games)) {
    const open = async () => {
      if (dialog.open && activeGame === id) {
        generation++;
        $('game-dialog-status').textContent = '';
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
        $('game-title').textContent = game.title;
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
        frame.classList.add('game-shift-in');
        for (const key of Object.keys(games)) {
          $(`switch-${key}`).setAttribute('aria-pressed', String(key === id));
        }
        if (!dialog.open) dialog.showModal();
      } catch (error) {
        if (request === generation) status.textContent = error.message;
      }
    };
    $(`game-${id}`).addEventListener('click', open);
    $(`switch-${id}`).addEventListener('click', open);
  }
  $('game-close').addEventListener('click', () => dialog.close());
  $('game-wallet').addEventListener('click', () => $('connection-open').click());
  $('game-notifications').addEventListener('click', () => $('notifications-toggle').click());
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
      else await stage.requestFullscreen();
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
  $('game-beer').addEventListener('click', claimBeer);
}
