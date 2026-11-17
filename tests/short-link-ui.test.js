import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('one-time links use fixed expiry and replace the displayed QR, while stale responses are ignored', async () => {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, value: '', textContent: '', hidden: false, width: 512,
      classList: { contains: () => false },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      querySelector: () => null,
      getContext: () => ({ drawImage() {} }),
    });
    return elements.get(id);
  };
  $('short-link-type').value = 'one-time';
  $('short-link-expiry').value = '1d';
  $('payment-url').textContent = `https://example.test/?addr=test&category=${'a'.repeat(64)}&amount=3`;
  $('receive-note').value = 'hello';
  const calls = [];
  let resolveLink;
  let linkPromise = new Promise((resolve) => { resolveLink = resolve; });
  const start = source.indexOf('let originalPaymentQr = null;');
  const end = source.indexOf("\nfor (const id of ['receive-address'", start);
  const context = {
    $, URL, translate: (text) => text, navigator: {}, setTimeout,
    document: { createElement: () => ({}) },
    createShortLink: (body) => { calls.push(body); return linkPromise; },
    QRCode: { toCanvas: async (_canvas, url) => { calls.push(url); } },
  };
  runInNewContext(source.slice(start, end), context);
  $('short-link-type').listeners.change();
  assert.equal($('short-link-expiry').disabled, true);
  assert.equal($('one-time-expiry-hint').hidden, false);
  const pending = $('create-short-link').listeners.click();
  assert.equal(calls[0].expires_in, '1w');
  assert.equal(calls[0].note, 'hello');
  resolveLink({ id: 'abc123456789', one_time: true });
  await pending;
  assert.equal(calls[1], 'https://example.test/s/abc123456789');
  assert.equal($('short-link-url').textContent, calls[1]);
  assert.equal($('short-link-result').hidden, false);
  $('short-link-type').value = 'persistent';
  $('short-link-type').listeners.change();
  assert.equal($('short-link-expiry').disabled, false);
  assert.equal($('short-link-result').hidden, true);
  linkPromise = new Promise((resolve) => { resolveLink = resolve; });
  const stale = $('create-short-link').listeners.click();
  $('receive-note').listeners.input();
  resolveLink({ id: 'def123456789', one_time: false });
  await stale;
  assert.equal($('short-link-result').hidden, true);
  assert.equal(calls.filter((entry) => typeof entry === 'string').length, 1);
});
