/**
 * One-time (and safe to re-run) database setup for Solace.
 *
 *   npm run db:setup
 *
 * 1. Connects to MONGODB_URL (from apps/server/.env or the environment).
 * 2. For a self-hosted MongoDB started with a replica-set name but never initialised,
 *    initiates a single-node replica set. Prisma, change streams and transactions all
 *    require a replica set; MongoDB Atlas clusters already are one and are left alone.
 * 3. Pushes the Prisma schema (collections and unique indexes) with `prisma db push`.
 *
 * Nothing here deletes data.
 */
import '../src/lib/env.js';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, MongoServerError } from 'mongodb';

const NOT_YET_INITIALIZED = 94;
const NO_REPLICATION_ENABLED = 76;
const PRIMARY_WAIT_MS = 30_000;

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function describeUrl(url: string): string {
  return url.replace(/\/\/([^@/]*)@/, '//***@');
}

/** Admin connection that works before the replica set exists: connect straight to the
 *  one host, and drop any replicaSet option the driver would otherwise wait for. */
function adminUrl(url: string): string {
  return url
    .replace(/([?&])replicaSet=[^&]*&?/, '$1')
    .replace(/[?&]$/, '');
}

function firstHost(url: string): string {
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/?,]+)/.exec(url);
  return match?.[1] ?? 'localhost:27017';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function ensureReplicaSet(url: string): Promise<void> {
  if (url.startsWith('mongodb+srv://')) {
    console.log('• Atlas / SRV connection string detected: the cluster is already a replica set.');
    return;
  }

  const client = new MongoClient(adminUrl(url), { directConnection: true, serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
  } catch (err) {
    fail(
      `Could not connect to MongoDB at ${describeUrl(url)}.\n` +
        '  Is mongod running? On macOS with Homebrew: brew services start mongodb-community\n' +
        `  (${(err as Error).message})`,
    );
  }

  try {
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    if (hello.setName) {
      console.log(`• Replica set "${hello.setName}" is already initialised.`);
      return;
    }

    try {
      await admin.command({ replSetGetStatus: 1 });
      console.log('• Replica set is already initialised.');
      return;
    } catch (err) {
      const code = err instanceof MongoServerError ? err.code : undefined;
      if (code === NO_REPLICATION_ENABLED) {
        fail(
          'MongoDB is running as a standalone server, but Solace needs a replica set\n' +
            '  (Prisma uses transactions; realtime delivery uses change streams).\n\n' +
            '  Add these two lines to your mongod.conf and restart MongoDB:\n\n' +
            '      replication:\n' +
            '        replSetName: rs0\n\n' +
            '  Homebrew config file: /opt/homebrew/etc/mongod.conf (Apple Silicon)\n' +
            '                        /usr/local/etc/mongod.conf    (Intel)\n' +
            '  Restart:              brew services restart mongodb-community\n\n' +
            '  Then run `npm run db:setup` again.',
        );
      }
      if (code !== NOT_YET_INITIALIZED) throw err;
    }

    const options = await admin.command({ getCmdLineOpts: 1 });
    const replSetName: string =
      options.parsed?.replication?.replSetName ?? options.parsed?.replication?.replSet ?? 'rs0';
    const host = firstHost(url);
    console.log(`• Initialising single-node replica set "${replSetName}" on ${host} ...`);
    await admin.command({ replSetInitiate: { _id: replSetName, members: [{ _id: 0, host }] } });

    const deadline = Date.now() + PRIMARY_WAIT_MS;
    for (;;) {
      const state = await admin.command({ hello: 1 });
      if (state.isWritablePrimary) break;
      if (Date.now() > deadline) fail('Replica set was initiated but no primary was elected within 30 seconds.');
      await sleep(500);
    }
    console.log('• Replica set is ready.');
  } finally {
    await client.close();
  }
}

function pushPrismaSchema(): void {
  console.log('• Creating collections and indexes from prisma/schema.prisma ...');
  const result = spawnSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    cwd: serverDir,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail('`prisma db push` failed (see the output above).');
}

async function main(): Promise<void> {
  const url = process.env.MONGODB_URL;
  if (!url) fail('MONGODB_URL is not set. Copy apps/server/.env.example to apps/server/.env first.');

  console.log(`Setting up MongoDB at ${describeUrl(url)}`);
  await ensureReplicaSet(url);
  pushPrismaSchema();
  console.log('\n✔ Database is ready. Start the API with: npm run dev:server\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
