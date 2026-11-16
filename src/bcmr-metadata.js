import { binToUtf8, decodeAuthenticationInstructions, hexToBin } from '@bitauth/libauth';

const CHAINGRAPH_URL = 'https://gql.chaingraph.pat.mn/v1/graphql';
const IPFS_GATEWAY = 'https://ipfs.filebase.io/ipfs/';
const WELL_KNOWN_PATH = '/.well-known/bitcoin-cash-metadata-registry.json';
const metadataRequests = new Map();

function decodePublicationUri(lockingBytecode) {
  const bytecode = lockingBytecode.replace(/^\\x/i, '');
  const instructions = decodeAuthenticationInstructions(hexToBin(bytecode));
  const pushes = [];
  let malformed = false;
  const [first, ...rest] = instructions;
  for (const instruction of first?.opcode === 0x6a ? rest : instructions) {
    if ('malformed' in instruction && instruction.malformed) throw new Error('Malformed BCMR publication output.');
    if ('data' in instruction) pushes.push(instruction.data);
    else malformed = true;
  }
  if (malformed || binToUtf8(pushes[0] ?? new Uint8Array()) !== 'BCMR' || !pushes[1]) {
    throw new Error('Malformed BCMR publication output.');
  }

  const hashPush = binToUtf8(pushes[1]);
  const cidOnly = pushes.length === 2 && /^(baf[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/.test(hashPush);
  if (!cidOnly && pushes[1].length !== 32) throw new Error('Malformed BCMR publication output.');
  const uris = cidOnly ? [`ipfs://${hashPush}`] : pushes.slice(2).map((uri) => binToUtf8(uri));
  for (const uri of uris) {
    const resolved = resolveBcmrUri(uri);
    if (resolved) return resolved;
  }
  throw new Error('The latest BCMR publication has no supported metadata URI.');
}

function resolveBcmrUri(uri) {
  if (/^ipfs:\/\//i.test(uri)) {
    const path = uri.replace(/^ipfs:\/\/(ipfs\/)?/i, '');
    if (!/^[a-zA-Z0-9]+(?:[/?#]|$)/.test(path)) return undefined;
    const url = new URL(path, IPFS_GATEWAY);
    return url.href.startsWith(IPFS_GATEWAY) ? url.href : undefined;
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  if (url.pathname === '/' && !url.search && !url.hash) return `${url.origin}${WELL_KNOWN_PATH}`;
  return url.href;
}

function currentSnapshot(history) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) return undefined;
  const snapshots = Object.entries(history)
    .map(([date, snapshot]) => ({ date, timestamp: Date.parse(date), snapshot }))
    .filter(({ timestamp }) => Number.isFinite(timestamp));
  const available = snapshots.filter(({ timestamp }) => timestamp <= Date.now());
  if (available.length) return available.reduce((latest, candidate) =>
    candidate.timestamp > latest.timestamp ? candidate : latest).snapshot;
  return snapshots.reduce((earliest, candidate) =>
    !earliest || candidate.timestamp < earliest.timestamp ? candidate : earliest, undefined)?.snapshot
    ?? Object.values(history)[0];
}

async function fetchBcmrMetadata(category) {
  if (!/^[\da-f]{64}$/i.test(category)) throw new Error('Invalid CashToken category ID.');
  const response = await fetch(CHAINGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      query: `query TokenMetadata($tokenId: bytea) {
        transaction(
          where: {
            hash: { _eq: $tokenId }
            _or: [
              { node_validations: {} }
              { block_inclusions: { block: { accepted_by: {} } } }
            ]
          }
        ) {
          authchains {
            migrations(order_by: { migration_index: asc }) {
              transaction {
                hash
                outputs { output_index locking_bytecode }
              }
            }
          }
        }
      }`,
      variables: { tokenId: `\\x${category}` },
    }),
  });
  if (!response.ok) throw new Error(`Chaingraph BCMR lookup failed (${response.status}).`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(`Chaingraph BCMR lookup failed: ${result.errors[0].message}`);
  const migrations = result.data?.transaction?.[0]?.authchains?.[0]?.migrations ?? [];
  const genesisIndex = migrations.findIndex((migration) => {
    const transaction = Array.isArray(migration.transaction) ? migration.transaction[0] : migration.transaction;
    return transaction?.hash?.replace(/^\\x/i, '').toLowerCase() === category.toLowerCase();
  });
  const categoryMigrations = migrations.slice(Math.max(genesisIndex, 0));
  let metadataUrl;
  for (const migration of categoryMigrations) {
    const transaction = Array.isArray(migration.transaction) ? migration.transaction[0] : migration.transaction;
    const output = transaction?.outputs?.find(({ locking_bytecode }) =>
      locking_bytecode?.replace(/^\\x/i, '').toLowerCase().startsWith('6a0442434d52'));
    if (output) metadataUrl = decodePublicationUri(output.locking_bytecode);
  }
  if (!metadataUrl) throw new Error('No BCMR metadata publication was found for this category.');

  const metadataResponse = await fetch(metadataUrl, { signal: AbortSignal.timeout(8000) });
  if (!metadataResponse.ok) throw new Error(`BCMR metadata request failed (${metadataResponse.status}).`);
  const registry = await metadataResponse.json();
  const history = registry.identities?.[category] ?? registry.identities?.[category.toLowerCase()];
  const metadata = currentSnapshot(history);
  const metadataCategory = metadata?.token?.category;
  if (typeof metadataCategory !== 'string' || metadataCategory.toLowerCase() !== category.toLowerCase()) {
    throw new Error('BCMR metadata does not match the token category.');
  }
  return metadata;
}

export function getBcmrMetadata(category) {
  if (typeof category !== 'string' || !/^[\da-f]{64}$/i.test(category)) {
    return Promise.reject(new Error('Invalid CashToken category ID.'));
  }
  const key = category.toLowerCase();
  if (!metadataRequests.has(key)) {
    const request = fetchBcmrMetadata(category).catch((error) => {
      metadataRequests.delete(key);
      throw error;
    });
    metadataRequests.set(key, request);
  }
  return metadataRequests.get(key);
}
