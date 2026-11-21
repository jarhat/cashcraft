import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const shell = await readFile(new URL('../NetCraft/src/shell.html', import.meta.url), 'utf8');
const script = shell.split("<script type='text/javascript'>")[1].split('</script>')[0];

test('mining button and browser favicon use the pickaxe artwork', async () => {
  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const artwork = await readFile(new URL('../public/pickaxe.svg', import.meta.url), 'utf8');
  assert.match(shell, /id="mobile-mine"[^>]*>\s*<img src="\/pickaxe\.svg" alt="" aria-hidden="true">/);
  assert.match(shell, /id="mobile-build"[^>]*>\s*<img src="\/grass-block\.svg" alt="" aria-hidden="true">/);
  assert.match(index, /rel="icon" href="\/pickaxe\.svg"/);
  assert.match(index, /rel="alternate icon" href="\/pickaxe-192\.png"/);
  assert.match(artwork, /viewBox="0 0 16 16"/);
});

test('NetCraft initializes socket settings, touch controls and loading state before errors', () => {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, style: {}, value: '', hidden: false,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      toggleAttribute(name, force) { this[name] = force; },
      classList: {
        add(name) { this.name = name; },
        toggle(name, active) { this[name] = active; },
      },
      setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 100 }; },
    });
    return elements.get(id);
  };
  const document = {
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    getElementById: $,
    querySelector(selector) { return selector === '.mobile-controls' ? $('controls') : null; },
  };
  const parent = {};
  const window = { parent, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const context = { document, window, console, Date, Math };
  runInNewContext(script, context);
  const updates = [];
  context.Module.ccall = (name, result, types, args) => updates.push([name, args[0]]);
  window.listeners.message({ source: {}, data: { type: 'netcraft-reward-address', address: 'spoofed' } });
  window.listeners.message({ source: parent, data: { type: 'netcraft-reward-address', address: 'first', pickaxe: true } });
  window.listeners.message({ source: parent, data: { type: 'netcraft-reward-address', address: '', pickaxe: false } });
  assert.equal(updates.length, 0);
  context.Module.applyPendingRewardAddress();
  window.listeners.message({ source: parent, data: { type: 'netcraft-reward-address', address: 'new', pickaxe: true, connected: true } });
  assert.deepEqual(updates, [['netcraft_set_reward_address', ''], ['mining_set_pickaxe', 0], ['mining_set_wallet_connected', 0], ['netcraft_set_reward_address', 'new'], ['mining_set_pickaxe', 1], ['mining_set_wallet_connected', 1]]);
  window.listeners.message({ source: parent, data: { type: 'netcraft-reward-address', address: '', pickaxe: false } });
  assert.deepEqual(updates.at(-1), ['mining_set_wallet_connected', 0]);
  window.listeners.message({ source: parent, data: { type: 'netcraft-reward-address', address: '', pickaxe: false, guestId: 'a'.repeat(64) } });
  assert.deepEqual(updates.slice(-4), [['netcraft_set_guest_id', 'a'.repeat(64)], ['netcraft_set_reward_address', ''], ['mining_set_pickaxe', 0], ['mining_set_wallet_connected', 0]]);
  updates.length = 0;
  window.listeners.message({ source: {}, data: { type: 'netcraft-share-payment', id: 'abc123456789' } });
  window.listeners.message({ source: parent, data: { type: 'netcraft-share-payment', id: '../not-a-link' } });
  window.listeners.message({ source: parent, data: { type: 'netcraft-share-payment', id: 'abc123456789' } });
  assert.deepEqual(updates, [['netcraft_share_payment', 'abc123456789']]);
  assert.ok(context.Module.websocket);
  assert.equal(typeof $('mobile-mine').listeners.pointerdown, 'function');
  assert.equal(typeof window.listeners.pointermove, 'function');
  assert.equal(typeof $('sound-toggle').listeners.click, 'function');
  assert.equal(typeof context.Module.playBlockSound, 'function');
  let prevented = false;
  document.listeners.contextmenu({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  $('canvas').listeners.webglcontextlost();
  assert.match($('game-error').textContent, /Graphics context lost/);
  context.Module.setConnectionStatus('Connecting', 'Connecting to game server');
  assert.match($('game-error').textContent, /Connecting to game server/);
  assert.equal($('connection-status').textContent, 'Connecting');
  assert.equal($('connection-status').hidden, false);
  context.Module.setStatus.last.time = 0;
  context.Module.setStatus('Downloading... (25/100)');
  assert.equal($('loading-progress').hidden, false);
  assert.equal($('loading-progress').value, 25);
  assert.equal($('loading-progress').max, 100);
  context.Module.setStatus('Preparing world');
  assert.equal($('loading-progress').hidden, true);
  context.Module.setGameReady();
  assert.equal($('loading-screen').classList.name, 'is-ready');
  assert.equal($('loading-screen')['aria-hidden'], 'true');
  context.Module.setConnectionStatus('');
  assert.equal($('connection-status').hidden, true);
});

test('NetCraft reports renderer errors separately from server connection state', () => {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, value: '', hidden: false,
      addEventListener() {}, setAttribute() {},
      classList: { add() {} },
    });
    return elements.get(id);
  };
  const document = { getElementById: $, querySelector: () => $('controls'), addEventListener() {} };
  const window = { addEventListener() {} };
  const context = { document, window, console, Date, Math };
  runInNewContext(script, context);
  context.Module.setConnectionStatus('', 'Connected to game server');
  window.onerror('WebAssembly runtime error');
  assert.match($('game-error').textContent, /renderer could not start.*WebAssembly runtime error.*Connected to game server/);
  assert.equal($('loading-screen').hidden, false);
  context.Module.setConnectionStatus('Disconnected', 'Disconnected from game server');
  assert.match($('game-error').textContent, /renderer could not start.*Disconnected from game server/);
  assert.equal($('game-error').hidden, false);
  context.Module.gameError = '';
  context.Module.setGameReady();
  context.Module.setConnectionStatus('', 'Connected to game server');
  window.onerror('Late failure');
  assert.match($('game-error').textContent, /error after rendering started.*Late failure.*Connected to game server/);
});

test('NetCraft parses encoded launch arguments without splitting encoded characters', async () => {
  const pre = await readFile(new URL('../NetCraft/src/pre.js', import.meta.url), 'utf8');
  const context = { Module: {}, window: {}, document: { location: {
    hash: '#wss%3A%2F%2Fexample.test%2Fcraftws%3Fkey%3Da%2Bb+4080+bitcoincash%3Aztest',
  } } };
  runInNewContext(pre, context);
  assert.deepEqual(Array.from(context.Module.arguments), [
    'wss://example.test/craftws?key=a+b', '4080', 'bitcoincash:ztest',
  ]);
});

test('game audio starts ambience from a gesture and mutes both ambience and effects', async () => {
  const elements = new Map();
  const listeners = {};
  const nodes = [];
  const timers = new Map();
  let timerId = 0;
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, value: '', listeners: {}, attributes: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; }
    });
    return elements.get(id);
  };
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = 'running'; }
    async decodeAudioData(data) { return data; }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createBufferSource() { return { playbackRate: {}, connect() {}, start() { nodes.push('effect'); } }; }
  }
  const document = {
    getElementById: $, querySelector: () => $('controls'),
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const soundStates = [];
  const parent = { postMessage(message) { soundStates.push(message.enabled); } };
  const windowListeners = {};
  const window = { parent, webkitAudioContext: AudioContext, addEventListener(name, callback) { windowListeners[name] = callback; } };
  const music = { paused: true, async play() { this.paused = false; }, pause() { this.paused = true; } };
  const context = {
    document, window, console, Date, Math,
    Blob: class Blob {}, URL: { createObjectURL: () => 'blob:music' },
    Audio: class Audio { constructor() { return music; } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  runInNewContext(script, context);
  context.Module.FS = { readFile: () => new Uint8Array([0, 1]) };
  listeners.pointerdown({ isTrusted: true });
  await new Promise(setImmediate);
  assert.equal($('sound-toggle').attributes['aria-label'], 'Disable sound');
  assert.equal(music.paused, false);
  assert.equal(music.loop, true);
  assert.equal(music.volume, .30);
  assert.deepEqual(nodes, []);
  context.Module.playBlockSound(0);
  assert.equal(nodes.filter((node) => node === 'effect').length, 1);
  context.Module.playGameSound('swim');
  context.Module.playGameSound('dive');
  assert.equal(nodes.filter((node) => node === 'effect').length, 3);
  $('sound-toggle').listeners.click();
  assert.equal(music.paused, true);
  context.Module.playGameSound('dive');
  assert.equal(nodes.filter((node) => node === 'effect').length, 3);
  $('sound-toggle').listeners.click();
  await new Promise(setImmediate);
  assert.equal(music.paused, false);
  context.Module.playBlockSound(1);
  assert.equal(nodes.filter((node) => node === 'effect').length, 4);
  windowListeners.message({ source: parent, data: { type: 'netcraft-reward-address', address: '', embeddedSound: true } });
  assert.equal($('sound-toggle').hidden, true);
  windowListeners.message({ source: {}, data: { type: 'netcraft-set-sound', enabled: false } });
  assert.equal(music.paused, false);
  windowListeners.message({ source: parent, data: { type: 'netcraft-set-sound', enabled: false } });
  assert.equal(music.paused, true);
  windowListeners.message({ source: parent, data: { type: 'netcraft-set-sound', enabled: true } });
  await new Promise(setImmediate);
  assert.equal(music.paused, false);
  assert.deepEqual(soundStates, [true, false, true]);
  assert.equal(timers.size, 0);
});

test('touch controls recover from unavailable pointer capture and release outside', () => {
  const elements = new Map();
  const windowListeners = {};
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, value: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {},
      classList: { add(name) { this.name = name; } },
      focus() { this.focused = true; },
      setPointerCapture() { throw Object.assign(new Error('inactive pointer'), { name: 'InvalidStateError' }); },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100 }; },
    });

    return elements.get(id);
  };
  const document = { getElementById: $, querySelector: () => $('controls'), addEventListener() {} };
  const window = { addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); } };
  const warnings = [];
  const context = { document, window, Date, Math, console: { warn: (...args) => warnings.push(args) } };
  runInNewContext(script, context);
  const calls = [];
  context.Module._touch_set_mine = true;
  context.Module._touch_set_move = true;
  context.Module.ccall = (name, _result, _types, args) => calls.push([name, Array.from(args)]);
  windowListeners.pointerdown.forEach((fn) => fn({ pointerType: 'touch' }));
  assert.equal($('controls').classList.name, 'touch-enabled');
  $('mobile-mine').listeners.pointerdown({ pointerId: 7 });
  windowListeners.pointerup.forEach((fn) => fn({ pointerId: 7 }));
  $('mobile-mine').listeners.pointerdown({ pointerId: 8 });
  windowListeners.blur.forEach((fn) => fn());
  $('mobile-stick').listeners.pointerdown({ pointerId: 9, clientX: 100, clientY: 50 });
  assert.equal($('canvas').focused, true);
  assert.deepEqual(calls.at(-1), ['touch_set_move', [0, 0]]);
  windowListeners.pointermove.forEach((fn) => fn({ pointerId: 9, clientX: 100, clientY: 0 }));
  assert.deepEqual(calls.at(-1), ['touch_set_move', [0, -1]]);
  windowListeners.pointermove.forEach((fn) => fn({ pointerId: 9, clientX: 100, clientY: 100 }));
  assert.deepEqual(calls.at(-1), ['touch_set_move', [0, 1]]);
  windowListeners.pointercancel.forEach((fn) => fn({ pointerId: 9 }));
  assert.deepEqual(calls.filter(([name]) => name === 'touch_set_mine').map(([, args]) => args[0]), [1, 0, 1, 0, 0]);
  assert.deepEqual(calls.at(-1), ['touch_set_move', [0, 0]]);
  assert.equal(warnings.length, 3);
});

test('touch fallback tracks the initiating finger and releases held mining', () => {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, value: '', listeners: {}, classList: { add() {} },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {}, getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 200 }; },
    });
    return elements.get(id);
  };
  const window = { addEventListener() {} };
  const document = { getElementById: $, querySelector: () => $('controls'), addEventListener() {} };
  const context = { document, window, Date, Math, console };
  runInNewContext(script, context);
  const calls = [];
  context.Module._touch_set_move = context.Module._touch_set_mine = context.Module._touch_set_build = true;
  context.Module.ccall = (name, _result, _types, args) => calls.push([name, Array.from(args)]);
  const event = (id, x, y) => ({
    cancelable: true, preventDefault() {},
    changedTouches: [{ identifier: id, clientX: x, clientY: y }],
  });
  $('mobile-stick').listeners.touchstart(event(1, 60, 120));
  $('mobile-stick').listeners.touchmove(event(2, 60, 20));
  $('mobile-stick').listeners.touchmove(event(1, 60, 20));
  assert.deepEqual(calls.at(-1), ['touch_set_move', [0, -1]]);
  $('mobile-mine').listeners.touchstart(event(3, 0, 0));
  $('mobile-mine').listeners.touchend(event(4, 0, 0));
  $('mobile-mine').listeners.touchend(event(3, 0, 0));
  assert.deepEqual(calls.slice(-2), [['touch_set_mine', [1]], ['touch_set_mine', [0]]]);
  $('mobile-build').listeners.touchstart(event(5, 0, 0));
  assert.deepEqual(calls.at(-1), ['touch_set_build', [1]]);
  $('mobile-build').listeners.touchend(event(6, 0, 0));
  assert.deepEqual(calls.at(-1), ['touch_set_build', [1]]);
  $('mobile-build').listeners.touchend(event(5, 0, 0));
  assert.deepEqual(calls.at(-1), ['touch_set_build', [0]]);
  $('mobile-stick').listeners.touchcancel(event(1, 60, 20));
  assert.deepEqual(calls.at(-1), ['touch_set_move', [0, 0]]);
});

test('touch joystick follows its starting finger and moves in every direction with Pointer Events available', () => {
  const elements = new Map();
  const listeners = {};
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, value: '', listeners: {}, classList: { add() {} },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    });
    return elements.get(id);
  };
  const window = { PointerEvent: function() {}, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); } };
  const document = { getElementById: $, querySelector: () => $('controls'), addEventListener() {} };
  const context = { document, window, Date, Math, console };
  runInNewContext(script, context);
  const calls = [];
  context.Module._touch_set_move = true;
  context.Module.ccall = (name, _result, _types, args) => calls.push([name, Array.from(args)]);
  const event = (id, x, y) => ({
    cancelable: true, preventDefault() {},
    changedTouches: [{ identifier: id, clientX: x, clientY: y }],
  });
  $('mobile-stick').listeners.pointerdown({ pointerType: 'touch', pointerId: 1 });
  assert.equal(calls.length, 0);
  $('mobile-stick').listeners.touchstart(event(1, 55, 65));
  assert.equal($('mobile-stick').style.transform, 'translate(5px,15px)');
  listeners.pointercancel.forEach((fn) => fn({ pointerId: 1 }));
  for (const [x, y, expected] of [
    [5, 65, [-1, 0]], [105, 65, [1, 0]],
    [55, 15, [0, -1]], [55, 115, [0, 1]],
  ]) {
    $('mobile-stick').listeners.touchmove(event(1, x, y));
    assert.deepEqual(calls.at(-1), ['touch_set_move', expected]);
    assert.notEqual($('mobile-stick-knob').style.transform, '');
  }
  $('mobile-stick').listeners.touchmove(event(1, 105, 15));
  assert.ok(Math.abs(calls.at(-1)[1][0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(calls.at(-1)[1][1] + Math.SQRT1_2) < 1e-6);
  $('mobile-stick').listeners.touchend(event(2, 55, 65));
  assert.notEqual($('mobile-stick').style.transform, '');
  $('mobile-stick').listeners.touchcancel(event(1, 105, 15));
  assert.equal($('mobile-stick').style.transform, '');
  assert.equal($('mobile-stick-knob').style.transform, '');
  assert.deepEqual(calls.at(-1), ['touch_set_move', [0, 0]]);
});

test('touch block cycling invokes the game without adding a separate chat interface', () => {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, style: {}, value: '', classList: { add() {} },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() { this.focused = true; },
    });
    return elements.get(id);
  };
  const document = { getElementById: $, querySelector: () => $('controls'), addEventListener() {} };
  const window = { PointerEvent: function() {}, addEventListener() {} };
  const context = { document, window, Date, Math, console };
  runInNewContext(script, context);
  const calls = [];
  context.Module._touch_scroll_items = true;
  context.Module.ccall = (name, _result, _types, args) => calls.push([name, Array.from(args)]);
  const strip = $('block-scroll-strip');
  strip.listeners.touchstart({ preventDefault() {}, touches: [{ clientY: 100 }] });
  strip.listeners.touchmove({ preventDefault() {}, touches: [{ clientY: 60 }] });
  assert.equal(calls.length, 0);
  strip.listeners.touchmove({ preventDefault() {}, touches: [{ clientY: 44 }] });
  assert.deepEqual(calls, [['touch_scroll_items', [1]]]);
  strip.listeners.touchmove({ preventDefault() {}, touches: [{ clientY: 100 }] });
  assert.deepEqual(calls.at(-1), ['touch_scroll_items', [-1]]);
  assert.doesNotMatch(shell, /id="mobile-chat"|id="touch-chat"/);
});
