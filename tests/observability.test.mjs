import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { observeHttpRequest, safeIdentifier } from '../server/observability.js';

test('request logging tolerates a socket detached before the response finishes', () => {
  const request = {
    headers: {},
    method: 'GET',
    url: '/api/live',
    socket: { remoteAddress: '127.0.0.1' }
  };
  const response = new EventEmitter();
  response.statusCode = 200;
  response.setHeader = () => {};

  const originalLog = console.log;
  let loggedEvent;
  console.log = (value) => {
    loggedEvent = JSON.parse(value);
  };

  try {
    observeHttpRequest(request, response);
    request.socket = null;
    assert.doesNotThrow(() => response.emit('finish'));
  } finally {
    console.log = originalLog;
  }

  assert.equal(loggedEvent.path, '/api/live');
  assert.equal(loggedEvent.status, 200);
  assert.equal(loggedEvent.client, safeIdentifier('unknown'));
});
