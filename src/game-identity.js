const key = 'cashcraft:netcraft-guest:v1';

export function getGameGuestId() {
  const saved = localStorage.getItem(key);
  if (saved !== null) {
    if (!/^[0-9a-f]{64}$/.test(saved)) throw new Error('Saved mining identity is invalid.');
    return saved;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(key, id);
  return id;
}
