import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let createMediaToken: typeof import('../src/lib/mediaStore.js').createMediaToken;
let verifyMediaToken: typeof import('../src/lib/mediaStore.js').verifyMediaToken;

before(async () => {
  // lib/mongo.ts validates configuration at import time; no connection is opened here.
  process.env.MONGODB_URL ??= 'mongodb://127.0.0.1:1/solace_test';
  process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-media-url-signing';
  ({ createMediaToken, verifyMediaToken } = await import('../src/lib/mediaStore.js'));
});

const future = () => Math.floor(Date.now() / 1000) + 60;

test('a signed upload URL token round-trips its claims', () => {
  const token = createMediaToken({ k: 'uploads/u/1', a: 'put', s: 1234, e: future() });
  const claims = verifyMediaToken(token, 'put');
  assert.equal(claims?.k, 'uploads/u/1');
  assert.equal(claims?.s, 1234);
});

test('a token is only valid for the operation it was issued for', () => {
  const token = createMediaToken({ k: 'uploads/u/1', a: 'get', e: future() });
  assert.ok(verifyMediaToken(token, 'get'));
  assert.equal(verifyMediaToken(token, 'put'), null);
});

test('expired tokens are rejected', () => {
  const token = createMediaToken({ k: 'uploads/u/1', a: 'get', e: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(verifyMediaToken(token, 'get'), null);
});

test('tampering with the claims or signature invalidates the token', () => {
  const token = createMediaToken({ k: 'uploads/u/1', a: 'put', s: 10, e: future() });
  const [claims, signature] = token.split('.');
  const forgedClaims = Buffer.from(JSON.stringify({ k: 'uploads/u/1', a: 'put', s: 999999, e: future() })).toString('base64url');
  assert.equal(verifyMediaToken(`${forgedClaims}.${signature}`, 'put'), null);
  assert.equal(verifyMediaToken(`${claims}.${signature.slice(0, -2)}AA`, 'put'), null);
  assert.equal(verifyMediaToken('garbage', 'put'), null);
  assert.equal(verifyMediaToken(undefined, 'put'), null);
});

test('upload tokens must carry a positive byte length', () => {
  const token = createMediaToken({ k: 'uploads/u/1', a: 'put', e: future() });
  assert.equal(verifyMediaToken(token, 'put'), null);
});
