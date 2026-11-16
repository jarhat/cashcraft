import { getBcmrMetadata } from './bcmr-metadata.js';

const INDEXERS = {
  mainnet: 'https://indexer.cauldron.quest/cauldron',
  chipnet: 'https://indexer-chipnet.riften.net/cauldron',
};

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export async function fetchTokenMetadata(category) {
  const data = await getBcmrMetadata(category);
  const decimals = data.token.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error('BCMR token decimals are unavailable or invalid.');
  }
  return { name: data.name, description: data.description, symbol: data.token.symbol, decimals };
}

export async function fetchCauldronSpot(category, network) {
  const data = await getJson(`${INDEXERS[network]}/pool/active?token=${category}`);
  if (!Array.isArray(data.active)) throw new Error('Invalid Cauldron pool response.');
  const pools = data.active.filter((pool) =>
    pool.token_id?.toLowerCase() === category &&
    Number.isSafeInteger(pool.sats) && pool.sats > 0 &&
    Number.isSafeInteger(pool.tokens) && pool.tokens > 0);
  if (!pools.length) throw new Error('No priced Cauldron pool is available.');
  const pool = pools.reduce((best, candidate) => candidate.sats > best.sats ? candidate : best);
  return pool.sats / pool.tokens / 100_000_000;
}
