import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCategoryIcon } from '../src/category-icon.js';

test('category icons use metadata and ignore stale results', async () => {
  const field = { value: 'a'.repeat(64) };
  const icon = {
    hidden: true, textContent: '',
    replaceChildren(image) { this.image = image; },
  };
  const pending = new Map();
  const options = {
    mainnet: true, logger: { warn() { throw new Error('Unexpected error'); } },
    loadTokenLogo(category) { return new Promise((resolve) => pending.set(category, resolve)); },
  };
  updateCategoryIcon(field, icon, options);
  assert.equal(icon.hidden, false);
  field.value = 'b'.repeat(64);
  updateCategoryIcon(field, icon, options);
  pending.get('a'.repeat(64))({ id: 'old' });
  pending.get('b'.repeat(64))({ id: 'new' });
  await Promise.resolve();
  assert.equal(icon.image.id, 'new');
  field.value = '';
  updateCategoryIcon(field, icon, options);
  assert.equal(icon.hidden, true);
});

test('unknown and chipnet categories retain a generic icon', () => {
  const icon = {};
  const options = { mainnet: false, loadTokenLogo() { throw new Error('Unexpected lookup'); } };
  updateCategoryIcon({ value: 'a'.repeat(64) }, icon, options);
  assert.equal(icon.textContent, '◆');
  assert.equal(icon.hidden, false);
});
