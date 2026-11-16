const MARKET_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false';

export async function fetchTopCoins() {
  const response = await fetch(MARKET_URL, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Market data request failed (${response.status}).`);
  const coins = await response.json();
  if (!Array.isArray(coins) || coins.length < 20 || coins.slice(0, 20).some((coin) =>
    typeof coin.symbol !== 'string' || !coin.symbol ||
    typeof coin.current_price !== 'number' || !Number.isFinite(coin.current_price) || coin.current_price < 0)) {
    throw new Error('Market data did not contain 20 valid coins.');
  }
  return coins.slice(0, 20);
}

export function setupMarketTicker(container, translate, logger = console) {
  async function refresh() {
    try {
      const coins = await fetchTopCoins();
      const track = document.createElement('div');
      track.className = 'market-ticker-track';
      for (let copy = 0; copy < 2; copy++) {
        const group = document.createElement('div');
        group.className = 'market-ticker-group';
        if (copy) group.setAttribute('aria-hidden', 'true');
        for (const coin of coins) {
          const item = document.createElement('span');
          item.className = 'market-ticker-item';
          const symbol = document.createElement('strong');
          symbol.textContent = coin.symbol.toUpperCase();
          const price = document.createElement('span');
          price.textContent = coin.current_price.toLocaleString(undefined, coin.current_price < 1
            ? { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }
            : { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
          item.append(symbol, price);
          group.append(item);
        }
        track.append(group);
      }
      container.replaceChildren(track);
    } catch (error) {
      logger.warn('Cryptocurrency market data unavailable:', error);
      if (!container.querySelector('.market-ticker-track')) {
        container.textContent = translate('Market prices unavailable.');
      }
    }
  }
  refresh();
  setInterval(refresh, 5 * 60 * 1000);
}
