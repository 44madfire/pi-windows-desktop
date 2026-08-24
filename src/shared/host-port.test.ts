import assert from 'node:assert/strict';
import test from 'node:test';
import { isHostPort, safeHostPortTargetOrigin } from './host-port.ts';

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

test('host port transfer origin is confined and never a wildcard', () => {
  // Dev-server renderer: the port reaches only its exact http(s) origin.
  assert.equal(safeHostPortTargetOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(safeHostPortTargetOrigin('https://pi.local'), 'https://pi.local');
  // Packaged renderer: Chromium serializes the file origin as "file://".
  assert.equal(safeHostPortTargetOrigin('file://'), 'file://');
  // Opaque/absent origins (the literal "null", empty) must not become '*':
  // the port falls back to the packaged file origin instead.
  assert.equal(safeHostPortTargetOrigin('null'), 'file://');
  assert.equal(safeHostPortTargetOrigin(''), 'file://');
});
