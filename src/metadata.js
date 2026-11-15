export async function fetchTokenMetadata(category, network, fetcher = fetch) {
  if (!/^[0-9a-f]{64}$/.test(category)) {
    throw new Error('Invalid token category.');
  }
  const host = network === 'mainnet'
    ? 'https://bcmr.paytaca.com'
    : 'https://bcmr-chipnet.paytaca.com';
  const response = await fetcher(`${host}/api/tokens/${category}/`);
  if (!response.ok) throw new Error(`Metadata service returned HTTP ${response.status}`);
  const data = await response.json();
  if (data?.token?.category?.toLowerCase() !== category) {
    throw new Error('Metadata category did not match the requested token.');
  }
  return {
    name: typeof data.name === 'string' ? data.name : '',
    symbol: typeof data.token.symbol === 'string' ? data.token.symbol : '',
    description: typeof data.description === 'string' ? data.description : '',
    decimals: Number.isInteger(data.token.decimals) ? data.token.decimals : null,
  };
}
