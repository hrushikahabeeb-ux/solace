import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { Collections, MEDIA_BUCKET_NAME } from './collections.js';

export { Collections, MEDIA_BUCKET_NAME };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see apps/server/.env.example`);
  return value;
}

/** How long bus events are retained. Change streams read the oplog, not this
 *  collection, so this only needs to outlive a reasonable consumer delay. */
const REALTIME_EVENT_RETENTION_SECONDS = 60;

const client = new MongoClient(requireEnv('MONGODB_URL'), {
  // Fail fast instead of hanging on the driver's 30s default when Mongo is down —
  // every request touching MongoDB would otherwise stall for half a minute before
  // erroring.
  serverSelectionTimeoutMS: 5000,
});

// A single shared in-flight promise, not just a boolean flag: without this, two
// requests arriving before the first connection finishes would each call
// client.connect() independently — wasteful at best, racy at worst. Every caller
// awaits the SAME promise instead.
let connectPromise: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (!connectPromise) {
    connectPromise = client.connect().then(
      () => ensureIndexes(),
      (err) => {
        // Let the next call retry from scratch instead of being permanently stuck
        // on a rejected promise because Mongo happened to be down once.
        connectPromise = null;
        throw err;
      },
    );
  }
  return connectPromise;
}

let indexesEnsured = false;
async function ensureIndexes(): Promise<void> {
  if (indexesEnsured) return;
  const db = client.db();
  await Promise.all([
    db.collection(Collections.taskActivity).createIndex({ taskId: 1, createdAt: 1 }),
    db.collection(Collections.notes).createIndex({ workspaceId: 1, updatedAt: -1 }),
    db.collection(Collections.decisions).createIndex({ workspaceId: 1, createdAt: -1 }),
    db.collection(Collections.polls).createIndex({ workspaceId: 1, createdAt: -1 }),
    db
      .collection(Collections.realtimeEvents)
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: REALTIME_EVENT_RETENTION_SECONDS }),
    // expireAfterSeconds: 0 means "delete once the stored date has passed". MongoDB's
    // TTL monitor runs about once a minute, so all readers ALSO filter on expiresAt;
    // the TTL index is only garbage collection, never the source of truth.
    db.collection(Collections.callSessions).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection(Collections.callLocks).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection(Collections.callRateLimits).createIndex({ windowEnd: 1 }, { expireAfterSeconds: 0 }),
  ]);
  indexesEnsured = true;
}

/** Connected database handle (the database named in MONGODB_URL). */
export async function getDb(): Promise<Db> {
  await ensureConnected();
  return client.db();
}

/** Connected client, for operations that need sessions/transactions. */
export async function getMongoClient(): Promise<MongoClient> {
  await ensureConnected();
  return client;
}

export async function getCollection<T extends Document = Document>(name: string): Promise<Collection<T>> {
  await ensureConnected();
  return client.db().collection<T>(name);
}

/** Used by GET /ready — a real check that Mongo is actually reachable, not just that
 *  the client object was constructed. */
export async function pingMongo(): Promise<void> {
  await ensureConnected();
  await client.db().command({ ping: 1 });
}

export async function closeMongo(): Promise<void> {
  if (connectPromise) await client.close();
}
