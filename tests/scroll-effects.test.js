import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateScrollEffects } from '../src/scroll-effects.js';

function element(rect) {
  const properties = {};
  return {
    properties,
    getBoundingClientRect: () => rect,
    style: { setProperty: (name, value) => { properties[name] = value; } },
    classList: { toggle: (name, value) => { properties[name] = value; } },
  };
}

test('hero text fades under the navbar and the bar fades over panels', () => {
  const bar = element({ top: 0, bottom: 60, left: 0, right: 200, height: 60 });
  const hero = element({ top: 30 });
  const panel = element({ top: 30, bottom: 200, left: 0, right: 200 });
  updateScrollEffects(bar, hero, [panel]);
  assert.equal(bar.properties['--navbar-opacity'], 0.5);
  assert.equal(hero.properties['--hero-mask-end'], '42px');
  panel.getBoundingClientRect = () => ({ top: -20, bottom: 200, left: 0, right: 200 });
  updateScrollEffects(bar, hero, [panel]);
  assert.equal(bar.properties['--navbar-opacity'], 0);
  assert.equal(bar.properties['is-obscured'], true);
  panel.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: 200 });
  updateScrollEffects(bar, hero, [panel]);
  assert.equal(bar.properties['--navbar-opacity'], 1);
  assert.equal(bar.properties['is-obscured'], false);
});
