import { getGameGuestId } from './game-identity.js';

const games = {
  netcraft: { title: 'CashCraft', url: '/games/netcraft/craftw.html' },
  pk2: { title: 'Pekka Kana 2', url: '/games/pk2/index.html' },
};
const netcraftServer = import.meta.env?.VITE_NETCRAFT_WS_URL || '-';

export function setupGames($, { translate, getRewardAddress = () => null, isWalletConnected = null, getMinaBalance = () => 0n, hasMinaPickaxe = () => false, getGuestId = getGameGuestId, openPlayerTransfer, openGamePaymentRequest, signGameWalletChallenge, autoOpen = false, autoOpenGame = 'netcraft' }) {
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
  const controlsToggle = $('game-controls-toggle');
  const extraControls = $('game-extra-controls');
  controlsToggle.addEventListener('click', () => {
    extraControls.hidden = !extraControls.hidden;
    controlsToggle.setAttribute('aria-expanded', String(!extraControls.hidden));
    const label = translate(extraControls.hidden ? 'Expand game controls' : 'Collapse game controls');
    controlsToggle.setAttribute('aria-label', label);
    controlsToggle.setAttribute('title', label);
  });
  const showStageDialog = (popup, show) => {
    if (popup.parentNode !== stage) {
      const home = popup.parentNode;
      const next = popup.nextSibling;
      stage.appendChild(popup);
      popup.addEventListener('close', () => home.insertBefore(popup, next), { once: true });
    }
    show();
  };
  const setPlayingUi = () => {
    const playing = dialog.open && !dialog.hidden;
    document.body.classList.toggle('cashcraft-playing', playing);
    dock.hidden = !dialog.open || !dialog.hidden || !activeGame;
  };
  toolbar.after(dialog);
  stage.addEventListener('contextmenu', (event) => event.preventDefault());
  let generation = 0;
  let activeGame = null;
  const verifyWallet = $('game-verify-wallet');
  let walletProof = null;
  verifyWallet?.addEventListener('click', () => {
    const address = getRewardAddress();
    if (!address || activeGame !== 'netcraft' || dialog.hidden) return;
    walletProof = { address, generation, requestedAt: Date.now() };
    frame.contentWindow?.postMessage({ type: 'netcraft-wallet-proof', signature: '' }, '*');
  });
  let paymentRequest = null;
  const dismissPayment = () => {
    paymentRequest = null;
    $('game-payment-bubble').hidden = true;
  };
  $('game-payment-dismiss').addEventListener('click', dismissPayment);
  $('game-payment-qr').addEventListener('error', () => { $('game-payment-qr').hidden = true; });
  $('game-payment-link').addEventListener('click', async (event) => {
    if (!paymentRequest || !openGamePaymentRequest || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const request = paymentRequest;
    if (request.opening) return;
    request.opening = true;
    $('game-payment-status').textContent = '';
    const session = generation;
    try {
      await openGamePaymentRequest(request, (popup, show) => {
        if (session !== generation || dialog.hidden || request !== paymentRequest) return false;
        document.exitPointerLock?.();
        showStageDialog(popup, show);
        return true;
      }, async () => {
        if (session !== generation || dialog.hidden) return false;
        if (!await minimize() || session !== generation) return false;
        if (request === paymentRequest) dismissPayment();
        return true;
      });
    } catch (error) {
      if (request === paymentRequest) $('game-payment-status').textContent = error.message;
    } finally {
      request.opening = false;
    }
  });
  let guideShown = false;
  let sharedTutorialPending = false;
  let touchFirst = false;
  let reopenGuide = false;
  let reopenPrompt = false;
  const reopenOverlays = () => {
    if (reopenGuide && !guide.open) guide.showModal();
    if (reopenPrompt && !prompt.open) prompt.show();
    reopenGuide = reopenPrompt = false;
  };
  let guestId = null;
  let guestUnlocked = null;
  let lastProgress = null;
  let craftingTip = false;
  let firstBlockShown = false;
  let oreOverviewVisible = false;
  let oreCounts = [0, 0, 0];
  // Atlas coordinates here are measured from the top of the PNG, not the OpenGL origin.
  const ores = [
    ['green', 'MINA ore', 11, 26],
    ['blue', 'Lapis ore', 0, 26],
    ['red', 'Redstone ore', 3, 19],
  ];
  let wizardTimer;
  let tutorialStep = 0;
  let tutorialActive = false;
  const tutorialTips = [
    'Use WASD to move, space to jump, left click to mine and right click to build. On mobile, use the joystick and the jump, mine and build buttons. Scroll to choose blocks.',
    'Mine 10 natural green MINA ore blocks to earn 1 MINA. Blue lapis and redstone have separate counters and may earn their own tokens. Placed blocks do not count.',
    'You can mine before connecting. Pair a WizardConnect wallet to claim your rewards: open the wallet on this device or scan the QR on another device, then approve the connection. The gem shows your wallet and rewards.',
    'Use the jump, mine and build buttons on touchscreens. With a keyboard and mouse, press Space to jump, left-click to mine and right-click to place a block. Scroll the block slots to choose what to build with.',
    'Earn 2 MINA by mining 20 natural MINA ore blocks. Then open the crafting table and review the 2 MINA payment in your wallet. Once confirmed, you unlock the faster green pickaxe permanently.',
  ];
  const tutorialTitles = ['Move and look', 'Mine ore', 'Claim rewards', 'Build with blocks', 'Craft a MINA pickaxe'];
  function renderOreBars(container, counts, max, showGoal) {
    container.replaceChildren();
    for (const [index, [color, name, column, row]] of ores.entries()) {
      const label = document.createElement('label');
      const bar = document.createElement('progress');
      label.textContent = `${translate(name)}: ${counts[index]}${showGoal ? `/${max}` : ''}`;
      if (showGoal) {
        const texture = document.createElement('span');
        texture.className = 'wizard-ore-texture';
        texture.setAttribute('aria-hidden', 'true');
        texture.style.backgroundPosition = `-${column * 16}px -${row * 16}px`;
        label.prepend(texture);
      }
      bar.className = `ore-bar ore-${color}`;
      bar.max = max;
      bar.value = counts[index];
      label.append(bar);
      container.append(label);
    }
  }

  function stopTutorial() {
    clearTimeout(wizardTimer);
    tutorialActive = false;
    tutorialStep = 0;
    $('game-notifications').classList.remove('tutorial-active');
    $('game-wizard-speech').hidden = true;
    oreOverviewVisible = false;
  }

  function nextTutorialTip() {
    if (tutorialStep === tutorialTips.length) {
      const focusInBubble = $('game-wizard-speech').contains?.(document.activeElement);
      stopTutorial();
      if (focusInBubble) frame.focus({ preventScroll: true });
      return;
    }
    tutorialActive = true;
    $('game-notifications').classList.add('tutorial-active');
    const step = tutorialStep++;
    const message = step === 0 && touchFirst
      ? 'On a touchscreen, drag the joystick at the bottom left to walk. Drag an open area of the game view to look around. On a computer, use WASD and move the mouse to look.'
      : tutorialTips[step];
    showWizard(message, step === 1, nextTutorialTip, step);
  }

  function showWizard(message, overview = false, advance = null, step = -1, crafting = false) {
    if (tutorialActive && !advance) return;
    const bubble = $('game-wizard-speech');
    const bars = $('game-wizard-ores');
    craftingTip = crafting || step === 4;
    bubble.classList.toggle('is-crafting', craftingTip);
    clearTimeout(wizardTimer);
    bubble.hidden = true;
    oreOverviewVisible = overview;
    bars.hidden = !overview;
    if (overview) renderOreBars(bars, oreCounts, 10, true);
    const heading = $('game-wizard-step');
    heading.hidden = step < 0;
    if (step >= 0) heading.textContent = `${step + 1}/${tutorialTips.length} · ${translate(tutorialTitles[step])}`;
    $('game-wizard-table').hidden = !craftingTip;
    const connected = isWalletConnected ? isWalletConnected() : Boolean(getRewardAddress());
    $('game-wizard-wallet').hidden = step !== 2 || connected;
    $('game-wizard-craft').hidden = !craftingTip || $('game-crafting').hidden;
    $('game-wizard-actions').hidden = step < 0 && !craftingTip;
    $('game-wizard-next').hidden = $('game-wizard-skip').hidden = step < 0;
    const text = translate(message);
    const duration = Math.max(7000, 2000 + text.trim().split(/\s+/).length * 350);
    $('game-wizard-message').textContent = text;
    bubble.style.setProperty('--wizard-tip-duration', `${duration}ms`);
    void bubble.offsetWidth;
    bubble.hidden = false;
    wizardTimer = setTimeout(() => {
      if (advance) {
        if (!bubble.contains?.(document.activeElement) && !bubble.matches?.(':hover')) advance();
      } else {
        bubble.hidden = true;
        oreOverviewVisible = false;
      }
    }, duration);
  }
  let soundEnabled = true;
  const updateRewardAddress = (address) => {
    const connected = isWalletConnected ? isWalletConnected() : Boolean(address);
    const crafting = activeGame === 'netcraft' && connected && Boolean(address) &&
      !hasMinaPickaxe() && getMinaBalance() >= 2n;
    const craftingButton = $('game-crafting');
    const newlyAvailable = crafting && craftingButton.hidden !== false;
    craftingButton.hidden = !crafting;
    if (craftingTip) $('game-wizard-craft').hidden = !crafting;
    if (newlyAvailable && !dialog.hidden) {
      showWizard('You have 2 MINA! Use the crafting table to review a payment for your pickaxe.', false, null, -1, true);
    }
    const gemLabel = connected ? 'Wallet and notifications' : 'Connect wallet';
    $('game-guide-wallet').textContent = translate(gemLabel);
    $('game-ranking').hidden = activeGame !== 'netcraft';
    if (verifyWallet) verifyWallet.hidden = activeGame !== 'netcraft' || !connected || !address;
    if (walletProof && (!connected || walletProof.address !== address)) walletProof = null;
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
  const overlayDialogs = ['connection-dialog', 'notifications-dialog', 'funding-dialog', 'wiki-dialog', 'invite-dialog', 'ranking-dialog', 'game-guide', 'mining-prompt', 'game-receive-dialog', 'token-qr-dialog'];
  const canFocusGame = () => dialog.open && !dialog.hidden && activeGame &&
    !overlayDialogs.some((id) => $(id).open);
  frame.addEventListener('load', () => {
    walletProof = null;
    if (activeGame) document.documentElement.classList.remove('game-link-loading');
    updateRewardAddress(getRewardAddress());
    if (activeGame === 'netcraft' && sharedTutorialPending) {
      sharedTutorialPending = false;
      if (!dialog.hidden && !guideShown) {
        guideShown = true;
        nextTutorialTip();
      }
    }
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
  const enterFullscreen = async () => {
    if (document.fullscreenElement === stage) return true;
    try {
      await stage.requestFullscreen();
      return true;
    } catch {
      return false;
    }
  };
  const openGame = async (id, { fullscreen = false, shared = false } = {}) => {
      const game = games[id];
      if (dialog.open && activeGame === id) {
        generation++;
        $('game-dialog-status').textContent = '';
        dialog.hidden = false;
        reopenOverlays();
        setPlayingUi();
        if (fullscreen) {
          const entered = await enterFullscreen();
          if (!entered) $('game-dialog-status').textContent = translate('Fullscreen is unavailable.');
          if (canFocusGame()) frame.focus({ preventScroll: true });
        }
        return;
      }
      const request = ++generation;
      const openedForFullscreen = fullscreen && !dialog.open;
      if (fullscreen) {
        dialog.hidden = false;
        if (openedForFullscreen) dialog.show();
      }
      const status = dialog.open ? $('game-dialog-status') : $('game-status');
      status.textContent = translate('Loading game…');
      // Request before the fetch: fullscreen requires the launch click's activation.
      const fullscreenRequest = fullscreen ? enterFullscreen() : null;
      if (fullscreen) setPlayingUi();
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
        dismissPayment();
        stopTutorial();
        touchFirst = shared;
        sharedTutorialPending = id === 'netcraft' && shared && !guideShown;
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
        if (id === 'netcraft' && !guideShown && !sharedTutorialPending) {
          guideShown = true;
          nextTutorialTip();
        }
        if (fullscreenRequest) {
          const entered = await fullscreenRequest;
          if (request === generation) {
            if (!entered) status.textContent = translate('Fullscreen is unavailable.');
            if (canFocusGame()) frame.focus({ preventScroll: true });
          }
        }
      } catch (error) {
        if (fullscreenRequest) await fullscreenRequest;
        if (request === generation) {
          document.documentElement.classList.remove('game-link-loading');
          if (fullscreen && !activeGame) {
            dialog.close();
            $('game-status').textContent = error.message;
          } else {
            status.textContent = error.message;
          }
        }
      }
  };
  for (const id of Object.keys(games)) {
    const open = () => openGame(id);
    $(`game-${id}`).addEventListener('click', (event) => openGame(id, {
      fullscreen: id === 'netcraft' && event?.isTrusted === true,
      shared: event?.isTrusted !== true && dialog.classList?.contains?.('game-auto-open'),
    }));
    $(`switch-${id}`).addEventListener('click', open);
    if (id === autoOpenGame && autoOpen) {
      void openGame(id, { shared: true });
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
    if (tutorialActive) stopTutorial();
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
  $('game-notifications').addEventListener('click', () => {
    document.exitPointerLock?.();
    if (!guide.open) guide.showModal();
  });
  const openTransfer = async (target) => {
    if (!openPlayerTransfer || dialog.hidden || activeGame !== 'netcraft') return;
    document.exitPointerLock?.();
    const session = generation;
    const fullscreen = document.fullscreenElement === stage;
    if (fullscreen && !target && $('game-receive-dialog').open) return;
    if (!fullscreen && (!await minimize() || session !== generation)) return;
    const currentSession = () => session === generation && activeGame === 'netcraft' && dialog.open;
    await openPlayerTransfer(target, (popup, show) => {
      if (!currentSession()) return false;
      if (dialog.hidden) restore.click();
      showStageDialog(popup, show);
      return true;
    }, (id) => {
      if (!currentSession() || dialog.hidden) return;
      frame.contentWindow?.postMessage({ type: 'netcraft-share-payment', id }, '*');
      frame.focus({ preventScroll: true });
    }, fullscreen ? () => currentSession() && minimize() : null);
  };
  $('game-receive').addEventListener('click', () => openTransfer(null));
  $('game-receive-close').addEventListener('click', () => $('game-receive-dialog').close());
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
    if (guide.open) guide.close();
    stopTutorial();
    nextTutorialTip();
    frame.focus({ preventScroll: true });
  });
  $('game-wizard-next').addEventListener('click', nextTutorialTip);
  $('game-wizard-skip').addEventListener('click', () => {
    stopTutorial();
    frame.focus({ preventScroll: true });
  });
  $('game-wizard-wallet').addEventListener('click', () => {
    document.exitPointerLock?.();
    stopTutorial();
    openWallet();
    const connect = $('connect');
    if (!(isWalletConnected ? isWalletConnected() : getRewardAddress()) && !connect.hidden && !connect.disabled) {
      connect.click();
    }
  });
  $('game-wizard-craft').addEventListener('click', () => {
    if (!$('game-crafting').hidden) $('game-crafting').click();
  });
  $('game-guide-wallet').addEventListener('click', () => {
    if (guide.open) guide.close();
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
    if (event.data?.type === 'netcraft-challenge') {
      if (event.origin === window.location.origin) receiveChallenge(event.data.packet);
      return;
    }
    if (event.data?.type === 'netcraft-wallet-challenge') {
      const { nonce } = event.data;
      const proof = walletProof;
      if (!proof || proof.generation !== generation || getRewardAddress() !== proof.address ||
          Date.now() - proof.requestedAt > 15_000 || dialog.hidden ||
          typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return;
      walletProof = null;
      try {
        document.exitPointerLock?.();
        const signed = signGameWalletChallenge?.(nonce, proof.address);
        const signature = signed ?? window.prompt(
          `Sign the message below using your CashCraft BCH wallet, then replace it with the signature:\n${proof.address}`,
          `CashCraft wallet login v1: ${nonce}`,
        )?.trim();
        if (typeof signature === 'string' && /^[A-Za-z0-9+/]{87}=$/.test(signature) &&
            generation === proof.generation && getRewardAddress() === proof.address) {
          frame.contentWindow?.postMessage({ type: 'netcraft-wallet-proof', signature }, '*');
        }
      } catch {
        $('game-dialog-status').textContent = translate('Could not sign the CashCraft wallet verification message.');
      }
      return;
    }
    if (event.data?.type === 'netcraft-payment-request') {
      const { id, name } = event.data;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(id) ||
          typeof name !== 'string' || !/^[A-Za-z0-9_]{1,24}$/.test(name)) return;
      const path = `/s/${id}`;
      paymentRequest = { id, name, path };
      $('game-payment-speaker').textContent = `${name}: ${translate('MINA payment request')}`;
      $('game-payment-link').href = path;
      $('game-payment-qr').hidden = false;
      $('game-payment-qr').src = `/api/qr.png?s=${id}`;
      $('game-payment-status').textContent = '';
      $('game-payment-bubble').hidden = false;
      return;
    }
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
    const connected = isWalletConnected ? isWalletConnected() : Boolean(getRewardAddress());
    if (event.data?.type === 'netcraft-ore-progress' &&
        Array.isArray(event.data.counts) && event.data.counts.length === 3 &&
        event.data.counts.every(count => Number.isInteger(count) && count >= 0 && count < 10)) {
      oreCounts = event.data.counts;
      if (oreOverviewVisible) renderOreBars($('game-wizard-ores'), oreCounts, 10, true);
      return;
    }
    if (event.data?.type === 'netcraft-block-mined' && !tutorialActive && !firstBlockShown &&
        Number.isInteger(event.data.block) && event.data.block > 0 &&
        ![49, 70, 73, 83].includes(event.data.block)) {
      firstBlockShown = true;
      showWizard('Mine 10 natural blocks of one ore for its token when rewards are configured. Look deep for blue ore; red is the rarest.', true);
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
  const challengePlayers = new Map();
  const challengeInvitations = new Map();
  const challengeKey = /^[a-f0-9]+-[a-f0-9]+$/;
  const pendingChallenge = new URLSearchParams(window.location?.search).get('challenge');
  const sendChallenge = (command) => frame.contentWindow?.postMessage(
    { type: 'netcraft-challenge-command', command }, window.location.origin);
  function renderChallengePlayers(connected, self) {
    const fieldset = $('challenge-invitees');
    const selected = new Set([...fieldset.querySelectorAll('input:checked')].map(input => input.value));
    for (const label of fieldset.querySelectorAll('label')) label.remove();
    for (const [id, player] of challengePlayers) {
      if (id === self) continue;
      const label = document.createElement('label');
      label.style.display = 'block';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = selected.has(id);
      label.append(input, ` ${player.name}`);
      fieldset.append(label);
    }
    $('challenge-create').disabled = !connected || !fieldset.querySelector('input');
  }
  function renderChallengeRanks() {
    const category = $('ranking-category').value;
    const players = [...challengePlayers.values()].sort((a, b) =>
      b[category] - a[category] || a.name.localeCompare(b.name));
    const list = $('ranking-list');
    list.replaceChildren();
    for (const player of players) {
      const row = document.createElement('li');
      const score = document.createElement('strong');
      score.textContent = player[category].toLocaleString();
      row.append(player.name, score);
      list.append(row);
    }
    $('ranking-status').textContent = players.length ? '' : 'No wallet-connected players in this world.';
  }
  function addChallengeInvitation(key, host) {
    if (!challengeKey.test(key) || challengeInvitations.has(key)) return;
    const row = document.createElement('p');
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = host ? 'Accept invitation' : 'Start challenge';
    action.addEventListener('click', () => sendChallenge(`${host ? 'join' : 'start'},${key}`));
    if (!host) {
      const url = new URL('/?game=cashcraft', window.location.origin);
      url.searchParams.set('challenge', key);
      const link = document.createElement('a');
      link.href = url.href;
      link.textContent = 'Shareable invite link';
      row.append(link, ' ');
    } else {
      row.append(`${host}: `);
    }
    row.append(action);
    $('challenge-invitations').append(row);
    challengeInvitations.set(key, row);
  }
  let challengeSelf = '';
  function receiveChallenge(packet) {
    if (typeof packet !== 'string' || packet.length > 512) return;
    const [type, ...args] = packet.split(',');
    if (type === 'clear') {
      challengeSelf = args[0];
      challengePlayers.clear();
    } else if (type === 'player') {
      const [id, name, ...scores] = args;
      if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,24}$/.test(name) || scores.length !== 4 ||
          !scores.every(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) return;
      const [green, blue, red, mined] = scores.map(Number);
      challengePlayers.set(id, { name, green, blue, red, mined, total: green + blue + red });
    } else if (type === 'listed') {
      renderChallengePlayers(args[0] === '1', challengeSelf);
      renderChallengeRanks();
    } else if (type === 'created' || type === 'invite') {
      addChallengeInvitation(args[0], type === 'invite' ? args[1] : null);
      $('challenge-status').textContent = type === 'created' ? 'Invitation created.' : `Challenge invitation from ${args[1]}.`;
    } else if (type === 'started' || type === 'closed') {
      challengeInvitations.get(args[0])?.remove();
      challengeInvitations.delete(args[0]);
    } else if (type === 'status') {
      $('challenge-status').textContent = args.join(',');
    }
  }
  $('ranking-category').addEventListener('change', renderChallengeRanks);
  $('challenge-refresh').addEventListener('click', () => sendChallenge('list'));
  let challengeRefresh;
  $('ranking-dialog').addEventListener('close', () => clearInterval(challengeRefresh));
  $('challenge-create').addEventListener('click', () => {
    const ids = [...$('challenge-invitees').querySelectorAll('input:checked')].map(input => input.value);
    if (ids.length < 1 || ids.length > 8) {
      $('challenge-status').textContent = 'Select one to eight connected players.';
      return;
    }
    sendChallenge(`invite,${$('challenge-mode').value},${ids.join(',')}`);
  });
  if (pendingChallenge && challengeKey.test(pendingChallenge)) addChallengeInvitation(pendingChallenge, 'Shared invitation');
  $('game-ranking').addEventListener('click', () => {
    if (activeGame !== 'netcraft') return;
    const overlay = $('ranking-dialog');
    if (document.fullscreenElement === stage && !overlay.open) {
      const parent = overlay.parentNode;
      const next = overlay.nextSibling;
      stage.appendChild(overlay);
      overlay.addEventListener('close', () => parent.insertBefore(overlay, next), { once: true });
    }
    if (!overlay.open) {
      overlay.showModal();
      challengeRefresh = setInterval(() => sendChallenge('list'), 5000);
    }
    $('ranking-status').textContent = 'Waiting for the game server. Refresh after connecting.';
    $('ranking-list').replaceChildren();
    sendChallenge('list');
  });
  $('ranking-close').addEventListener('click', () => $('ranking-dialog').close());
  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === stage;
    const controlsHost = active ? $('game-fullscreen-toolbar') : controlsHome;
    if (controls.parentNode !== controlsHost) controlsHost.appendChild(controls);
    stage.classList.toggle('is-fullscreen', active);
    dialog.classList.toggle('is-fullscreen', active);
    setPlayingUi();
    const label = translate(active ? 'Minimize CashCraft' : 'Enter fullscreen');
    $('game-fullscreen').setAttribute('aria-pressed', String(active));
    $('game-fullscreen').setAttribute('aria-label', label);
    $('game-fullscreen').setAttribute('title', label);
  });
  $('game-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === stage) await minimize();
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
    sharedTutorialPending = false;
    stopTutorial();
    setPlayingUi();
    frame.removeAttribute('src');
    $('game-dialog-status').textContent = '';
    for (const key of Object.keys(games)) $(`switch-${key}`).setAttribute('aria-pressed', 'false');
  });
  return updateRewardAddress;
}
