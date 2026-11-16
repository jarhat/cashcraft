import { getBcmrMetadata } from './bcmr-metadata.js';

const IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

export function tokenIconUrls(uri) {
  if (typeof uri !== 'string' || !uri.trim()) throw new Error('No BCMR token logo was found for this category.');
  let path;
  let original;
  if (uri.startsWith('ipfs://')) path = uri.slice(7).replace(/^ipfs\//, '');
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

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.onload = image.onerror = null;
      image.src = '';
      reject(new Error('The BCMR token logo timed out.'));
    }, 5000);
    image.crossOrigin = 'anonymous';
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('The BCMR token logo could not be loaded.')); };
    image.src = url;
  });
}

export async function loadTokenLogo(category) {
  const errors = [];
  try {
    const metadata = await getBcmrMetadata(category);
    const uri = metadata.uris?.image ?? metadata.uris?.icon;
    const urls = tokenIconUrls(uri);
    for (const url of urls) {
      try {
        return await loadImage(url);
      } catch (error) {
        errors.push(error);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  throw new AggregateError(errors, `No BCMR token logo could be loaded for ${category}.`);
}
