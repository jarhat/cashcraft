import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

function worker(fetch, caches, clients = {}) {
  const handlers = {};
  const self = {
    location: { origin: 'https://ctf.example' },
    clients,
    addEventListener(type, handler) { handlers[type] = handler; },
  };
  runInNewContext(source, { self, fetch, caches, URL, Promise });
  return handlers;
}

test('only caches the offline fallback, not payment links', async () => {
  const added = [];
  const handlers = worker(() => {}, {
    open: async () => ({ add: async (url) => added.push(url) }),
  });

  let promise;
  handlers.install({ waitUntil(value) { promise = value; } });
  await promise;
  assert.deepEqual(added, ['/offline.html']);
});

test('pairing reminder opens or focuses the existing app without carrying a pairing URI', async () => {
  let focused = 0;
  let opened;
  let windows = [{ url: 'https://ctf.example/?category=abc', focus: async () => { focused++; } }];
  const handlers = worker(() => {}, {}, {
    matchAll: async () => windows,
    openWindow: async (url) => { opened = url; },
  });
  let promise;
  let closed = 0;
  const event = {
    notification: { tag: 'pairing-reminder', close() { closed++; } },
    waitUntil(value) { promise = value; },
  };
  handlers.notificationclick(event);
  await promise;
  assert.equal(focused, 1);
  assert.equal(closed, 1);
  assert.equal(opened, undefined);
  windows = [];
  handlers.notificationclick(event);
  await promise;
  assert.equal(opened, '/');
});

test('navigations use the network including the original query and fall back only offline', async () => {
  const request = { mode: 'navigate', url: 'https://ctf.example/?category=abc&amount=1' };
  const fallback = {};
  let seen;
  const caches = { match: async (path) => path === '/offline.html' ? fallback : null };
  let handlers = worker(async (value) => { seen = value; return 'network'; }, caches);
  let response;
  handlers.fetch({ request, respondWith(value) { response = value; } });
  assert.equal(await response, 'network');
  assert.equal(seen, request);
  handlers = worker(async () => { throw new Error('offline'); }, caches);
  handlers.fetch({ request, respondWith(value) { response = value; } });
  assert.equal(await response, fallback);
});

test('does not intercept API and cross-origin requests', () => {
  const handlers = worker(() => {}, {});
  for (const request of [
    { mode: 'cors', url: 'https://ctf.example/api' },
    { mode: 'navigate', url: 'https://other.example/' },
  ]) {
    let intercepted = false;
    handlers.fetch({ request, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});
