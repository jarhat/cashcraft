import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { meshPath, setupMesh } from '../src/mesh.js';

test('mesh lines join the 40px grid and share intersections through the bulge', async () => {
  const width = 800;
  const height = 400;
  const lines = meshPath(width, height).split(' M').map((line, index) =>
    (index === 0 ? line.slice(1) : line).split(' L').map((point) => point.split(',').map(Number)));
  const horizontal = lines.slice(0, 9);
  const vertical = lines.slice(9);
  for (const [index, points] of horizontal.entries()) {
    const y = (index + 1) * 40;
    assert.deepEqual(points[0], [0, y]);
    assert.deepEqual(points.at(-1), [width, y]);
    for (let x = 0; x < width; x += 40) {
      assert.deepEqual(points[x / 8], vertical[x / 40][y / 8]);
    }
  }
  assert.ok(horizontal[4][50][1] < 200);
  assert.notEqual(vertical[8][25][0], 320);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /body::before\s*\{[^}]*background-size:\s*40px 40px/s);
});

test('mesh regenerates once per resize frame with the current dimensions', (t) => {
  const original = { window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame };
  t.after(() => Object.assign(globalThis, original));
  const handlers = {};
  const frames = [];
  globalThis.window = { addEventListener(type, handler) { handlers[type] = handler; } };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  const path = { setAttribute(_name, value) { this.d = value; } };
  const svg = {
    width: 320,
    querySelector: () => path,
    getBoundingClientRect() { return { width: this.width, height: 240 }; },
    setAttribute(_name, value) { this.viewBox = value; },
  };
  setupMesh(svg);
  assert.equal(svg.viewBox, '0 0 320 240');
  const initial = path.d;
  svg.width = 480;
  handlers.resize();
  handlers.resize();
  assert.equal(frames.length, 1);
  frames[0]();
  assert.equal(svg.viewBox, '0 0 480 240');
  assert.notEqual(path.d, initial);
});
