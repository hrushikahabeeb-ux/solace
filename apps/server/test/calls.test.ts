import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { createCallService, createMongoCallStore, type CallService, type CallStore } from '../src/realtime/calls.js';
import { buildIceServers } from '../src/routes/calls.js';
import { Collections } from '../src/lib/collections.js';
import { startTestMongo, type TestMongo } from './mongoHarness.js';

/**
 * These run against a REAL MongoDB replica set (see mongoHarness.ts) because the
 * atomicity guarantees live in MongoDB transactions and atomic single-document updates,
 * and a fake would only test itself. Only the Prisma-backed lookups are faked.
 */

const ALICE = randomUUID();
const BOB = randomUUID();
const CAROL = randomUUID();
const DM = randomUUID(); // alice <-> bob
const GROUP = randomUUID();
const OUTSIDER_DM = randomUUID(); // bob <-> carol (alice is not a member)

const users: Record<string, { id: string; username: string; displayName: string }> = {
  [ALICE]: { id: ALICE, username: 'alice', displayName: 'Alice' },
  [BOB]: { id: BOB, username: 'bob', displayName: 'Bob' },
  [CAROL]: { id: CAROL, username: 'carol', displayName: 'Carol' },
};

const conversations: Record<string, { type: string; memberIds: string[] }> = {
  [DM]: { type: 'DIRECT', memberIds: [ALICE, BOB] },
  [GROUP]: { type: 'GROUP', memberIds: [ALICE, BOB, CAROL] },
  [OUTSIDER_DM]: { type: 'DIRECT', memberIds: [BOB, CAROL] },
};

let mongo: TestMongo;
let db: Db;
let store: CallStore;
let service: CallService;
let blocked: Set<string>;
let events: { userId: string; payload: Record<string, unknown> }[];

function eventsFor(userId: string, type?: string) {
  return events.filter((e) => e.userId === userId && (type === undefined || e.payload.type === type)).map((e) => e.payload);
}

function build(ringTimeoutMs?: number): CallService {
  return createCallService({
    store,
    publish: async (userId, payload) => {
      events.push({ userId, payload: payload as Record<string, unknown> });
    },
    getConversation: async (id) => conversations[id] ?? null,
    isBlocked: async (a, b) => blocked.has([a, b].sort().join('|')),
    getUser: async (id) => users[id] ?? null,
    ringTimeoutMs,
  });
}

const sessions = () => db.collection<{ _id: string; record: Record<string, unknown>; expiresAt: Date }>(Collections.callSessions);
const locks = () => db.collection<{ _id: string; callId: string; expiresAt: Date }>(Collections.callLocks);
const secondsLeft = (expiresAt: Date | undefined) => ((expiresAt?.getTime() ?? 0) - Date.now()) / 1000;

before(async () => {
  mongo = await startTestMongo();
  db = mongo.client.db(mongo.dbName);
  store = createMongoCallStore(async () => mongo.client, mongo.dbName);
});

after(async () => {
  service?.dispose();
  await mongo?.stop();
});

beforeEach(async () => {
  service?.dispose();
  await Promise.all([
    sessions().deleteMany({}),
    locks().deleteMany({}),
    db.collection(Collections.callRateLimits).deleteMany({}),
  ]);
  events = [];
  blocked = new Set();
  service = build();
});

const invite = (userId: string, callId: string, conversationId = DM, clientId = 'client-a') =>
  service.handleFrame(userId, { type: 'call.invite', callId, conversationId, media: 'audio', clientId });

test('invite rings the callee with the caller identity and confirms ringing to the caller', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);

  const incoming = eventsFor(BOB, 'call.incoming');
  assert.equal(incoming.length, 1);
  assert.deepEqual(incoming[0], {
    type: 'call.incoming',
    callId,
    conversationId: DM,
    media: 'audio',
    from: { id: ALICE, username: 'alice', displayName: 'Alice' },
    callerClient: 'client-a',
  });
  assert.equal(eventsFor(ALICE, 'call.ringing').length, 1);
});

test('invite is refused for groups, non-members and malformed frames', async () => {
  await invite(ALICE, randomUUID(), GROUP);
  await invite(ALICE, randomUUID(), OUTSIDER_DM);
  await service.handleFrame(ALICE, { type: 'call.invite', callId: 'not-a-uuid', conversationId: DM, media: 'audio', clientId: 'x' });
  await service.handleFrame(ALICE, { type: 'call.invite', callId: randomUUID(), conversationId: DM, media: 'screen', clientId: 'x' });

  assert.equal(eventsFor(ALICE, 'call.rejected').length, 2);
  assert.ok(eventsFor(ALICE, 'call.rejected').every((e) => e.reason === 'not_allowed'));
  assert.equal(eventsFor(BOB, 'call.incoming').length, 0);
  assert.equal(eventsFor(CAROL, 'call.incoming').length, 0);
});

test('a block is reported as generic "unavailable" and never rings the callee', async () => {
  blocked.add([ALICE, BOB].sort().join('|'));
  await invite(ALICE, randomUUID());
  assert.equal(eventsFor(ALICE, 'call.rejected')[0].reason, 'unavailable');
  assert.equal(eventsFor(BOB).length, 0);
});

test('busy detection works in both directions', async () => {
  await invite(ALICE, randomUUID());
  events = [];

  // Carol calls Bob while Bob is being rung: Bob is busy.
  await service.handleFrame(CAROL, {
    type: 'call.invite',
    callId: randomUUID(),
    conversationId: OUTSIDER_DM,
    media: 'audio',
    clientId: 'client-c',
  });
  assert.equal(eventsFor(CAROL, 'call.rejected')[0].reason, 'busy');
  assert.equal(eventsFor(BOB, 'call.incoming').length, 0);

  // Alice tries to start another call while she already has one going: self_busy.
  await service.handleFrame(ALICE, {
    type: 'call.invite',
    callId: randomUUID(),
    conversationId: DM,
    media: 'video',
    clientId: 'client-a2',
  });
  assert.equal(eventsFor(ALICE, 'call.rejected')[0].reason, 'self_busy');
});

test('a failed invite does not leave either user locked', async () => {
  const first = randomUUID();
  await invite(ALICE, first);
  await service.handleFrame(BOB, { type: 'call.decline', callId: first });
  events = [];

  await invite(ALICE, randomUUID());
  assert.equal(eventsFor(ALICE, 'call.rejected').length, 0);
  assert.equal(eventsFor(BOB, 'call.incoming').length, 1);
});

test('exactly one accept wins when two devices answer at once', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  events = [];

  await Promise.all([
    service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-laptop' }),
    service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-phone' }),
  ]);

  const toBob = eventsFor(BOB, 'call.accepted');
  const toAlice = eventsFor(ALICE, 'call.accepted');
  assert.equal(toBob.length, 1, 'winner is announced exactly once');
  assert.equal(toAlice.length, 1);
  assert.equal(toBob[0].by, toAlice[0].by, 'both parties agree on who won');
});

test('only the callee can accept, and only while ringing', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  events = [];

  await service.handleFrame(ALICE, { type: 'call.accept', callId, clientId: 'client-a' }); // caller
  await service.handleFrame(CAROL, { type: 'call.accept', callId, clientId: 'client-c' }); // stranger
  assert.equal(eventsFor(ALICE, 'call.accepted').length, 0);
  assert.equal(eventsFor(BOB, 'call.accepted').length, 0);

  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-1' });
  assert.equal(eventsFor(ALICE, 'call.accepted').length, 1);

  // A second accept after the call is already active changes nothing.
  events = [];
  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-2' });
  assert.equal(events.length, 0);
});

test('accepting a call that no longer exists tells the user it was missed', async () => {
  await service.handleFrame(BOB, { type: 'call.accept', callId: randomUUID(), clientId: 'bob-1' });
  assert.equal(eventsFor(BOB, 'call.ended')[0].reason, 'missed');
});

test('decline ends the call for both and only the callee may decline', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  events = [];

  await service.handleFrame(ALICE, { type: 'call.decline', callId }); // caller cannot "decline"
  assert.equal(events.length, 0);

  await service.handleFrame(BOB, { type: 'call.decline', callId });
  assert.equal(eventsFor(ALICE, 'call.ended')[0].reason, 'declined');
  assert.equal(eventsFor(BOB, 'call.ended')[0].reason, 'declined');
});

test('end reports cancelled while ringing and hangup once active; double end is a no-op', async () => {
  const ringing = randomUUID();
  await invite(ALICE, ringing);
  events = [];
  await service.handleFrame(ALICE, { type: 'call.end', callId: ringing });
  await service.handleFrame(ALICE, { type: 'call.end', callId: ringing });
  assert.equal(eventsFor(BOB, 'call.ended').length, 1, 'end is announced once');
  assert.equal(eventsFor(BOB, 'call.ended')[0].reason, 'cancelled');

  const active = randomUUID();
  await invite(ALICE, active);
  await service.handleFrame(BOB, { type: 'call.accept', callId: active, clientId: 'bob-1' });
  events = [];
  await service.handleFrame(BOB, { type: 'call.end', callId: active });
  assert.equal(eventsFor(ALICE, 'call.ended')[0].reason, 'hangup');
  assert.equal(eventsFor(ALICE, 'call.ended')[0].by, BOB);
});

test('a stranger cannot end or interfere with someone else\'s call', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-1' });
  events = [];
  await service.handleFrame(CAROL, { type: 'call.end', callId });
  await service.handleFrame(CAROL, { type: 'call.signal', callId, payload: 'x' });
  assert.equal(events.length, 0);
});

test('signals relay only to the other participant and only once the call is active', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  events = [];

  await service.handleFrame(ALICE, { type: 'call.signal', callId, payload: 'too-early' });
  assert.equal(events.length, 0, 'no signaling while still ringing');

  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-1' });
  events = [];

  await service.handleFrame(ALICE, { type: 'call.signal', callId, payload: 'ciphertext-1' });
  await service.handleFrame(BOB, { type: 'call.signal', callId, payload: 'ciphertext-2' });

  assert.deepEqual(eventsFor(BOB, 'call.signal'), [{ type: 'call.signal', callId, from: ALICE, payload: 'ciphertext-1' }]);
  assert.deepEqual(eventsFor(ALICE, 'call.signal'), [{ type: 'call.signal', callId, from: BOB, payload: 'ciphertext-2' }]);
  assert.equal(eventsFor(CAROL).length, 0);
});

test('oversized signal payloads are dropped', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-1' });
  events = [];
  await service.handleFrame(ALICE, { type: 'call.signal', callId, payload: 'x'.repeat(64 * 1024 + 1) });
  assert.equal(events.length, 0);
});

test('an unanswered call is reported missed to both sides and frees both users', async () => {
  service.dispose();
  service = build(60);
  const callId = randomUUID();
  await invite(ALICE, callId);
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(eventsFor(ALICE, 'call.ended')[0].reason, 'missed');
  assert.equal(eventsFor(BOB, 'call.ended')[0].reason, 'missed');

  events = [];
  await invite(ALICE, randomUUID());
  assert.equal(eventsFor(BOB, 'call.incoming').length, 1, 'callee is free again after a missed call');
});

test('an answered call is not reported missed when the ring timer fires', async () => {
  service.dispose();
  service = build(80);
  const callId = randomUUID();
  await invite(ALICE, callId);
  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-1' });
  events = [];
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(eventsFor(ALICE, 'call.ended').length, 0);
});

test('ending an old call cannot release the lock a newer call now holds', async () => {
  // The lock-ownership guard in `end` exists for TTL skew: the old call's record is still
  // around, but its user locks expired and a newer call has since taken them. Build
  // exactly that state.
  const oldCall = randomUUID();
  await invite(ALICE, oldCall);
  const oldRecord = (await sessions().findOne({ _id: oldCall }))!.record as unknown as Parameters<CallStore['end']>[0];

  await locks().deleteMany({ _id: { $in: [ALICE, BOB] } }); // locks expire before the record

  const newCall = randomUUID();
  await invite(ALICE, newCall);
  assert.equal((await locks().findOne({ _id: ALICE }))?.callId, newCall);

  assert.ok(await store.end(oldRecord), 'old record is still deletable');

  assert.equal((await locks().findOne({ _id: ALICE }))?.callId, newCall, "alice's lock still belongs to the newer call");
  assert.equal((await locks().findOne({ _id: BOB }))?.callId, newCall, "bob's lock still belongs to the newer call");
  assert.ok(await sessions().findOne({ _id: newCall }), 'the newer call itself is untouched');
});

test('keepalive extends an active call; an unknown call is reported ended to the sender', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-1' });

  await sessions().updateOne({ _id: callId }, { $set: { expiresAt: new Date(Date.now() + 5_000) } });
  await service.handleFrame(ALICE, { type: 'call.keepalive', callId });
  assert.ok(secondsLeft((await sessions().findOne({ _id: callId }))?.expiresAt) > 60, 'ttl was refreshed');
  assert.ok(secondsLeft((await locks().findOne({ _id: ALICE }))?.expiresAt) > 60);
  assert.ok(secondsLeft((await locks().findOne({ _id: BOB }))?.expiresAt) > 60);

  events = [];
  await service.handleFrame(ALICE, { type: 'call.keepalive', callId: randomUUID() });
  assert.equal(eventsFor(ALICE, 'call.ended').length, 1);
});

test('an expired call is treated as gone even before MongoDB garbage-collects it', async () => {
  const callId = randomUUID();
  await invite(ALICE, callId);
  const past = new Date(Date.now() - 1_000);
  await sessions().updateOne({ _id: callId }, { $set: { expiresAt: past } });
  await locks().updateMany({ _id: { $in: [ALICE, BOB] } }, { $set: { expiresAt: past } });
  events = [];

  await service.handleFrame(BOB, { type: 'call.accept', callId, clientId: 'bob-1' });
  assert.equal(eventsFor(BOB, 'call.ended')[0].reason, 'missed', 'accepting an expired call reports it missed');

  events = [];
  await invite(ALICE, randomUUID());
  assert.equal(eventsFor(BOB, 'call.incoming').length, 1, 'expired locks do not keep users busy');
});

test('simultaneous invites between the same two users ring exactly once', async () => {
  const fromAlice = randomUUID();
  const fromBob = randomUUID();
  await Promise.all([invite(ALICE, fromAlice), invite(BOB, fromBob, DM, 'client-b')]);

  const rang = eventsFor(ALICE, 'call.incoming').length + eventsFor(BOB, 'call.incoming').length;
  const rejected = eventsFor(ALICE, 'call.rejected').length + eventsFor(BOB, 'call.rejected').length;
  assert.equal(rang, 1, 'one call wins');
  assert.equal(rejected, 1, 'the other is rejected as busy');
});

test('invites are rate limited per user', async () => {
  for (let i = 0; i < 6; i++) {
    const callId = randomUUID();
    await invite(ALICE, callId);
    await service.handleFrame(ALICE, { type: 'call.end', callId });
  }
  events = [];
  await invite(ALICE, randomUUID());
  assert.equal(eventsFor(ALICE, 'call.rejected')[0].reason, 'rate_limited');
  assert.equal(eventsFor(BOB, 'call.incoming').length, 0);
});

// ---- ICE server configuration ---------------------------------------------------------

test('ICE config: dev default is STUN only', () => {
  const result = buildIceServers(ALICE, {});
  assert.equal(result.relayAvailable, false);
  assert.equal(result.iceServers.length, 1);
  assert.deepEqual(result.iceServers[0].urls, ['stun:stun.l.google.com:19302']);
  assert.equal(result.iceServers[0].credential, undefined);
});

test('ICE config: TURN gets ephemeral HMAC credentials and no public STUN fallback', async () => {
  const { createHmac } = await import('node:crypto');
  const now = 1_800_000_000_000;
  const result = buildIceServers(
    ALICE,
    { TURN_URLS: 'turn:t.example.com:3478?transport=udp, turn:t.example.com:3478?transport=tcp', TURN_SECRET: 's3cret' },
    now,
  );
  assert.equal(result.relayAvailable, true);
  assert.equal(result.iceServers.length, 1, 'own TURN only: no third-party STUN is leaked to');
  const turn = result.iceServers[0];
  assert.deepEqual(turn.urls, ['turn:t.example.com:3478?transport=udp', 'turn:t.example.com:3478?transport=tcp']);
  assert.equal(turn.username, `${Math.floor(now / 1000) + result.ttlSeconds}:${ALICE}`);
  assert.equal(turn.credential, createHmac('sha1', 's3cret').update(turn.username!).digest('base64'));
});

test('ICE config: TURN_URLS without a secret is ignored rather than sent without auth', () => {
  const result = buildIceServers(ALICE, { TURN_URLS: 'turn:t.example.com:3478' });
  assert.equal(result.relayAvailable, false);
  assert.ok(result.iceServers.every((s) => s.credential === undefined));
});
