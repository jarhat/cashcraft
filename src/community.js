function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export async function setupCommunity(env) {
  for (const [id, value] of [
    ['social-github', env.VITE_GITHUB_URL || 'https://github.com/jarhat/cashcraft'],
    ['social-telegram', env.VITE_TELEGRAM_URL],
  ]) {
    const link = document.getElementById(id);
    const url = httpsUrl(value);
    if (url) {
      link.href = url;
      link.hidden = false;
    } else if (value) {
      console.warn(`Invalid HTTPS URL for ${id}`);
    }
  }

  const ticker = document.getElementById('market-ticker');
  const gallery = document.getElementById('gallery-feed');

  async function loadPrices() {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false');
      if (!response.ok) throw new Error(`Price service returned HTTP ${response.status}`);
      const coins = await response.json();
      if (!Array.isArray(coins) || !coins.length) throw new Error('Price service returned no coins');
      const items = coins.slice(0, 20).filter((coin) => typeof coin.symbol === 'string' && Number.isFinite(coin.current_price));
      if (!items.length) throw new Error('Price service returned no valid prices');
      ticker.replaceChildren(...items.map((coin) => {
        const item = document.createElement('span');
        item.className = 'ticker-item';
        item.textContent = `${coin.symbol.toUpperCase()} $${coin.current_price.toLocaleString(undefined, { maximumFractionDigits: coin.current_price < 1 ? 6 : 2 })}`;
        return item;
      }));
    } catch (error) {
      console.warn('Market prices unavailable:', error);
      ticker.textContent = 'Market prices temporarily unavailable';
    }
  }

  async function loadGallery() {
    if (!env.VITE_GALLERY_FEED_URL) return;
    const url = httpsUrl(env.VITE_GALLERY_FEED_URL);
    if (!url) {
      gallery.textContent = 'Gallery feed URL must use HTTPS.';
      return;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Gallery service returned HTTP ${response.status}`);
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error('Gallery feed must be an array');
      const cards = items.slice(0, 12).flatMap((item) => {
        const image = httpsUrl(item?.image);
        const link = httpsUrl(item?.url);
        if (!image || !link || typeof item.title !== 'string') return [];
        const card = document.createElement('a');
        card.className = 'gallery-card';
        card.href = link;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
        const thumbnail = document.createElement('img');
        thumbnail.src = image;
        thumbnail.alt = '';
        thumbnail.loading = 'lazy';
        const title = document.createElement('span');
        title.textContent = item.title;
        card.append(thumbnail, title);
        return [card];
      });
      if (!cards.length) throw new Error('Gallery feed contained no valid items');
      gallery.replaceChildren(...cards);
    } catch (error) {
      console.warn('Gallery unavailable:', error);
      gallery.textContent = 'Gallery temporarily unavailable. Visit bch.now to explore.';
    }
  }

  await Promise.all([loadPrices(), loadGallery()]);
  setInterval(loadPrices, 5 * 60 * 1000);
  if (env.VITE_GALLERY_FEED_URL) setInterval(loadGallery, 5 * 60 * 1000);
}
