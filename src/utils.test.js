import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentRequestUrl } from './utils.js';

test('payment links include only requested details and replace old parameters', () => {
  const address = 'bchtest:zexample';
  const base = 'https://example.com/wallet?amount=99#old';
  const plain = new URL(paymentRequestUrl(base, address, '', ''));
  assert.equal(plain.searchParams.get('addr'), address);
  assert.equal(plain.searchParams.has('amount'), false);
  assert.equal(plain.hash, '');

  const category = 'ab'.repeat(32);
  const detailed = new URL(paymentRequestUrl(base, address, category, '12'));
  assert.equal(detailed.searchParams.get('category'), category);
  assert.equal(detailed.searchParams.get('amount'), '12');
});

test('payment links reject invalid optional request details', () => {
  assert.throws(() => paymentRequestUrl('https://example.com/', 'addr', 'abc', ''));
  for (const amount of ['0', '-1', '1.5']) {
    assert.throws(() => paymentRequestUrl('https://example.com/', 'addr', '', amount));
  }
});
