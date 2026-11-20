export async function loadDonation($, network, loadDependencies, prefix, statusId = `${prefix}-status`) {
  $(`${prefix}-qr`).hidden = true;
  $(`${prefix}-address`).textContent = '';
  $(statusId).textContent = 'Loading donation address…';
  try {
    const [response, { QRCode, decodeCashAddress }] = await Promise.all([
      fetch('/api/donation-address'), loadDependencies(),
    ]);
    if (!response.ok) throw new Error('Donation address unavailable. Please try again later.');
    const result = await response.json();
    const decoded = decodeCashAddress(result.address);
    const expectedPrefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
    if (result.network !== network || typeof decoded === 'string' || decoded.prefix !== expectedPrefix) {
      throw new Error('Donation address does not match the current network.');
    }
    await QRCode.toCanvas($(`${prefix}-qr`), result.address, { width: 200, margin: 2 });
    $(`${prefix}-address`).textContent = result.address;
    $(`${prefix}-qr`).hidden = false;
    $(statusId).textContent = '';
  } catch (error) {
    $(statusId).textContent = error.message || 'Donation address unavailable. Please try again later.';
  }
}

export function setupGameInvite($, network, loadDependencies) {
  const dialog = $('invite-dialog');
  let url = new URL('/?game=cashcraft', window.location.origin).href;
  $('invite-url').textContent = url;
  const status = (message) => { $('invite-status').textContent = message; };

  $('game-invite').addEventListener('click', async () => {
    const isPk2 = $('game-frame').src?.includes('/games/pk2/');
    url = new URL(isPk2 ? '/?game=pk2' : '/?game=cashcraft', window.location.origin).href;
    $('invite-url').textContent = url;
    if (!dialog.open) dialog.showModal();
    await loadDonation($, network, loadDependencies, 'donation', 'invite-status');
  });
  $('invite-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    $('game-invite').focus({ preventScroll: true });
  });
  $('invite-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      status('Invite link copied.');
    } catch {
      status('Could not copy the invite link. Select the link above to copy it.');
    }
  });
  $('invite-share').addEventListener('click', async () => {
    try {
      if (!navigator.share) throw new Error('Sharing is unavailable. Use Copy invite link.');
      const isPk2 = $('game-frame').src?.includes('/games/pk2/');
      await navigator.share({ title: isPk2 ? 'Pekka Kana 2' : 'CashCraft',
        text: isPk2 ? 'Play Pekka Kana 2 with me!' : 'Come explore CashCraft with me!', url });
    } catch (error) {
      if (error.name !== 'AbortError') status(error.message || 'Could not share the invite link.');
    }
  });
}
