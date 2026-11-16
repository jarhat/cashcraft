import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

test('console levels control app diagnostics', () => {
  for (const [level, expected] of [
    ['off', []],
    ['error', ['warn', 'error']],
    ['debug', ['info', 'warn', 'error']],
  ]) {
    const calls = [];
    const sink = Object.fromEntries(
      ['info', 'warn', 'error'].map((name) => [name, () => calls.push(name)]),
    );
    const logger = createLogger(level, sink);
    logger.info('debug information');
    logger.warn('warning');
    logger.error('error');
    assert.deepEqual(calls, expected);
  }
  assert.throws(() => createLogger('invalid'), /VITE_CONSOLE_LOG_LEVEL/);
});
