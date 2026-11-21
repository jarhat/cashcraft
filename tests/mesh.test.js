import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { meshPath, setupMesh } from '../src/mesh.js';

test('perspective mesh converges at the horizon and shares intersections through the bulge', async () => {
  const width = 800;
  const height = 400;
  const lines = meshPath(width, height).split(' M').map((line, index) =>
    (index === 0 ? line.slice(1) : line).split(' L').map((point) => point.split(',').map(Number)));
  const horizontal = lines.slice(0, 9);
  const vertical = lines.slice(9);
  for (const [index, points] of horizontal.entries()) {
    const y = (index + 1) * 40;
    assert.ok(points[0][0] > 0);
    assert.ok(points.at(-1)[0] < width);
    for (let x = 0; x < width; x += 40) {
      assert.deepEqual(points[x / 8], vertical[x / 40][y / 8]);
    }
  }
  assert.ok(horizontal[4][50][1] < horizontal[4][0][1]);
  assert.ok(vertical[0][0][0] > vertical[0].at(-1)[0]);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /body::before\s*\{\s*content:\s*none;/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('class="mesh-landscape"') > html.indexOf('<header class="topbar">'));
  assert.ok(html.indexOf('class="mesh-landscape"') < html.indexOf('</header>'));
  assert.doesNotMatch(html, /data-theme-option/);
  assert.match(css, /\.mesh-start\s*\{\s*stop-color:\s*var\(--mesh-color\)/);
  assert.match(css, /\.mesh-end\s*\{\s*stop-color:\s*var\(--mesh-highlight\)/);
  assert.doesNotMatch(html, /id="mesh-rgb"/);
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
