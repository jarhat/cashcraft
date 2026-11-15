export const PUSD_CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

export async function fetchTokenPrice(category, decimals, bchUsd, fetcher = fetch) {
  if (!/^[0-9a-f]{64}$/.test(category)) throw new Error('Invalid token category.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !Number.isFinite(bchUsd) || bchUsd <= 0) {
    throw new Error('Valid token decimals and BCH price are required.');
  }
  const response = await fetcher(`https://indexer.riften.net/cauldron/valuelocked/${category}`);
  if (!response.ok) throw new Error(`Price service returned HTTP ${response.status}`);
  const pool = await response.json();
  if (!Number.isFinite(pool.satoshis) || pool.satoshis < 100_000_000 ||
      !Number.isFinite(pool.token_amount) || pool.token_amount <= 0) {
    throw new Error('Price unavailable or pool liquidity is too low.');
  }
  const price = (pool.satoshis / 100_000_000) / pool.token_amount * 10 ** decimals * bchUsd;
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid pool price.');
  return price;
}
