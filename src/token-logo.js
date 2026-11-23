import { getBcmrMetadata } from './bcmr-metadata.js';

const IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

export function tokenIconUrls(uri) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('No BCMR token logo was found for this category.');
  let path;
  let original;
  if (/^ipfs:\/\//i.test(uri)) path = uri.slice(7).replace(/^ipfs\//i, '');
  else {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('The BCMR token logo must use HTTPS.');
    }
    original = url.href;
    if (url.pathname.startsWith('/ipfs/')) {
      path = `${url.pathname.slice(6)}${url.search}${url.hash}`;
    } else {
      const subdomain = url.hostname.match(/^([a-z0-9]+)\.ipfs\./i);
      if (subdomain) path = `${subdomain[1]}${url.pathname}${url.search}${url.hash}`;
      else return [url.href];
    }
  }
  if (!path || !/^[a-zA-Z0-9]+(?:[/?#]|$)/.test(path)) throw new Error('Invalid IPFS token logo URI.');
  const gateways = IPFS_GATEWAYS.map((gateway) => {
    const url = new URL(path, gateway);
    if (!url.href.startsWith(gateway)) throw new Error('Invalid IPFS token logo URI.');
    return url.href;
  });
  return [...new Set(original ? [original, ...gateways] : gateways)];
}

function loadImage(url, signal, cors) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      image.onload = image.onerror = null;
    };
    const cancel = () => {
      cleanup();
      image.src = '';
      reject(new Error('The BCMR token logo request was cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      image.src = '';
      reject(new Error('The BCMR token logo timed out.'));
    }, 5000);
    signal.addEventListener('abort', cancel, { once: true });
    if (cors) image.crossOrigin = 'anonymous';
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('The BCMR token logo could not be loaded.')); };
    image.src = url;
  });
}

export async function loadTokenLogo(category, { requireCors = false } = {}) {
  try {
    const metadata = await getBcmrMetadata(category);
    const uris = [metadata.uris?.icon, metadata.uris?.image].filter((uri) => typeof uri === 'string' && uri.trim());
    if (!uris.length) throw new Error('No BCMR token logo was found for this category.');
    const errors = [];
    const urls = [...new Set(uris.flatMap((uri) => {
      try {
        return tokenIconUrls(uri);
      } catch (error) {
        errors.push(error);
        return [];
      }
    }))];
    if (!urls.length) throw new AggregateError(errors, 'No supported BCMR token logo URI.');
    const controller = new AbortController();
    try {
      return await Promise.any(urls.map((url) => loadImage(url, controller.signal, true).catch((error) => {
        if (requireCors || controller.signal.aborted) throw error;
        return loadImage(url, controller.signal, false);
      })));
    } finally {
      controller.abort();
    }
  } catch (error) {
    throw new AggregateError(error instanceof AggregateError ? error.errors : [error],
      `No BCMR token logo could be loaded for ${category}.`);
  }
}
