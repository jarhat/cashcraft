import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentQrImage } from '../src/payment-qr-image.js';

test('payment image includes the QR and complete amount and category', () => {
  const calls = [];
  const context = {
    fillRect(...args) { calls.push(['fillRect', ...args]); },
    drawImage(...args) { calls.push(['drawImage', ...args]); },
    fillText(...args) { calls.push(['fillText', ...args]); },
  };
  const canvas = { getContext: () => context };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => canvas };
  try {
    const qr = {};
    const amount = '1234567890'.repeat(5);
    const category = 'abcdef01'.repeat(8);
    assert.equal(createPaymentQrImage(qr, amount, category, (text) => text), canvas);
    assert.ok(calls.some(([type, image]) => type === 'drawImage' && image === qr));
    const text = calls.filter(([type]) => type === 'fillText').map(([, value]) => value);
    assert.deepEqual(text, ['Amount', amount.slice(0, 40), amount.slice(40),
      'Token category ID', category.slice(0, 40), category.slice(40)]);
    assert.ok(calls.filter(([type]) => type === 'fillText').every(([, , , y]) => y + 26 <= canvas.height));
  } finally {
    globalThis.document = oldDocument;
  }
});
