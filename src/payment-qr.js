const INDEXER = 'https://bcmr.paytaca.com/api/tokens/';

export function logoUrl(uri) {
  if (typeof uri !== 'string') return null;
  const address = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export async function fetchTokenLogo(category) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${INDEXER}${category}/icon-symbol`, { signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`BCMR indexer returned HTTP ${response.status}`);
    const metadata = await response.json();
    return logoUrl(metadata.icon_uri);
  } finally {
    clearTimeout(timeout);
  }
}

export function drawTokenLogo(canvas, url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => {
      image.src = '';
      reject(new Error('Token logo timed out'));
    }, 5000);
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      clearTimeout(timeout);
      const context = canvas.getContext('2d');
      const size = canvas.width * .12;
      const x = (canvas.width - size) / 2;
      context.fillStyle = '#fff';
      context.beginPath();
      context.arc(canvas.width / 2, canvas.height / 2, size * .58, 0, Math.PI * 2);
      context.fill();
      context.save();
      context.beginPath();
      context.arc(canvas.width / 2, canvas.height / 2, size / 2, 0, Math.PI * 2);
      context.clip();
      context.drawImage(image, x, x, size, size);
      context.restore();
      resolve();
    };
    image.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Token logo could not be loaded with CORS'));
    };
    image.src = url;
  });
}
