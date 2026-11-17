import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSnow } from '../src/snow.js';

test('snow falls, pauses when hidden, and respects motion preference changes and resize', (t) => {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const motionListeners = new Map();
  const motion = {
    matches: false,
    addEventListener: (type, fn) => motionListeners.set(type, fn),
    removeEventListener: (type) => motionListeners.delete(type),
  };
  const window = {
    innerWidth: 400,
    innerHeight: 300,
    devicePixelRatio: 1,
    matchMedia: () => motion,
    addEventListener: (type, fn) => windowListeners.set(type, fn),
    removeEventListener: (type) => windowListeners.delete(type),
  };
  const document = {
    hidden: false,
    addEventListener: (type, fn) => documentListeners.set(type, fn),
    removeEventListener: (type) => documentListeners.delete(type),
  };
  const callbacks = new Map();
  let nextFrame = 0;
  const globals = {
    window,
    document,
    requestAnimationFrame: (callback) => {
      callbacks.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id) => callbacks.delete(id),
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
  const points = [];
  const ctx = {
    setTransform() {},
    clearRect() { points.length = 0; },
    beginPath() {},
    moveTo() {},
    arc(x, y) { points.push({ x, y }); },
    fill() {},
  };
  const canvas = { getContext: () => ctx };
  const cleanup = setupSnow(canvas);
  const tick = (time) => {
    const [id, callback] = callbacks.entries().next().value;
    callbacks.delete(id);
    callback(time);
  };

  const now = performance.now();
  tick(now + 40);
  const first = points.map(({ y }) => y);
  assert.ok(first.length > 0);
  tick(now + 80);
  assert.ok(points.every(({ y }, index) => y > first[index]));
  document.hidden = true;
  documentListeners.get('visibilitychange')();
  assert.equal(callbacks.size, 0);
  document.hidden = false;
  documentListeners.get('visibilitychange')();
  assert.equal(callbacks.size, 1);
  motion.matches = true;
  motionListeners.get('change')();
  assert.equal(callbacks.size, 0);
  window.innerWidth = 500;
  windowListeners.get('resize')();
  assert.ok(points.length > 0);
  motion.matches = false;
  motionListeners.get('change')();
  assert.equal(callbacks.size, 1);
  cleanup();
  assert.equal(callbacks.size, 0);
  assert.equal(windowListeners.size + documentListeners.size + motionListeners.size, 0);
});
