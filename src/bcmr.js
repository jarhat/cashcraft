export function parseRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) ||
      !registry.identities || typeof registry.identities !== 'object' ||
      Array.isArray(registry.identities)) {
    throw new Error('Invalid BCMR registry: identities are missing.');
  }

  const tokens = new Map();
  for (const revisions of Object.values(registry.identities)) {
    if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) continue;
    for (const [timestamp, identity] of Object.entries(revisions)) {
      const category = identity?.token?.category;
      if (typeof category !== 'string' || !/^[0-9a-f]{64}$/i.test(category)) continue;
      const normalized = category.toLowerCase();
      const time = Date.parse(timestamp);
      if (!Number.isFinite(time) || (tokens.has(normalized) && tokens.get(normalized).time >= time)) continue;
      const icon = identity.uris?.icon;
      let iconUrl = '';
      if (typeof icon === 'string') {
        try {
          const url = new URL(icon);
          if (url.protocol === 'https:') iconUrl = url.href;
        } catch {
          // Invalid icon URLs are ignored; the default icon remains visible.
        }
      }
      const decimals = identity.token.decimals;
      tokens.set(normalized, {
        time,
        name: typeof identity.name === 'string' ? identity.name : '',
        description: typeof identity.description === 'string' ? identity.description : '',
        symbol: typeof identity.token.symbol === 'string' ? identity.token.symbol : '',
        decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : null,
        iconUrl,
      });
    }
  }
  return tokens;
}

export function formatTokenAmount(amount, decimals) {
  const raw = String(amount);
  if (decimals === null || decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
