import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const shell = await readFile(new URL('../NetCraft/src/shell.html', import.meta.url), 'utf8');
const script = shell.split("<script type='text/javascript'>")[1].split('</script>')[0];

test('NetCraft initializes socket settings, touch controls and loading state before errors', () => {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, style: {}, value: '', hidden: false,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
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
  const window = { addEventListener() {} };
  const context = { document, window, console, Date, Math };
  runInNewContext(script, context);
  assert.ok(context.Module.websocket);
  assert.equal(typeof $('mobile-mine').listeners.pointerdown, 'function');
  assert.equal(typeof $('mobile-stick').listeners.pointermove, 'function');
  assert.equal(typeof $('sound-toggle').listeners.click, 'function');
  assert.equal(typeof context.Module.playBlockSound, 'function');
  let prevented = false;
  document.listeners.contextmenu({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  $('canvas').listeners.webglcontextlost();
  assert.match($('connection-status').textContent, /Graphics context lost/);
  context.Module.setConnectionStatus('');
  assert.equal($('connection-status').hidden, false);
  context.Module.graphicsLost = false;
  context.Module.setConnectionStatus('Connecting');
  assert.equal($('connection-status').textContent, 'Connecting');
  assert.equal($('connection-status').hidden, false);
  context.Module.setGameReady();
  assert.equal($('loading-screen').hidden, true);
  context.Module.setConnectionStatus('');
  assert.equal($('connection-status').hidden, true);
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
