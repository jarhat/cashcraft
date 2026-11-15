export const API_BASE_URL = 'https://auth.ctf.cash';

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

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.detail ?? `Address API error (${response.status})`,
    );
  }
  return result.cash_address;
}
