import { z } from 'zod';
import type { Collection, MongoClient } from 'mongodb';
import { Collections } from '../lib/collections.js';

/**
 * One-to-one call signaling.
 *
 * What this module is, and is not:
 *  - It tracks call *lifecycle* (ringing, active, ended) so that ringing, busy detection,
 *    timeouts and "answered on another device" work. That is routing metadata of the same
 *    kind the server already sees for messages: who called whom, and when.
 *  - It relays opaque `call.signal` payloads between the two participants. Those payloads
 *    are end-to-end encrypted by the clients (SDP offers/answers, ICE candidates, mute
 *    state), so the server cannot read them, cannot see IP addresses inside them, and cannot
 *    substitute the DTLS fingerprint they carry. See ARCHITECTURE.md section 3.6.
 *  - The audio/video itself never touches the server. It flows peer to peer (or through a
 *    TURN relay, which only ever forwards DTLS-SRTP ciphertext).
 *
 * The service is written against `CallStore` and injected dependencies rather than against
 * MongoDB/Prisma directly, so the state machine can be tested with fakes for the lookups.
 */

export type CallMedia = 'audio' | 'video';

export interface CallRecord {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  media: CallMedia;
  state: 'ringing' | 'active';
  callerClient: string;
  calleeClient: string | null;
  createdAt: number;
}

export type CallEndReason = 'hangup' | 'declined' | 'cancelled' | 'missed';

export type CallRejectReason = 'busy' | 'self_busy' | 'unavailable' | 'not_allowed' | 'rate_limited';

// ---------------------------------------------------------------------------------------
// Wire protocol (client -> server)
// ---------------------------------------------------------------------------------------

/** Upper bound for one encrypted signaling payload. A full SDP with all ICE candidates and
 *  one wrap per recipient device is well below this. */
export const MAX_SIGNAL_BYTES = 64 * 1024;

const uuid = z.string().uuid();
const clientId = z.string().min(1).max(64);

export const callFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call.invite'),
    callId: uuid,
    conversationId: uuid,
    media: z.enum(['audio', 'video']),
    clientId,
  }),
  z.object({ type: z.literal('call.accept'), callId: uuid, clientId }),
  z.object({ type: z.literal('call.decline'), callId: uuid }),
  z.object({ type: z.literal('call.end'), callId: uuid }),
  z.object({ type: z.literal('call.keepalive'), callId: uuid }),
  z.object({ type: z.literal('call.signal'), callId: uuid, payload: z.string().min(1).max(MAX_SIGNAL_BYTES) }),
]);

export type CallFrame = z.infer<typeof callFrameSchema>;

// ---------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------

/** How long a call rings before it is reported as missed. */
export const RING_TIMEOUT_MS = 45_000;
/** Backstop TTL for a ringing call's records, in case the timer's process dies. */
const RINGING_TTL_SECONDS = 75;
/** Active calls must be kept alive by clients; if both sides vanish (crash, network loss)
 *  the busy lock frees itself after this long instead of stranding both users. */
export const ACTIVE_TTL_SECONDS = 120;
const INVITES_PER_MINUTE = 6;
const SIGNALS_PER_MINUTE = 900;

// ---------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------

export interface CallStore {
  /** Atomically creates a ringing call and takes the busy lock for both users. */
  create(call: CallRecord, ttlSeconds: number): Promise<'ok' | 'caller_busy' | 'callee_busy'>;
  get(callId: string): Promise<CallRecord | null>;
  /** Atomically moves ringing -> active for the given callee. Returns null if the call is
   *  gone, is not ringing, or belongs to somebody else: exactly one accept can win. */
  accept(callId: string, calleeId: string, calleeClient: string, ttlSeconds: number): Promise<CallRecord | null>;
  /** Atomically deletes the call and releases both locks. Returns null if it was already
   *  gone: exactly one `end` can win, so end notifications are never duplicated. */
  end(call: CallRecord): Promise<CallRecord | null>;
  touch(call: CallRecord, ttlSeconds: number): Promise<void>;
  /** Fixed-window counter. Returns false once `limit` is exceeded within the window. */
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

interface CallSessionDoc {
  _id: string; // callId
  record: CallRecord;
  expiresAt: Date;
}

interface CallLockDoc {
  _id: string; // userId
  callId: string;
  expiresAt: Date;
}

interface RateLimitDoc {
  _id: string;
  count: number;
  windowEnd: Date;
}

const DUPLICATE_KEY = 11000;
const MAX_DUPLICATE_KEY_RETRIES = 3;

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY;
}

function expiryFromNow(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}

/**
 * MongoDB-backed call store.
 *
 * Expiry: every document carries an `expiresAt`, and every read filters on it, so a
 * record is gone the instant it expires, exactly like a Redis key TTL. The TTL indexes
 * created in lib/mongo.ts only garbage-collect expired documents afterwards.
 *
 * Atomicity: `create` must take both users' busy locks all-or-nothing, so it runs in a
 * multi-document transaction (the replica set Prisma already requires makes this
 * available). Concurrent creates touching the same lock conflict inside MongoDB and one
 * is retried against the committed state, which serializes them the way the previous
 * Lua script did. `accept` and `end` hinge on a single-document atomic operation
 * (findOneAndUpdate / findOneAndDelete), so exactly one caller can win each of them.
 *
 * @param getClient resolves a connected MongoClient (lazily, so importing this module
 *                  never opens a connection).
 * @param dbName    database to use; defaults to the one named in the connection string.
 */
export function createMongoCallStore(getClient: () => Promise<MongoClient>, dbName?: string): CallStore {
  async function collections(): Promise<{
    client: MongoClient;
    sessions: Collection<CallSessionDoc>;
    locks: Collection<CallLockDoc>;
    limits: Collection<RateLimitDoc>;
  }> {
    const client = await getClient();
    const db = client.db(dbName);
    return {
      client,
      sessions: db.collection<CallSessionDoc>(Collections.callSessions),
      locks: db.collection<CallLockDoc>(Collections.callLocks),
      limits: db.collection<RateLimitDoc>(Collections.callRateLimits),
    };
  }

  async function createOnce(call: CallRecord, ttlSeconds: number): Promise<'ok' | 'caller_busy' | 'callee_busy'> {
    const { client, sessions, locks } = await collections();
    const session = client.startSession();
    try {
      let outcome: 'ok' | 'caller_busy' | 'callee_busy' = 'ok';
      await session.withTransaction(
        async () => {
          // Reset on every attempt: withTransaction re-runs this callback after a
          // transient conflict, and the second run must decide from scratch.
          outcome = 'ok';
          const now = new Date();
          const held = await locks
            .find({ _id: { $in: [call.callerId, call.calleeId] }, expiresAt: { $gt: now } }, { session })
            .toArray();
          const busy = new Set(held.map((lock) => lock._id));
          if (busy.has(call.callerId)) {
            outcome = 'caller_busy';
            return;
          }
          if (busy.has(call.calleeId)) {
            outcome = 'callee_busy';
            return;
          }
          const expiresAt = expiryFromNow(ttlSeconds);
          await locks.updateOne(
            { _id: call.callerId },
            { $set: { callId: call.id, expiresAt } },
            { upsert: true, session },
          );
          await locks.updateOne(
            { _id: call.calleeId },
            { $set: { callId: call.id, expiresAt } },
            { upsert: true, session },
          );
          await sessions.replaceOne({ _id: call.id }, { record: call, expiresAt }, { upsert: true, session });
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      return outcome;
    } finally {
      await session.endSession();
    }
  }

  return {
    async create(call, ttlSeconds) {
      // Two transactions inserting the same brand-new lock document can surface as a
      // duplicate-key error rather than a transient conflict. Retrying re-reads the
      // committed state, where the winner's lock now makes this caller "busy".
      for (let attempt = 1; ; attempt++) {
        try {
          return await createOnce(call, ttlSeconds);
        } catch (err) {
          if (!isDuplicateKeyError(err) || attempt >= MAX_DUPLICATE_KEY_RETRIES) throw err;
        }
      }
    },

    async get(callId) {
      const { sessions } = await collections();
      const doc = await sessions.findOne({ _id: callId, expiresAt: { $gt: new Date() } });
      return doc?.record ?? null;
    },

    async accept(callId, calleeId, calleeClient, ttlSeconds) {
      const { sessions, locks } = await collections();
      const now = new Date();
      const expiresAt = expiryFromNow(ttlSeconds);
      const updated = await sessions.findOneAndUpdate(
        { _id: callId, expiresAt: { $gt: now }, 'record.state': 'ringing', 'record.calleeId': calleeId },
        { $set: { 'record.state': 'active', 'record.calleeClient': calleeClient, expiresAt } },
        { returnDocument: 'after' },
      );
      if (!updated) return null;
      await locks.updateMany(
        { _id: { $in: [updated.record.callerId, updated.record.calleeId] }, expiresAt: { $gt: now } },
        { $set: { expiresAt } },
      );
      return updated.record;
    },

    async end(call) {
      const { sessions, locks } = await collections();
      const deleted = await sessions.findOneAndDelete({ _id: call.id, expiresAt: { $gt: new Date() } });
      if (!deleted) return null;
      // Deleting a lock only when it still points at THIS call prevents a late `end`
      // from releasing the lock of a newer call the same user has since started.
      await locks.deleteMany({ _id: { $in: [call.callerId, call.calleeId] }, callId: call.id });
      return deleted.record;
    },

    async touch(call, ttlSeconds) {
      const { sessions, locks } = await collections();
      const now = new Date();
      const expiresAt = expiryFromNow(ttlSeconds);
      await Promise.all([
        sessions.updateOne({ _id: call.id, expiresAt: { $gt: now } }, { $set: { expiresAt } }),
        locks.updateMany(
          { _id: { $in: [call.callerId, call.calleeId] }, expiresAt: { $gt: now } },
          { $set: { expiresAt } },
        ),
      ]);
    },

    async hit(key, limit, windowSeconds) {
      const { limits } = await collections();
      for (let attempt = 1; ; attempt++) {
        const now = new Date();
        const freshWindowEnd = new Date(now.getTime() + windowSeconds * 1000);
        const windowOpen = { $gt: ['$windowEnd', now] };
        try {
          // A single atomic pipeline update: increment inside a live window, or start a
          // new window at 1. Equivalent to Redis INCR + EXPIRE-on-first-hit.
          const doc = await limits.findOneAndUpdate(
            { _id: key },
            [
              {
                $set: {
                  count: { $cond: [windowOpen, { $add: ['$count', 1] }, 1] },
                  windowEnd: { $cond: [windowOpen, '$windowEnd', freshWindowEnd] },
                },
              },
            ],
            { upsert: true, returnDocument: 'after' },
          );
          return (doc?.count ?? 1) <= limit;
        } catch (err) {
          if (!isDuplicateKeyError(err) || attempt >= MAX_DUPLICATE_KEY_RETRIES) throw err;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------

export interface CallDeps {
  store: CallStore;
  /** Delivers an event to every connection the user has open, on any server instance. */
  publish(userId: string, payload: unknown): Promise<void>;
  getConversation(conversationId: string): Promise<{ type: string; memberIds: string[] } | null>;
  isBlocked(userIdA: string, userIdB: string): Promise<boolean>;
  getUser(userId: string): Promise<{ id: string; username: string; displayName: string } | null>;
  ringTimeoutMs?: number;
}

export interface CallService {
  handleFrame(userId: string, rawFrame: unknown): Promise<void>;
  /** Clears pending ring timers (used on shutdown and in tests). */
  dispose(): void;
}

export function createCallService(deps: CallDeps): CallService {
  const { store, publish } = deps;
  const ringTimeoutMs = deps.ringTimeoutMs ?? RING_TIMEOUT_MS;
  const ringTimers = new Map<string, NodeJS.Timeout>();

  function clearRingTimer(callId: string) {
    const timer = ringTimers.get(callId);
    if (timer) clearTimeout(timer);
    ringTimers.delete(callId);
  }

  function otherParty(call: CallRecord, userId: string): string {
    return userId === call.callerId ? call.calleeId : call.callerId;
  }

  function isParticipant(call: CallRecord, userId: string): boolean {
    return userId === call.callerId || userId === call.calleeId;
  }

  async function notifyEnded(call: CallRecord, reason: CallEndReason, by: string | null) {
    const payload = { type: 'call.ended', callId: call.id, reason, by };
    await Promise.all([publish(call.callerId, payload), publish(call.calleeId, payload)]);
  }

  async function reject(userId: string, callId: string, reason: CallRejectReason) {
    await publish(userId, { type: 'call.rejected', callId, reason });
  }

  function scheduleRingTimeout(callId: string) {
    const timer = setTimeout(() => {
      ringTimers.delete(callId);
      void (async () => {
        const call = await store.get(callId);
        if (!call || call.state !== 'ringing') return;
        const ended = await store.end(call);
        if (ended) await notifyEnded(ended, 'missed', null);
      })().catch(() => undefined);
    }, ringTimeoutMs);
    timer.unref();
    ringTimers.set(callId, timer);
  }

  async function onInvite(userId: string, frame: Extract<CallFrame, { type: 'call.invite' }>) {
    if (!(await store.hit(`invite:${userId}`, INVITES_PER_MINUTE, 60))) {
      return reject(userId, frame.callId, 'rate_limited');
    }

    const conversation = await deps.getConversation(frame.conversationId);
    if (
      !conversation ||
      conversation.type !== 'DIRECT' ||
      conversation.memberIds.length !== 2 ||
      !conversation.memberIds.includes(userId)
    ) {
      return reject(userId, frame.callId, 'not_allowed');
    }
    const calleeId = conversation.memberIds.find((id) => id !== userId);
    if (!calleeId) return reject(userId, frame.callId, 'not_allowed');

    // Deliberately indistinguishable from any other "cannot reach them" outcome, so a
    // blocked user learns nothing about the block from the call attempt.
    if (await deps.isBlocked(userId, calleeId)) return reject(userId, frame.callId, 'unavailable');

    const caller = await deps.getUser(userId);
    if (!caller) return reject(userId, frame.callId, 'not_allowed');

    const call: CallRecord = {
      id: frame.callId,
      conversationId: frame.conversationId,
      callerId: userId,
      calleeId,
      media: frame.media,
      state: 'ringing',
      callerClient: frame.clientId,
      calleeClient: null,
      createdAt: Date.now(),
    };

    const created = await store.create(call, RINGING_TTL_SECONDS);
    if (created === 'caller_busy') return reject(userId, frame.callId, 'self_busy');
    if (created === 'callee_busy') return reject(userId, frame.callId, 'busy');

    scheduleRingTimeout(call.id);
    await publish(calleeId, {
      type: 'call.incoming',
      callId: call.id,
      conversationId: call.conversationId,
      media: call.media,
      from: { id: caller.id, username: caller.username, displayName: caller.displayName },
      callerClient: call.callerClient,
    });
    await publish(userId, { type: 'call.ringing', callId: call.id });
  }

  async function onAccept(userId: string, frame: Extract<CallFrame, { type: 'call.accept' }>) {
    const accepted = await store.accept(frame.callId, userId, frame.clientId, ACTIVE_TTL_SECONDS);
    if (!accepted) {
      // Either another device won the race (its `call.accepted` already reached every
      // one of this user's connections, which then dismiss their own ringing UI), or the
      // call is gone. Only the latter needs an explicit answer.
      const existing = await store.get(frame.callId);
      if (!existing) {
        await publish(userId, { type: 'call.ended', callId: frame.callId, reason: 'missed', by: null });
      }
      return;
    }
    clearRingTimer(accepted.id);
    const payload = { type: 'call.accepted', callId: accepted.id, by: frame.clientId };
    await Promise.all([publish(accepted.callerId, payload), publish(accepted.calleeId, payload)]);
  }

  async function onDecline(userId: string, frame: Extract<CallFrame, { type: 'call.decline' }>) {
    const call = await store.get(frame.callId);
    if (!call || call.calleeId !== userId || call.state !== 'ringing') return;
    const ended = await store.end(call);
    if (!ended) return;
    clearRingTimer(call.id);
    await notifyEnded(ended, 'declined', userId);
  }

  async function onEnd(userId: string, frame: Extract<CallFrame, { type: 'call.end' }>) {
    const call = await store.get(frame.callId);
    if (!call || !isParticipant(call, userId)) return;
    const ended = await store.end(call);
    if (!ended) return;
    clearRingTimer(call.id);
    // Use the record `end` actually deleted: an accept may have landed between our read
    // and the delete, and only the deleted record reflects the state the call was in.
    let reason: CallEndReason = 'hangup';
    if (ended.state === 'ringing') reason = userId === call.callerId ? 'cancelled' : 'declined';
    await notifyEnded(ended, reason, userId);
  }

  async function onKeepalive(userId: string, frame: Extract<CallFrame, { type: 'call.keepalive' }>) {
    const call = await store.get(frame.callId);
    if (!call || !isParticipant(call, userId)) {
      // The server no longer knows this call (for example, signaling was unreachable for
      // longer than the keep-alive window). Tell the client so it does not linger.
      await publish(userId, { type: 'call.ended', callId: frame.callId, reason: 'hangup', by: null });
      return;
    }
    if (call.state === 'active') await store.touch(call, ACTIVE_TTL_SECONDS);
  }

  async function onSignal(userId: string, frame: Extract<CallFrame, { type: 'call.signal' }>) {
    if (!(await store.hit(`signal:${userId}`, SIGNALS_PER_MINUTE, 60))) return;
    const call = await store.get(frame.callId);
    // Signaling is only meaningful once the callee has answered.
    if (!call || !isParticipant(call, userId) || call.state !== 'active') return;
    await publish(otherParty(call, userId), {
      type: 'call.signal',
      callId: call.id,
      from: userId,
      payload: frame.payload,
    });
  }

  return {
    async handleFrame(userId, rawFrame) {
      const parsed = callFrameSchema.safeParse(rawFrame);
      if (!parsed.success) return;
      const frame = parsed.data;
      switch (frame.type) {
        case 'call.invite':
          return onInvite(userId, frame);
        case 'call.accept':
          return onAccept(userId, frame);
        case 'call.decline':
          return onDecline(userId, frame);
        case 'call.end':
          return onEnd(userId, frame);
        case 'call.keepalive':
          return onKeepalive(userId, frame);
        case 'call.signal':
          return onSignal(userId, frame);
      }
    },
    dispose() {
      for (const timer of ringTimers.values()) clearTimeout(timer);
      ringTimers.clear();
    },
  };
}
