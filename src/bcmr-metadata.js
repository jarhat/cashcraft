import { binToHex, binToUtf8, decodeAuthenticationInstructions, hexToBin, sha256 } from '@bitauth/libauth';

const CHAINGRAPH_URL = 'https://gql.chaingraph.pat.mn/v1/graphql';
const IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];
const WELL_KNOWN_PATH = '/.well-known/bitcoin-cash-metadata-registry.json';
const metadataRequests = new Map();
const METADATA_TTL_MS = 5 * 60 * 1000;

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
  const urls = [...new Set(uris.flatMap(resolveBcmrUri))];
  if (!urls.length) throw new Error('The latest BCMR publication has no supported metadata URI.');
  return { urls, hash: cidOnly ? null : binToHex(pushes[1]) };
}

function resolveBcmrUri(uri) {
  if (/^ipfs:\/\//i.test(uri)) {
    const path = uri.replace(/^ipfs:\/\/(ipfs\/)?/i, '');
    if (!/^[a-zA-Z0-9]+(?:[/?#]|$)/.test(path)) return [];
    return IPFS_GATEWAYS.map((gateway) => new URL(path, gateway).href)
      .filter((url, index) => url.startsWith(IPFS_GATEWAYS[index]));
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`);
  } catch {
    return [];
  }
  if (url.protocol !== 'https:' || url.username || url.password) return [];
  const subdomain = url.hostname.match(/^([a-z0-9]+)\.ipfs\./i);
  const ipfsPath = url.pathname.startsWith('/ipfs/')
    ? `${url.pathname.slice(6)}${url.search}${url.hash}`
    : subdomain ? `${subdomain[1]}${url.pathname}${url.search}${url.hash}` : '';
  if (ipfsPath) return [url.href, ...resolveBcmrUri(`ipfs://${ipfsPath}`)];
  if (url.pathname === '/' && !url.search && !url.hash) return [`${url.origin}${WELL_KNOWN_PATH}`];
  return [url.href];
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
  let latestOutput;
  for (const migration of categoryMigrations) {
    const transaction = Array.isArray(migration.transaction) ? migration.transaction[0] : migration.transaction;
    const output = transaction?.outputs?.find(({ locking_bytecode }) =>
      locking_bytecode?.replace(/^\\x/i, '').toLowerCase().startsWith('6a0442434d52'));
    if (output) latestOutput = output;
  }
  if (!latestOutput) throw new Error('No BCMR metadata publication was found for this category.');
  const publication = decodePublicationUri(latestOutput.locking_bytecode);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await Promise.any(publication.urls.map(async (url) => {
      const metadataResponse = await fetch(url, { signal: controller.signal });
      if (!metadataResponse.ok) throw new Error(`BCMR metadata request failed (${metadataResponse.status}).`);
      const bytes = new Uint8Array(await metadataResponse.arrayBuffer());
      if (publication.hash && binToHex(sha256.hash(bytes)) !== publication.hash) {
        throw new Error('BCMR metadata does not match the on-chain hash.');
      }
      const registry = JSON.parse(new TextDecoder().decode(bytes));
      const history = registry.identities?.[category] ?? registry.identities?.[category.toLowerCase()];
      const metadata = currentSnapshot(history);
      const metadataCategory = metadata?.token?.category;
      if (typeof metadataCategory !== 'string' || metadataCategory.toLowerCase() !== category.toLowerCase()) {
        throw new Error('BCMR metadata does not match the token category.');
      }
      return metadata;
    }));
  } catch (error) {
    if (error instanceof AggregateError) {
      throw new AggregateError(error.errors, `BCMR metadata unavailable: ${error.errors.map((cause) => cause.message).join('; ')}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function getBcmrMetadata(category) {
  if (typeof category !== 'string' || !/^[\da-f]{64}$/i.test(category)) {
    return Promise.reject(new Error('Invalid CashToken category ID.'));
  }
  const key = category.toLowerCase();
  let entry = metadataRequests.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    entry = { expiresAt: Date.now() + METADATA_TTL_MS };
    entry.request = fetchBcmrMetadata(key).catch((error) => {
      if (metadataRequests.get(key) === entry) metadataRequests.delete(key);
      throw error;
    });
    metadataRequests.set(key, entry);
  }
  return entry.request;
}
