const games = {
  netcraft: { title: 'Netcraft', url: '/games/netcraft/craftw.html' },
  pk2: { title: 'Pekka Kana 2', url: '/games/pk2/index.html' },
};

export function setupGames($, { claimBeer, translate }) {
  const dialog = $('game-dialog');
  const frame = $('game-frame');
  let generation = 0;
  let activeGame = null;
  let minimized = false;
  const restore = () => {
    minimized = false;
    $('game-restore').hidden = true;
    if (!dialog.open) dialog.showModal();
  };
  for (const [id, game] of Object.entries(games)) {
    const open = async () => {
      if ((dialog.open || minimized) && activeGame === id) {
        generation++;
        $('game-dialog-status').textContent = '';
        if (minimized) restore();
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
        frame.src = game.url;
        activeGame = id;
        frame.classList.add('game-shift-in');
        for (const key of Object.keys(games)) {
          $(`switch-${key}`).setAttribute('aria-pressed', String(key === id));
        }
        if (!dialog.open) restore();
      } catch (error) {
        if (request === generation) status.textContent = error.message;
      }
    };
    $(`game-${id}`).addEventListener('click', open);
    $(`switch-${id}`).addEventListener('click', open);
  }
  $('game-minimize').addEventListener('click', () => {
    minimized = true;
    $('game-restore').hidden = false;
    dialog.close();
  });
  $('game-restore').addEventListener('click', restore);
  $('game-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (minimized) return;
    generation++;
    activeGame = null;
    frame.removeAttribute('src');
    $('game-dialog-status').textContent = '';
    for (const key of Object.keys(games)) $(`switch-${key}`).setAttribute('aria-pressed', 'false');
  });
  $('game-beer').addEventListener('click', claimBeer);
}
