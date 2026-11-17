const REMINDER_DELAY_MS = 45_000;
const REMINDER_TAG = 'pairing-reminder';

export function setupPairingReminder({ button, status, openWallet, pendingUri, translate, logger }) {
  const notifications = window.Notification;
  if (!window.isSecureContext || !notifications || !navigator.serviceWorker?.getRegistration) {
    return { cancel() {} };
  }

  let timer;
  let generation = 0;
  let shown = false;
  let pending = null;
  let deadline = 0;

  function updatePermission() {
    button.hidden = notifications.permission !== 'default';
    status.textContent = notifications.permission === 'granted'
      ? translate('Pairing reminders are enabled; delivery may be delayed while the app is inactive.')
      : notifications.permission === 'denied'
        ? translate('Pairing notifications are blocked in your browser settings.')
        : '';
  }

  function cancel() {
    generation++;
    clearTimeout(timer);
    pending = null;
    if (shown) {
      shown = false;
      navigator.serviceWorker.getRegistration().then((registration) =>
        registration?.getNotifications({ tag: REMINDER_TAG })).then((items) => {
        items?.forEach((item) => item.close());
      }).catch((error) => logger.warn('Could not clear the pairing reminder:', error));
    }
  }

  async function remind(expectedGeneration) {
    if (expectedGeneration !== generation || !pending || pendingUri() !== pending) return;
    status.textContent = translate('Still connecting? Approve in your wallet, then return here.');
    if (!document.hidden || notifications.permission !== 'granted') return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (expectedGeneration !== generation || pendingUri() !== pending || !document.hidden) return;
      if (!registration?.active) throw new Error('The notification service worker is not active.');
      await registration.showNotification(translate('Return to CTF Cash'), {
        body: translate('If you approved in your wallet, return to finish connecting.'),
        icon: '/icon-192.png',
        tag: REMINDER_TAG,
      });
      if (expectedGeneration !== generation || pendingUri() !== pending || !document.hidden) {
        const items = await registration.getNotifications({ tag: REMINDER_TAG });
        items.forEach((item) => item.close());
      } else {
        shown = true;
      }
    } catch (error) {
      logger.warn('Could not show the pairing reminder:', error);
    }
  }

  button.addEventListener('click', async () => {
    try {
      await notifications.requestPermission();
      updatePermission();
    } catch (error) {
      status.textContent = translate('Could not enable pairing notifications.');
      logger.warn('Could not enable pairing notifications:', error);
    }
  });
  openWallet.addEventListener('click', () => {
    const uri = pendingUri();
    if (!uri) return;
    cancel();
    pending = uri;
    deadline = Date.now() + REMINDER_DELAY_MS;
    const expectedGeneration = generation;
    timer = setTimeout(() => { void remind(expectedGeneration); }, REMINDER_DELAY_MS);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pending && Date.now() >= deadline) {
      void remind(generation);
    }
  });
  updatePermission();
  return { cancel };
}
