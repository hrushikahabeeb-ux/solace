import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipientsUnavailableError, WIRE_PREFIX, formatSessionRef, parseSessionRef, isWellFormedPublicKey } from '../src/index.js';
import { FakeServer, CONV, OTHER_CONV } from './helpers.js';

async function setup() {
  const server = new FakeServer();
  await server.addDevice('alice', 'alice-1');
  await server.addDevice('bob', 'bob-1');
  return { server, alice: server.engine('alice', 'alice-1'), bob: server.engine('bob', 'bob-1') };
}

test('round trip: recipient and sender can both read a message', async () => {
  const { alice, bob } = await setup();
  const sent = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'hello bob' });
  assert.ok(sent.ciphertext.startsWith(WIRE_PREFIX));
  assert.equal(sent.deviceCount, 2);

  const atBob = await bob.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext, senderUserId: 'alice' });
  assert.deepEqual(atBob.ok && atBob.plaintext, 'hello bob');

  // The property Olm could not provide: the sender can read its own message later.
  const atAlice = await alice.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext, senderUserId: 'alice' });
  assert.deepEqual(atAlice.ok && atAlice.plaintext, 'hello bob');
});

test('the same ciphertext decrypts any number of times, including concurrently', async () => {
  const { alice, bob } = await setup();
  const sent = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'idempotent' });
  const results = await Promise.all(
    Array.from({ length: 200 }, () => bob.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext })),
  );
  for (const r of results) assert.equal(r.ok && r.plaintext, 'idempotent');
  const again = await bob.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext });
  assert.equal(again.ok && again.plaintext, 'idempotent');
});

test('messages decrypt in any order, in parallel, and after a simulated reload', async () => {
  const { server, alice, bob } = await setup();
  const sent = await Promise.all(
    Array.from({ length: 60 }, (_, n) => alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: `msg ${n}` })),
  );
  const shuffled = sent.map((s, n) => ({ s, n })).sort(() => Math.random() - 0.5);

  const first = await Promise.all(shuffled.map(({ s }) => bob.decrypt({ conversationId: CONV, ciphertext: s.ciphertext })));
  first.forEach((r, i) => assert.equal(r.ok && r.plaintext, `msg ${shuffled[i].n}`));

  // "Reload": a brand-new engine built from the same stored identity, cold caches.
  const bobAfterReload = server.engine('bob', 'bob-1');
  const second = await Promise.all(shuffled.map(({ s }) => bobAfterReload.decrypt({ conversationId: CONV, ciphertext: s.ciphertext })));
  second.forEach((r, i) => assert.equal(r.ok && r.plaintext, `msg ${shuffled[i].n}`));
});

test('every device of a recipient can read the message', async () => {
  const { server, alice } = await setup();
  await server.addDevice('bob', 'bob-2');
  await server.addDevice('alice', 'alice-2');
  const bob1 = server.engine('bob', 'bob-1');
  const bob2 = server.engine('bob', 'bob-2');
  const alice2 = server.engine('alice', 'alice-2');

  const sent = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'multi-device' });
  assert.equal(sent.deviceCount, 4);
  for (const engine of [bob1, bob2, alice2, alice]) {
    const r = await engine.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext });
    assert.equal(r.ok && r.plaintext, 'multi-device');
  }
});

test('a device added later cannot read earlier messages but reads later ones', async () => {
  const { server, alice } = await setup();
  const before = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'before' });
  await server.addDevice('bob', 'bob-new');
  const bobNew = server.engine('bob', 'bob-new');

  const old = await bobNew.decrypt({ conversationId: CONV, ciphertext: before.ciphertext });
  assert.deepEqual(old, { ok: false, reason: 'not_for_this_device', retryable: false });

  const after = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'after' });
  const now = await bobNew.decrypt({ conversationId: CONV, ciphertext: after.ciphertext });
  assert.equal(now.ok && now.plaintext, 'after');
});

test('group: all current members read it, a removed member does not', async () => {
  const { server, alice } = await setup();
  await server.addDevice('carol', 'carol-1');
  await server.addDevice('dave', 'dave-1');
  const engines = { bob: server.engine('bob', 'bob-1'), carol: server.engine('carol', 'carol-1'), dave: server.engine('dave', 'dave-1') };

  const m1 = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob', 'carol', 'dave'], plaintext: 'everyone' });
  for (const e of Object.values(engines)) assert.equal((await e.decrypt({ conversationId: CONV, ciphertext: m1.ciphertext })) .ok, true);

  // Dave is removed: the very next message simply is not wrapped for him. No rotation step exists to forget.
  const m2 = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob', 'carol'], plaintext: 'without dave' });
  assert.equal((await engines.carol.decrypt({ conversationId: CONV, ciphertext: m2.ciphertext })).ok, true);
  const daveResult = await engines.dave.decrypt({ conversationId: CONV, ciphertext: m2.ciphertext });
  assert.deepEqual(daveResult, { ok: false, reason: 'not_for_this_device', retryable: false });
});

test('sender authentication: a member cannot forge a message from another member', async () => {
  const { server, alice, bob } = await setup();
  await server.addDevice('mallory', 'mallory-1');
  const mallory = server.engine('mallory', 'mallory-1');

  const forged = await mallory.encrypt({ conversationId: CONV, recipientUserIds: ['alice', 'bob'], plaintext: 'pay mallory' });
  // Mallory rewrites the sender field to claim the message came from Alice's device.
  const env = JSON.parse(forged.ciphertext.slice(WIRE_PREFIX.length));
  env.s = 'alice-1';
  const relabelled = WIRE_PREFIX + JSON.stringify(env);

  const r = await bob.decrypt({ conversationId: CONV, ciphertext: relabelled });
  assert.deepEqual(r, { ok: false, reason: 'authentication_failed', retryable: false });

  // Even an honest message is rejected if the server attributes it to the wrong user.
  const honest = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'hi' });
  const mismatch = await bob.decrypt({ conversationId: CONV, ciphertext: honest.ciphertext, senderUserId: 'mallory' });
  assert.deepEqual(mismatch, { ok: false, reason: 'sender_mismatch', retryable: false });
});

test('ciphertext is bound to its conversation', async () => {
  const { alice, bob } = await setup();
  const sent = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'secret' });
  const r = await bob.decrypt({ conversationId: OTHER_CONV, ciphertext: sent.ciphertext });
  assert.deepEqual(r, { ok: false, reason: 'authentication_failed', retryable: false });
});

test('tampering with the body or a wrap is detected', async () => {
  const { alice, bob } = await setup();
  const sent = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'integrity' });

  const flip = (b64: string) => {
    const bytes = Buffer.from(b64, 'base64');
    bytes[bytes.length - 1] ^= 0x01;
    return bytes.toString('base64');
  };
  const env = JSON.parse(sent.ciphertext.slice(WIRE_PREFIX.length));
  const bodyTampered = WIRE_PREFIX + JSON.stringify({ ...env, c: flip(env.c) });
  const wrapTampered = WIRE_PREFIX + JSON.stringify({ ...env, w: { ...env.w, 'bob-1': flip(env.w['bob-1']) } });

  for (const ciphertext of [bodyTampered, wrapTampered]) {
    const r = await bob.decrypt({ conversationId: CONV, ciphertext });
    assert.deepEqual(r, { ok: false, reason: 'authentication_failed', retryable: false });
  }
});

test('legacy Olm ciphertext and garbage are classified, not thrown', async () => {
  const { bob } = await setup();
  const legacy = await bob.decrypt({ conversationId: CONV, ciphertext: 'Awoge0wQ8JzXuP3qZ7Z0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0u' });
  assert.deepEqual(legacy, { ok: false, reason: 'legacy', retryable: false });
  for (const bad of ['', 'not base64 !!', WIRE_PREFIX + '{nope', WIRE_PREFIX + '{"v":3}']) {
    const r = await bob.decrypt({ conversationId: CONV, ciphertext: bad });
    assert.deepEqual(r, { ok: false, reason: 'malformed', retryable: false });
  }
});

test('directory outage: decrypt is retryable and recovers, encrypt fails loudly', async () => {
  const { server, alice, bob } = await setup();
  const sent = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'resilient' });

  server.down = true;
  const during = await bob.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext });
  assert.deepEqual(during, { ok: false, reason: 'directory_unavailable', retryable: true });
  await assert.rejects(() => alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'x' }), /directory/i);

  server.down = false;
  const after = await bob.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext });
  assert.equal(after.ok && after.plaintext, 'resilient');
});

test('recipients without a usable device: partial groups still send, lone DMs fail clearly', async () => {
  const server = new FakeServer();
  await server.addDevice('alice', 'alice-1');
  await server.addDevice('bob', 'bob-1');
  server.devices.push({ userId: 'oldtimer', deviceId: 'legacy-1', publicKey: 'Zm9v' }); // Olm-era key, not a P-256 point
  const alice = server.engine('alice', 'alice-1');
  const bob = server.engine('bob', 'bob-1');

  const partial = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob', 'oldtimer'], plaintext: 'group' });
  assert.deepEqual(partial.missingUserIds, ['oldtimer']);
  assert.equal((await bob.decrypt({ conversationId: CONV, ciphertext: partial.ciphertext })).ok, true);

  await assert.rejects(
    () => alice.encrypt({ conversationId: CONV, recipientUserIds: ['oldtimer'], plaintext: 'dm' }),
    (err: unknown) => err instanceof RecipientsUnavailableError && err.missingUserIds[0] === 'oldtimer',
  );
});

test('a brand-new device can always read what it just sent, even with a stale directory', async () => {
  const server = new FakeServer();
  await server.addDevice('alice', 'alice-1');
  await server.addDevice('bob', 'bob-1');
  const alice = server.engine('alice', 'alice-1');
  server.devices = server.devices.filter((d) => d.deviceId !== 'alice-1'); // directory has not caught up
  const sent = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'mine' });
  const r = await alice.decrypt({ conversationId: CONV, ciphertext: sent.ciphertext });
  assert.equal(r.ok && r.plaintext, 'mine');
});

test('encryption is randomised and handles unicode and large payloads', async () => {
  const { alice, bob } = await setup();
  const a = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'same' });
  const b = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: 'same' });
  assert.notEqual(a.ciphertext, b.ciphertext);

  const text = 'héllo 世界 🔐 '.repeat(50_000); // about 1 MB of UTF-8
  const big = await alice.encrypt({ conversationId: CONV, recipientUserIds: ['bob'], plaintext: text });
  const r = await bob.decrypt({ conversationId: CONV, ciphertext: big.ciphertext });
  assert.equal(r.ok && r.plaintext, text);
});

test('session refs round trip and public key validation', async () => {
  assert.deepEqual(parseSessionRef(formatSessionRef(CONV, 'dev-1')), { conversationId: CONV, senderDeviceId: 'dev-1' });
  assert.equal(parseSessionRef('group:x:y'), null);
  const server = new FakeServer();
  const id = await server.addDevice('u', 'd');
  assert.equal(isWellFormedPublicKey(id.publicKey), true);
  assert.equal(isWellFormedPublicKey('AAAA'), false);
  assert.equal(isWellFormedPublicKey(id.publicKey.replace(/^./, 'C')), false);
});
