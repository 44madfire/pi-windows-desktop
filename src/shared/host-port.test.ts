import assert from 'node:assert/strict';
import test from 'node:test';
import { isHostPort } from './host-port.ts';

test('host port validation accepts only transferable port-like objects', () => {
  const port = {
    postMessage: () => undefined,
    start: () => undefined,
    close: () => undefined,
  };

  assert.equal(isHostPort(port), true);
  assert.equal(isHostPort({ postMessage: () => undefined, start: () => undefined }), false);
  assert.equal(isHostPort(null), false);
  assert.equal(isHostPort('port'), false);
});
