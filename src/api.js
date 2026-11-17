export const API_BASE_URL = '';

export async function submitCashAddress(cashAddress) {
  if (typeof cashAddress !== 'string' || !cashAddress.trim()) {
    throw new TypeError('A cash address is required.');
  }

  const response = await fetch(`${API_BASE_URL}/api/cash-address`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      cash_address: cashAddress.trim(),
    }),
  });

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`Address API returned an invalid response (${response.status}).`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(
      typeof result?.detail === 'string' ? result.detail : `Address API error (${response.status})`,
    );
  }
  if (typeof result?.cash_address !== 'string' ||
      result.cash_address.toLowerCase() !== cashAddress.trim().toLowerCase()) {
    throw new Error('Address API did not confirm the submitted address.');
  }
  return result.cash_address;
}

async function shortLinkRequest(path, body) {
  const response = await fetch(`${API_BASE_URL}/api/short-link${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Link service returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(typeof result?.detail === 'string' ? result.detail : `Link service error (${response.status})`);
  }
  return result;
}

export const createShortLink = (link) => shortLinkRequest('', link);
export const openShortLink = (id) => shortLinkRequest(`/${encodeURIComponent(id)}/open`);
