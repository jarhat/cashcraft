import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateScrollEffects } from '../src/scroll-effects.js';

test('panel scroll offset tracks the actual navbar height', () => {
  const previous = globalThis.document;
  const properties = {};
  globalThis.document = { documentElement: { style: { setProperty: (name, value) => { properties[name] = value; } } } };
  try {
    const bar = { getBoundingClientRect: () => ({ height: 75.5 }) };
    updateScrollEffects(bar);
    assert.equal(properties['--topbar-height'], '76px');
    bar.getBoundingClientRect = () => ({ height: 120 });
    updateScrollEffects(bar);
    assert.equal(properties['--topbar-height'], '120px');
  } finally {
    globalThis.document = previous;
  }
});
