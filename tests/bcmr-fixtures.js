export function authchainResponse(category, uri = 'ipfs://registry/metadata.json') {
  const uriHex = Array.from(new TextEncoder().encode(uri), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const uriLength = uriHex.length / 2;
  const uriPush = uriLength <= 75
    ? `${uriLength.toString(16).padStart(2, '0')}${uriHex}`
    : `4c${uriLength.toString(16).padStart(2, '0')}${uriHex}`;
  const bytecode = `6a0442434d5220${'11'.repeat(32)}${uriPush}`;
  return {
    data: {
      transaction: [{
        authchains: [{
          migrations: [{
            transaction: [{
              hash: `\\x${category}`,
              outputs: [{ output_index: 0, locking_bytecode: `\\x${bytecode}` }],
            }],
          }],
        }],
      }],
    },
  };
}

export function metadataResponse(category, metadata = {}) {
  return {
    identities: {
      [category]: {
        '2024-01-01T00:00:00.000Z': {
          name: 'Example',
          token: { category, symbol: 'EX', decimals: 2 },
          ...metadata,
        },
      },
    },
  };
}
