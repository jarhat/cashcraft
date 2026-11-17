import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPairingReminder } from '../src/pairing-reminder.js';

function harness(t, permission = 'default') {
  const listeners = {};
  const button = { hidden: true, addEventListener(_type, fn) { this.click = fn; } };
  const status = {};
  const openWallet = { addEventListener(_type, fn) { this.click = fn; } };
  const document = { hidden: false, addEventListener(type, fn) { listeners[type] = fn; } };
  const notifications = {
    permission,
    async requestPermission() { this.permission = 'granted'; return this.permission; },
  };
  const shown = [];
  let closed = 0;
  const registration = {
    active: {},
    async showNotification(title, options) { shown.push({ title, options }); },
    async getNotifications() { return [{ close() { closed++; } }]; },
  };
  const timers = new Map();
  let next = 0;
  let uri = 'wiz:private-pairing-uri';
  const globals = {
    window: { isSecureContext: true, Notification: notifications },
    navigator: { serviceWorker: { getRegistration: async () => registration } },
    document,
    setTimeout: (callback) => { timers.set(++next, callback); return next; },
    clearTimeout: (id) => timers.delete(id),
  };
  const original = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const reminder = setupPairingReminder({
    button, status, openWallet, pendingUri: () => uri,
    translate: (text) => text, logger: { warn() {} },
  });
  return {
    button, status, openWallet, document, listeners, shown, reminder, timers, registration,
    setUri(value) { uri = value; },
    get closed() { return closed; },
    fire() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test('permission is opt-in and a pending hidden pairing produces a private reminder', async (t) => {
  const h = harness(t);
  assert.equal(h.button.hidden, false);
  await h.button.click();
  assert.equal(h.button.hidden, true);
  h.openWallet.click();
  h.document.hidden = true;
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].options.tag, 'pairing-reminder');
  assert.doesNotMatch(JSON.stringify(h.shown[0]), /wiz:private/);
  h.reminder.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.closed, 1);
});

test('completed or replaced pairing does not trigger a reminder', async (t) => {
  const h = harness(t, 'granted');
  h.openWallet.click();
  h.document.hidden = true;
  h.setUri(null);
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.shown.length, 0);
  h.setUri('wiz:first');
  h.openWallet.click();
  h.setUri('wiz:second');
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.shown.length, 0);
});

test('foreground and blocked notifications use the in-page reminder', async (t) => {
  const h = harness(t, 'denied');
  assert.equal(h.button.hidden, true);
  assert.match(h.status.textContent, /blocked/);
  h.openWallet.click();
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.status.textContent, /Still connecting/);
  assert.equal(h.shown.length, 0);
});

test('a late notification is cleared if pairing completes while it is being shown', async (t) => {
  const h = harness(t, 'granted');
  let release;
  h.registration.showNotification = () => new Promise((resolve) => { release = resolve; });
  h.openWallet.click();
  h.document.hidden = true;
  h.fire();
  await new Promise((resolve) => setImmediate(resolve));
  h.setUri(null);
  h.reminder.cancel();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.closed, 1);
});
