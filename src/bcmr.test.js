import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokenAmount, parseRegistry } from './bcmr.js';

const category = 'ab'.repeat(32);

test('reads the latest BCMR token revision by category', () => {
  const registry = {
    identities: {
      authority: {
        '2024-01-01T00:00:00Z': { name: 'Old', token: { category } },
        '2025-01-01T00:00:00Z': {
          name: 'Example',
          description: 'Example token',
          token: { category: category.toUpperCase(), symbol: 'EX', decimals: 2 },
          uris: { icon: 'https://example.test/icon.png' },
        },
      },
    },
  };
  const token = parseRegistry(registry).get(category);
  assert.equal(token.name, 'Example');
  assert.equal(token.description, 'Example token');
  assert.equal(token.symbol, 'EX');
  assert.equal(token.decimals, 2);
  assert.equal(token.iconUrl, 'https://example.test/icon.png');
});

test('rejects invalid registries and ignores unsafe icons and invalid revisions', () => {
  assert.throws(() => parseRegistry({}), /identities/);
  const tokens = parseRegistry({ identities: { authority: {
    invalid: { token: { category } },
    '2025-01-01T00:00:00Z': {
      token: { category, decimals: -1 }, uris: { icon: 'javascript:alert(1)' },
    },
  } } });
  assert.equal(tokens.get(category).iconUrl, '');
  assert.equal(tokens.get(category).decimals, null);
});

test('formats large base-unit amounts without floating point loss', () => {
  assert.equal(formatTokenAmount('123456789012345678901', 2), '1234567890123456789.01');
  assert.equal(formatTokenAmount('1', 3), '0.001');
  assert.equal(formatTokenAmount('1200', 2), '12');
  assert.equal(formatTokenAmount('12', null), '12');
});
