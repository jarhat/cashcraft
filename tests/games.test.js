import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupGames } from '../src/games.js';

test('game buttons open mounted shells and unload them on close', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      classList: { add() {}, remove() {} },
      showModal() { this.open = true; }, close() { this.open = false; this.listeners.close(); },
      removeAttribute(name) { delete this[name]; },
    });
    return elements.get(id);
  };
  let url, beer = 0;
  globalThis.fetch = async (target) => {
    url = target;
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>game</html>' };
  };
  setupGames($, { claimBeer: () => { beer++; }, translate: (text) => text });
  await $('game-netcraft').listeners.click();
  assert.equal(url, '/games/netcraft/craftw.html');
  assert.equal($('game-frame').src, url);
  $('game-close').listeners.click();
  assert.equal($('game-frame').src, undefined);
  await $('game-pk2').listeners.click();
  assert.equal(url, '/games/pk2/index.html');
  await $('switch-netcraft').listeners.click();
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html');
  assert.equal($('switch-netcraft')['aria-pressed'], 'true');
  assert.equal($('switch-pk2')['aria-pressed'], 'false');
  $('game-minimize').listeners.click();
  assert.equal($('game-dialog').open, false);
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html');
  assert.equal($('game-restore').hidden, false);
  $('game-restore').listeners.click();
  assert.equal($('game-dialog').open, true);
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html');
  globalThis.fetch = async () => ({ ok: false, headers: { get: () => '' } });
  await $('switch-pk2').listeners.click();
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html');
  assert.match($('game-dialog-status').textContent, /unavailable/);
  let resolveSwitch;
  globalThis.fetch = () => new Promise((resolve) => { resolveSwitch = resolve; });
  const pendingSwitch = $('switch-pk2').listeners.click();
  await $('switch-netcraft').listeners.click();
  resolveSwitch({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>game</html>' });
  await pendingSwitch;
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html');
  assert.equal($('game-dialog-status').textContent, '');
  $('game-beer').listeners.click();
  assert.equal(beer, 1);
  $('game-close').listeners.click();
  globalThis.fetch = async () => ({ ok: false, headers: { get: () => '' } });
  await $('game-pk2').listeners.click();
  assert.match($('game-status').textContent, /unavailable/);
  assert.equal($('game-dialog').open, false);
  globalThis.fetch = async () => ({
    ok: true, headers: { get: () => 'text/html' },
    text: async () => '<button id="game-netcraft">fallback</button>',
  });
  await $('game-netcraft').listeners.click();
  assert.match($('game-status').textContent, /unavailable/);
  assert.equal($('game-dialog').open, false);
});
