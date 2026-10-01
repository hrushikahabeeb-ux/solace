import { MongoClient } from 'mongodb';
import { Collections } from '../src/lib/collections.js';

export interface TestMongo {
  client: MongoClient;
  dbName: string;
  stop(): Promise<void>;
}

/**
 * A MongoDB replica set for tests (transactions and change streams require one).
 *
 * If MONGODB_TEST_URL is set, that deployment is used with a throwaway database that is
 * dropped afterwards, so a developer's real data is never touched. Otherwise an
 * in-process replica set is started with mongodb-memory-server (it downloads a MongoDB
 * binary on first use and caches it), so `npm test` needs no local setup at all.
 */
export async function startTestMongo(): Promise<TestMongo> {
  const dbName = `solace_test_${process.pid}_${Date.now()}`;
  const external = process.env.MONGODB_TEST_URL;

  let client: MongoClient;
  let stopServer: () => Promise<void> = async () => undefined;

  if (external) {
    client = await MongoClient.connect(external, { serverSelectionTimeoutMS: 5000 });
  } else {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    client = await MongoClient.connect(replSet.getUri());
    stopServer = async () => {
      await replSet.stop();
    };
  }

  // Create the collections up front, as lib/mongo.ts does in the real server, so the
  // first transaction does not also have to create them.
  const db = client.db(dbName);
  for (const name of [Collections.callSessions, Collections.callLocks, Collections.callRateLimits]) {
    await db.createCollection(name).catch(() => undefined);
  }

  return {
    client,
    dbName,
    async stop() {
      await client.db(dbName).dropDatabase().catch(() => undefined);
      await client.close();
      await stopServer();
    },
  };
}
