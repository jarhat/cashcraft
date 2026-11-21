import { getGameGuestId } from './game-identity.js';

const games = {
  netcraft: { title: 'CashCraft', url: '/games/netcraft/craftw.html' },
  pk2: { title: 'Pekka Kana 2', url: '/games/pk2/index.html' },
};
const netcraftServer = import.meta.env?.VITE_NETCRAFT_WS_URL || '-';

export function setupGames($, { translate, getRewardAddress = () => null, isWalletConnected = null, hasMinaPickaxe = () => false, getGuestId = getGameGuestId, openPlayerTransfer, autoOpen = false, autoOpenGame = 'netcraft' }) {
  const dialog = $('game-dialog');
  const frame = $('game-frame');
  const stage = $('game-stage');
  const dock = $('game-minimized-controls');
  const restore = $('game-restore');
  const guide = $('game-guide');
  const sound = $('game-sound');
  const prompt = $('mining-prompt');
  const toolbar = document.querySelector('.game-toolbar');
  const controls = $('game-controls-right');
  const controlsHome = controls.parentNode || toolbar;
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
  let lastProgress = null;
  let earnedRewards = null;
  let firstBlockShown = false;
  let oreOverviewVisible = false;
  let oreCounts = [0, 0, 0];
  const ores = [
    ['green', 'MINA ore'],
    ['blue', 'Lapis ore'],
    ['red', 'Redstone ore'],
  ];
  let wizardTimer;
  let tutorialStep = 0;
  let tutorialActive = false;
  const tutorialTips = [
    'Use WASD to move, space to jump, left click to mine and right click to build. On mobile, use the joystick and the jump, mine and build buttons. Scroll to choose blocks.',
    'Mine 10 natural blocks of the same ore to earn one token of its type when rewards are configured. Your progress appears above your hearts.',
    'The gem opens your wallet and notifications. Connect a wallet to receive your mining rewards.',
    'Invite shares the game; Ranking shows ores mined; fullscreen expands the game; sound toggles audio.',
    'After earning 2 MINA, use the crafting table to review a 2 MINA payment for a permanent MINA pickaxe.',
  ];
  const controlTips = {
    'game-close': 'Minimize the game; use the game icon to return.',
    'game-crafting': 'Craft a permanent MINA pickaxe for 2 MINA.',
    'game-ranking': 'Ranking shows ores mined.',
    'game-send': 'Send tokens to an online player by name.',
    'game-receive': 'Create a MINA payment request.',
    'game-invite': 'Invite shares the game.',
    'game-sound': 'Sound toggles audio.',
    'game-notifications': 'The gem opens your wallet and notifications.',
    'game-fullscreen': 'Fullscreen expands the game.',
    'mobile-stick': 'Drag the joystick to move.',
    'mobile-mine': 'Hold the pickaxe button to mine the block you are looking at.',
    'mobile-build': 'Hold the block button to build.',
    'mobile-jump': 'Use jump to leap or swim upward.',
    'block-scroll-strip': 'Drag the strip to choose a block.',
  };
  function renderOreBars(container, counts, max, showGoal) {
    container.replaceChildren();
    for (const [index, [color, name]] of ores.entries()) {
      const label = document.createElement('label');
      const bar = document.createElement('progress');
      label.textContent = `${translate(name)}: ${counts[index]}${showGoal ? `/${max}` : ''}`;
      bar.className = `ore-bar ore-${color}`;
      bar.max = max;
      bar.value = counts[index];
      label.append(bar);
      container.append(label);
    }
  }

  function showWizard(message, overview = false) {
    const bubble = $('game-wizard-speech');
    const bars = $('game-wizard-ores');
    clearTimeout(wizardTimer);
    bubble.hidden = true;
    oreOverviewVisible = overview;
    bars.hidden = !overview;
    if (overview) renderOreBars(bars, oreCounts, 10, true);
    $('game-wizard-message').textContent = translate(message);
    void bubble.offsetWidth;
    bubble.hidden = false;
    wizardTimer = setTimeout(() => {
      bubble.hidden = true;
      oreOverviewVisible = false;
    }, 6000);
  }
  for (const [id, message] of Object.entries(controlTips).filter(([id]) => id.startsWith('game-'))) {
    for (const event of ['focus', 'mouseenter']) {
      $(id).addEventListener(event, () => { if (tutorialActive) showWizard(message); });
    }
  }
  let soundEnabled = true;
  const updateRewardAddress = (address) => {
    const connected = isWalletConnected ? isWalletConnected() : Boolean(address);
    const gemLabel = connected ? 'Wallet and notifications' : 'Connect wallet';
    $('game-notifications').setAttribute('aria-label', translate(gemLabel));
    $('game-notifications').setAttribute('title', translate(gemLabel));
    $('game-notifications').setAttribute('aria-controls', connected ? 'notifications-dialog' : 'connection-dialog');
    $('game-guide-wallet').textContent = translate(connected ? 'Wallet and notifications' : 'Connect wallet');
    $('game-ranking').hidden = activeGame !== 'netcraft';
    $('game-send').hidden = $('game-receive').hidden = activeGame !== 'netcraft';
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
          showWizard(tutorialTips[0]);
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
  const openTransfer = async (target) => {
    if (!openPlayerTransfer || dialog.hidden || activeGame !== 'netcraft') return;
    document.exitPointerLock?.();
    const session = generation;
    if (!await minimize() || session !== generation) return;
    await openPlayerTransfer(target, (popup, show) => {
      if (session !== generation || activeGame !== 'netcraft' || !dialog.open) return false;
      restore.click();
      const home = popup.parentNode;
      const next = popup.nextSibling;
      stage.appendChild(popup);
      popup.addEventListener('close', () => home.insertBefore(popup, next), { once: true });
      show();
      return true;
    });
  };
  $('game-receive').addEventListener('click', () => openTransfer(null));
  $('game-send').addEventListener('click', () => {
    if (dialog.hidden || activeGame !== 'netcraft') return;
    document.exitPointerLock?.();
    const prompt = $('game-send-dialog');
    if (!prompt.open) prompt.showModal();
    $('game-send-name').focus();
  });
  $('game-send-cancel').addEventListener('click', () => $('game-send-dialog').close());
  $('game-send-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (dialog.hidden || activeGame !== 'netcraft') return;
    const name = $('game-send-name').value.trim();
    if (!/^[A-Za-z0-9_]{1,24}$/.test(name)) return;
    $('game-send-dialog').close();
    frame.contentWindow?.postMessage({ type: 'netcraft-send-to-player', name }, '*');
    frame.focus();
  });
  sound.addEventListener('click', () => {
    if (activeGame !== 'netcraft' || sound.hidden) return;
    soundEnabled = !soundEnabled;
    sound.setAttribute('aria-pressed', String(soundEnabled));
    frame.contentWindow?.postMessage({ type: 'netcraft-set-sound', enabled: soundEnabled }, '*');
  });
  $('game-guide-open').addEventListener('click', () => {
    tutorialActive = true;
    showWizard(tutorialTips[tutorialStep]);
    tutorialStep = (tutorialStep + 1) % tutorialTips.length;
  });
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
  window.addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow || activeGame !== 'netcraft') return;
    if (event.data?.type === 'netcraft-wallet-send' || event.data?.type === 'netcraft-wallet-receive') {
      if (!openPlayerTransfer || dialog.hidden) return;
      const send = event.data.type === 'netcraft-wallet-send';
      const { name, address } = event.data;
      if (send && (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,24}$/.test(name) ||
          typeof address !== 'string' || !/^[a-z0-9:]{1,120}$/.test(address))) {
        $('game-dialog-status').textContent = translate('Invalid player receive address.');
        return;
      }
      await openTransfer(send ? { name, address } : null);
      return;
    }
    if (event.data?.type === 'netcraft-sound-state' && typeof event.data.enabled === 'boolean') {
      soundEnabled = event.data.enabled;
      sound.setAttribute('aria-pressed', String(soundEnabled));
      sound.hidden = false;
      return;
    }
    if (event.data?.type === 'netcraft-tutorial-control' && tutorialActive &&
        Object.hasOwn(controlTips, event.data.control) && !event.data.control.startsWith('game-')) {
      showWizard(controlTips[event.data.control]);
      return;
    }
    const connected = isWalletConnected ? isWalletConnected() : Boolean(getRewardAddress());
    if (event.data?.type === 'netcraft-ore-progress' &&
        Array.isArray(event.data.counts) && event.data.counts.length === 3 &&
        event.data.counts.every(count => Number.isInteger(count) && count >= 0 && count < 10)) {
      oreCounts = event.data.counts;
      if (oreOverviewVisible) renderOreBars($('game-wizard-ores'), oreCounts, 10, true);
      return;
    }
    if (event.data?.type === 'netcraft-block-mined' && !firstBlockShown &&
        Number.isInteger(event.data.block) && event.data.block > 0 &&
        ![49, 70, 73, 83].includes(event.data.block)) {
      firstBlockShown = true;
      showWizard('Mine 10 natural blocks of one ore for its token when rewards are configured. Look deep for blue ore; red is the rarest.', true);
      return;
    }
    if (event.data?.type === 'netcraft-mina-earned' &&
        Number.isSafeInteger(event.data.rewards) && event.data.rewards >= 0) {
      $('game-crafting').hidden = event.data.rewards < 2;
      if (!oreOverviewVisible && event.data.rewards >= 2 && earnedRewards !== null && earnedRewards < 2) {
        showWizard('You earned 2 MINA! Use the crafting table to review a payment for your pickaxe.');
      }
      earnedRewards = event.data.rewards;
      return;
    }
    if (
        event.data?.type !== 'netcraft-mining-progress' ||
        !Number.isInteger(event.data.blocks) || event.data.blocks < 0 || event.data.blocks > 9 ||
        typeof event.data.unlocked !== 'boolean') return;
    $('game-guide-progress').textContent = `${translate('MINA ore progress')}: ${event.data.blocks} / 10` +
      (event.data.unlocked ? ` · ${translate(connected ? 'MINA earned' : 'Connect a wallet to receive your reward')}` : '');
    if (!oreOverviewVisible && guestUnlocked === false && event.data.unlocked && !connected) {
      showWizard('1 MINA earned! Connect a wallet to receive your reward.');
    } else if (!oreOverviewVisible && lastProgress !== null && event.data.blocks !== lastProgress) {
      showWizard(`${translate('MINA ore progress')}: ${event.data.blocks} / 10`);
    }
    lastProgress = event.data.blocks;
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
    status.textContent = translate('Loading ranking…');
    try {
      const response = await fetch('/api/ore-ranking', { cache: 'no-store' });
      if (!response.ok) throw new Error(translate('Ranking is unavailable. Please try again.'));
      const data = await response.json();
      if (!Array.isArray(data?.players) || data.players.some((player) =>
        typeof player?.name !== 'string' ||
        !ores.every(([color]) => Number.isSafeInteger(player[color]) && player[color] >= 0) ||
        !Number.isSafeInteger(player.total) || player.total < 1 ||
        player.total !== player.green + player.blue + player.red)) {
        throw new Error(translate('Ranking data is invalid.'));
      }
      const max = data.players[0]?.total || 1;
      for (const player of data.players) {
        const row = document.createElement('li');
        const label = document.createElement('span');
        const value = document.createElement('strong');
        const bars = document.createElement('div');
        label.textContent = player.name;
        value.textContent = `${translate('Total')}: ${player.total}`;
        bars.className = 'ore-stats';
        renderOreBars(bars, ores.map(([color]) => player[color]), max, false);
        row.append(label, value, bars);
        list.append(row);
      }
      status.textContent = data.players.length ? '' : translate('No natural ore has been recorded yet.');
    } catch (error) {
      status.textContent = error.message || translate('Ranking is unavailable. Please try again.');
    }
  });
  $('ranking-close').addEventListener('click', () => $('ranking-dialog').close());
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === stage;
    const controlsHost = active ? stage : controlsHome;
    if (controls.parentNode !== controlsHost) controlsHost.appendChild(controls);
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
