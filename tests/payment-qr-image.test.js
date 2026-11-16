import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentQrImage } from '../src/payment-qr-image.js';

test('payment image includes the QR, complete payment request and timestamped price', () => {
  const calls = [];
  const context = {
    fillRect(...args) { calls.push(['fillRect', this.fillStyle, ...args]); },
    drawImage(...args) { calls.push(['drawImage', ...args]); },
    fillText(...args) { calls.push(['fillText', ...args]); },
    measureText(text) { return { width: Array.from(text).length * 12 }; },
    save() {}, restore() {}, translate() {}, beginPath() {}, arc() {}, fill() {}, rotate() {},
  };
  const canvas = { getContext: () => context };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => canvas };
  try {
    const qr = {};
    const amount = '1234567890'.repeat(5);
    const category = 'abcdef01'.repeat(8);
    const address = `bitcoincash:${'z'.repeat(42)}`;
    const price = '0.001 BCH / base unit · 2026-11-16T00:00:00.000Z';
    const note = 'Thank you!\nFor lunch';
    const translations = { Amount: 'Montant', 'Recipient address': 'Adresse', 'Token category ID': 'Catégorie', 'Indicative token price': 'Prix', 'Sharing note': 'Note' };
    assert.equal(createPaymentQrImage(qr, { amount, category, address, price, note }, (text) => translations[text] || text), canvas);
    assert.ok(calls.some(([type, image]) => type === 'drawImage' && image === qr));
    assert.ok(calls.some(([type, color]) => type === 'fillRect' && color === '#000000'));
    assert.equal(context.fillStyle, '#ffffff');
    const text = calls.filter(([type]) => type === 'fillText').map(([, value]) => value);
    const amountText = `${amount} token base units`;
    assert.deepEqual(text, ['Montant', amountText.slice(0, 40), amountText.slice(40),
      'Adresse', address.slice(0, 40), address.slice(40),
      'Catégorie', category.slice(0, 40), category.slice(40),
      'Prix', price.slice(0, 40), price.slice(40), 'Note', 'Thank you!', 'For lunch', '₿', 'BCH']);
    assert.ok(calls.filter(([type]) => type === 'fillText').every(([, , , y]) => y + 26 <= canvas.height));
  } finally {
    globalThis.document = oldDocument;
  }
});

test('omits unavailable prices and wraps wide sharing notes without dropping characters', () => {
  const text = [];
  const context = {
    fillRect() {}, drawImage() {}, fillText(value) { text.push(value); },
    measureText(value) { return { width: Array.from(value).length * 20 }; },
    save() {}, restore() {}, translate() {}, beginPath() {}, arc() {}, fill() {}, rotate() {},
  };
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  const note = '雪'.repeat(35);
  try {
    createPaymentQrImage({}, { amount: '1', category: 'a'.repeat(64), address: 'bitcoincash:ztest', note }, (value) => value);
    assert.ok(!text.includes('Indicative token price'));
    const index = text.indexOf('Sharing note');
    assert.equal(text[index + 1] + text[index + 2], note);
    assert.equal(text[index + 1].length, 28);
  } finally { globalThis.document = original; }
});
