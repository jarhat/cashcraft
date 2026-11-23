import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupWikiGlossary } from '../src/wiki-glossary.js';

test('glossary closes other terms, dismisses outside clicks and handles Escape', () => {
  const listeners = {};
  const terms = [0, 1].map(() => {
    const summary = {
      addEventListener(_type, callback) { this.click = callback; },
      focus() { this.focused = true; },
    };
    return { open: false, summary, querySelector: () => summary };
  });
  const dialog = {
    querySelectorAll: () => terms,
    addEventListener(type, callback) { listeners[type] = callback; },
  };
  setupWikiGlossary(dialog);
  terms[0].open = true;
  terms[1].summary.click();
  assert.equal(terms[0].open, false);
  terms[1].open = true;
  listeners.click({ target: { closest: () => terms[1] } });
  assert.equal(terms[1].open, true);
  let prevented = false;
  listeners.keydown({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(terms[1].open, false);
  assert.equal(terms[1].summary.focused, true);
  terms[0].open = true;
  listeners.click({ target: { closest: () => null } });
  assert.equal(terms[0].open, false);
  terms[0].open = true;
  listeners.close();
  assert.equal(terms[0].open, false);
});
