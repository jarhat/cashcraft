import { getGameGuestId } from './game-identity.js';

const games = {
  netcraft: { title: 'CashCraft', url: '/games/netcraft/craftw.html' },
  pk2: { title: 'Pekka Kana 2', url: '/games/pk2/index.html' },
};
const netcraftServer = import.meta.env?.VITE_NETCRAFT_WS_URL || '-';

export function setupGames($, { translate, getRewardAddress = () => null, isWalletConnected = null, hasMinaPickaxe = () => false, getGuestId = getGameGuestId, autoOpen = false, autoOpenGame = 'netcraft' }) {
  const dialog = $('game-dialog');
  const frame = $('game-frame');
  const stage = $('game-stage');
  const dock = $('game-minimized-controls');
  const restore = $('game-restore');
  const guide = $('game-guide');
  const sound = $('game-sound');
  const prompt = $('mining-prompt');
  const toolbar = document.querySelector('.game-toolbar');
  const setPlayingUi = () => {
    const playing = dialog.open && !dialog.hidden;
    document.body.classList.toggle('cashcraft-playing', playing);
    dock.hidden = !dialog.open || !dialog.hidden || !activeGame;
  };
  toolbar.after(dialog);
  stage.addEventListener('contextmenu', (event) => event.preventDefault());
  let generation = 0;
  let activeGame = null;
  let guideShown = false;
  let reopenGuide = false;
  let reopenPrompt = false;
  const reopenOverlays = () => {
    if (reopenGuide && !guide.open) guide.show();
    if (reopenPrompt && !prompt.open) prompt.show();
    reopenGuide = reopenPrompt = false;
  };
  let guestId = null;
  let guestUnlocked = null;
  let firstBlockShown = false;
  let soundEnabled = true;
  const updateRewardAddress = (address) => {
    const connected = isWalletConnected ? isWalletConnected() : Boolean(address);
    const gemLabel = connected ? 'Wallet and notifications' : 'Connect wallet';
    $('game-notifications').setAttribute('aria-label', translate(gemLabel));
    $('game-notifications').setAttribute('title', translate(gemLabel));
    $('game-notifications').setAttribute('aria-controls', connected ? 'notifications-dialog' : 'connection-dialog');
    $('game-guide-wallet').textContent = translate(connected ? 'Wallet and notifications' : 'Connect wallet');
    $('game-ranking').hidden = activeGame !== 'netcraft';
    if (activeGame) {
      const title = games[activeGame].title;
      $('game-restore').setAttribute('aria-label', `Resume ${title}`);
      $('game-restore').setAttribute('title', `Resume ${title}`);
      $('game-minimized-fullscreen').setAttribute('aria-label', `Resume ${title} in fullscreen`);
      $('game-minimized-fullscreen').setAttribute('title', `Resume ${title} in fullscreen`);
    }
    if (activeGame === 'netcraft') {
      frame.contentWindow?.postMessage({ type: 'netcraft-reward-address', address: address || '', pickaxe: connected && hasMinaPickaxe(), connected, guestId, embeddedSound: true }, '*');
    }
  };
  const overlayDialogs = ['connection-dialog', 'notifications-dialog', 'funding-dialog', 'wiki-dialog', 'invite-dialog', 'ranking-dialog', 'game-guide', 'mining-prompt'];
  const canFocusGame = () => dialog.open && !dialog.hidden && activeGame &&
    !overlayDialogs.some((id) => $(id).open);
  frame.addEventListener('load', () => {
    if (activeGame) document.documentElement.classList.remove('game-link-loading');
    updateRewardAddress(getRewardAddress());
    if (canFocusGame() && [document.body, $('game-close'), $('game-fullscreen'),
      $('switch-netcraft'), $('switch-pk2'), frame].includes(document.activeElement)) {
      frame.focus({ preventScroll: true });
    }
  });
  for (const id of overlayDialogs) {
    $(id).addEventListener('close', () => {
      requestAnimationFrame(() => {
        if (canFocusGame() && [document.body, $('game-notifications'), $('game-invite'), frame]
          .includes(document.activeElement)) frame.focus({ preventScroll: true });
      });
    });
  }
  const openGame = async (id) => {
      const game = games[id];
      $('games-menu').hidden = true;
      $('games-toggle').setAttribute('aria-expanded', 'false');
      if (dialog.open && activeGame === id) {
        generation++;
        $('game-dialog-status').textContent = '';
        dialog.hidden = false;
        reopenOverlays();
        setPlayingUi();
        return;
      }
      const request = ++generation;
      const status = dialog.open ? $('game-dialog-status') : $('game-status');
      status.textContent = translate('Loading game…');
      try {
        if (id === 'netcraft' && !guestId) guestId = getGuestId();
        const response = await fetch(game.url, { cache: 'no-cache' });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
          throw new Error(translate('Game build unavailable. Check the server mount.'));
        }
        if ((await response.text()).includes('id="game-netcraft"')) {
          throw new Error(translate('Game build unavailable. Check the server mount.'));
        }
        if (request !== generation) return;
        if (guide.open) guide.close();
        sound.hidden = true;
        status.textContent = '';
        frame.title = game.title;
        frame.classList.remove('game-shift-in');
        void frame.offsetWidth;
        const address = id === 'netcraft' ? getRewardAddress() : null;
        if (id === 'netcraft') {
          const args = [netcraftServer, '4080'];
          if (address) args.push(address);
          frame.src = `${game.url}#${args.map(encodeURIComponent).join('+')}`;
        } else {
          frame.src = game.url;
        }
        activeGame = id;
        updateRewardAddress(getRewardAddress());
        dialog.hidden = false;
        frame.classList.add('game-shift-in');
        for (const key of Object.keys(games)) {
          $(`switch-${key}`).setAttribute('aria-pressed', String(key === id));
        }
        if (!dialog.open) dialog.show();
        setPlayingUi();
        if (id === 'netcraft' && !guideShown) {
          guideShown = true;
          guide.show();
        }
      } catch (error) {
        if (request === generation) {
          document.documentElement.classList.remove('game-link-loading');
          status.textContent = error.message;
        }
      }
  };
  for (const id of Object.keys(games)) {
    const open = () => openGame(id);
    $(`game-${id}`).addEventListener('click', open);
    $(`switch-${id}`).addEventListener('click', open);
    if (id === autoOpenGame && autoOpen) {
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
    reopenGuide = guide.open;
    reopenPrompt = prompt.open;
    guide.close();
    prompt.close();
    dialog.hidden = true;
    setPlayingUi();
    restore.focus({ preventScroll: true });
    return true;
  };
  $('game-close').addEventListener('click', minimize);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void minimize(); });
  restore.addEventListener('click', () => {
    dialog.hidden = false;
    reopenOverlays();
    setPlayingUi();
    frame.focus({ preventScroll: true });
  });
  $('game-minimized-fullscreen').addEventListener('click', async () => {
    if (!activeGame) return;
    dialog.hidden = false;
    reopenOverlays();
    setPlayingUi();
    try {
      await stage.requestFullscreen();
      frame.focus({ preventScroll: true });
    } catch (error) {
      $('game-dialog-status').textContent = translate('Fullscreen is unavailable.');
    }
  });
  const openWallet = () => {
    const connected = isWalletConnected ? isWalletConnected() : Boolean(getRewardAddress());
    const overlay = $(connected ? 'notifications-dialog' : 'connection-dialog');
    if (document.fullscreenElement === stage) {
      const parent = overlay.parentNode;
      const next = overlay.nextSibling;
      stage.appendChild(overlay);
      overlay.addEventListener('close', () => parent.insertBefore(overlay, next), { once: true });
    }
    $(connected ? 'notifications-toggle' : 'connection-open').click();
  };
  $('game-notifications').addEventListener('click', openWallet);
  sound.addEventListener('click', () => {
    if (activeGame !== 'netcraft' || sound.hidden) return;
    soundEnabled = !soundEnabled;
    sound.setAttribute('aria-pressed', String(soundEnabled));
    frame.contentWindow?.postMessage({ type: 'netcraft-set-sound', enabled: soundEnabled }, '*');
  });
  $('game-guide-open').addEventListener('click', () => { if (!guide.open) guide.show(); });
  $('game-guide-wallet').addEventListener('click', () => {
    openWallet();
  });
  $('mining-prompt-wallet').addEventListener('click', () => {
    prompt.close();
    openWallet();
  });
  for (const id of ['mining-prompt-close', 'mining-prompt-later']) {
    $(id).addEventListener('click', () => prompt.close());
  }
  for (const id of ['game-guide-close', 'game-guide-done']) {
    $(id).addEventListener('click', () => guide.close());
  }
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || activeGame !== 'netcraft') return;
    if (event.data?.type === 'netcraft-sound-state' && typeof event.data.enabled === 'boolean') {
      soundEnabled = event.data.enabled;
      sound.setAttribute('aria-pressed', String(soundEnabled));
      sound.hidden = false;
      return;
    }
    const connected = isWalletConnected ? isWalletConnected() : Boolean(getRewardAddress());
    if (event.data?.type === 'netcraft-block-mined' && !firstBlockShown) {
      firstBlockShown = true;
      if (!connected) {
        $('mining-prompt-title').textContent = translate('First block mined!');
        $('mining-prompt-message').textContent = translate('Next, find green MINA ore and mine 10 natural blocks to earn 1 MINA.');
        if (!prompt.open) prompt.show();
      }
      return;
    }
    if (
        event.data?.type !== 'netcraft-mining-progress' ||
        !Number.isInteger(event.data.blocks) || event.data.blocks < 0 || event.data.blocks > 9 ||
        typeof event.data.unlocked !== 'boolean') return;
    $('game-guide-progress').textContent = `${translate('MINA ore progress')}: ${event.data.blocks} / 10` +
      (event.data.unlocked ? ` · ${translate(connected ? 'MINA pickaxe unlocked' : 'Connect a wallet to equip your pickaxe')}` : '');
    if (guestUnlocked === false && event.data.unlocked && !connected) {
      $('mining-prompt-title').textContent = translate('1 MINA earned!');
      $('mining-prompt-message').textContent = translate('Next, connect a wallet to receive your reward and equip your green pickaxe.');
      if (!prompt.open) prompt.show();
    }
    guestUnlocked = event.data.unlocked;
  });
  $('game-invite').addEventListener('click', () => {
    const overlay = $('invite-dialog');
    if (document.fullscreenElement === stage && !overlay.open) {
      const parent = overlay.parentNode;
      const next = overlay.nextSibling;
      stage.appendChild(overlay);
      overlay.addEventListener('close', () => parent.insertBefore(overlay, next), { once: true });
    }
  });
  $('game-ranking').addEventListener('click', async () => {
    if (activeGame !== 'netcraft') return;
    const overlay = $('ranking-dialog');
    if (document.fullscreenElement === stage && !overlay.open) {
      const parent = overlay.parentNode;
      const next = overlay.nextSibling;
      stage.appendChild(overlay);
      overlay.addEventListener('close', () => parent.insertBefore(overlay, next), { once: true });
    }
    if (!overlay.open) overlay.showModal();
    const status = $('ranking-status');
    const list = $('ranking-list');
    list.replaceChildren();
    status.textContent = 'Loading ranking…';
    try {
      const response = await fetch('/api/mina-ranking', { cache: 'no-store' });
      if (!response.ok) throw new Error('Ranking is unavailable. Please try again.');
      const data = await response.json();
      if (!Array.isArray(data.players) || data.players.some((player) =>
        typeof player.name !== 'string' || !Number.isSafeInteger(player.rewards) || player.rewards < 1)) {
        throw new Error('Ranking data is invalid.');
      }
      const max = data.players[0]?.rewards || 1;
      for (const player of data.players) {
        const row = document.createElement('li');
        const label = document.createElement('span');
        const value = document.createElement('strong');
        const bar = document.createElement('span');
        label.textContent = player.name;
        value.textContent = `${player.rewards} MINA`;
        bar.className = 'ranking-bar';
        bar.style.width = `${player.rewards / max * 100}%`;
        bar.setAttribute('aria-hidden', 'true');
        row.append(label, value, bar);
        list.append(row);
      }
      status.textContent = data.players.length ? '' : 'No mining rewards have been sent yet.';
    } catch (error) {
      status.textContent = error.message || 'Ranking is unavailable. Please try again.';
    }
  });
  $('ranking-close').addEventListener('click', () => $('ranking-dialog').close());
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === stage;
    stage.classList.toggle('is-fullscreen', active);
    dialog.classList.toggle('is-fullscreen', active);
    setPlayingUi();
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
