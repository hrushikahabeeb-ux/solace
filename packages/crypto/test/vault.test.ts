import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeviceIdentity, saveIdentity, loadIdentity, setCurrentDeviceId, getCurrentDeviceId } from '../src/index.js';

test('identity survives a save/load round trip and stays non-extractable and usable', async () => {
  const identity = await generateDeviceIdentity();
  assert.equal(identity.privateKey.extractable, false);
  await saveIdentity('dev-1', identity);

  const loaded = await loadIdentity('dev-1');
  assert.ok(loaded);
  assert.equal(loaded.publicKey, identity.publicKey);
  assert.equal(loaded.privateKey.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey('pkcs8', loaded.privateKey));

  // The reloaded key must still be able to do ECDH with a peer.
  const peer = await generateDeviceIdentity();
  const peerPub = await crypto.subtle.importKey('raw', Buffer.from(peer.publicKey, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, loaded.privateKey, 256);
  assert.equal(bits.byteLength, 32);
});

test('unknown devices load as null and the username pointer round trips', async () => {
  assert.equal(await loadIdentity('missing'), null);
  assert.equal(await getCurrentDeviceId('alice'), null);
  await setCurrentDeviceId('alice', 'dev-9');
  assert.equal(await getCurrentDeviceId('alice'), 'dev-9');
});
