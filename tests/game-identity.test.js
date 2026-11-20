import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGameGuestId } from '../src/game-identity.js';

test('guest mining identity survives refresh and rejects corrupt storage', (t) => {
  const previous = globalThis.localStorage;
  t.after(() => { globalThis.localStorage = previous; });
  let value = null;
  globalThis.localStorage = {
    getItem: () => value,
    setItem(key, id) { value = id; },
  };
  const id = getGameGuestId();
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(getGameGuestId(), id);
  value = 'invalid';
  assert.throws(getGameGuestId, /invalid/);
});
