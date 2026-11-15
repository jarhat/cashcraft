export async function loadTokenLogo(category) {
  const response = await fetch(`https://bcmr.paytaca.com/api/tokens/${category}/icon-symbol`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`BCMR lookup failed (${response.status}).`);
  const metadata = await response.json();
  if (metadata.category !== category || !metadata.icon_uri) {
    throw new Error('No BCMR token logo was found for this category.');
  }
  const uri = metadata.icon_uri.startsWith('ipfs://')
    ? `https://ipfs.io/ipfs/${metadata.icon_uri.slice(7)}`
    : metadata.icon_uri;
  const url = new URL(uri);
  if (url.protocol !== 'https:') throw new Error('The BCMR token logo must use HTTPS.');
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.src = '';
      reject(new Error('The BCMR token logo timed out.'));
    }, 5000);
    image.crossOrigin = 'anonymous';
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('The BCMR token logo could not be loaded.')); };
    image.src = url.href;
  });
}
