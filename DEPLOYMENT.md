# Deploying Solace

Solace has three runtime pieces and no containers:

| Piece | What it is | How it runs |
|---|---|---|
| API server | `apps/server` (Fastify, Node.js 20+) | `node dist/index.js` under a process manager |
| Web app | `apps/web` (Next.js) | `next start` under a process manager |
| Database | **MongoDB 5.0+ as a replica set** — the only datastore | MongoDB Atlas, or a self-hosted `mongod` |

MongoDB holds everything: users, conversations and messages (via Prisma), notes,
decisions, polls and task activity, encrypted media blobs (GridFS bucket `media`),
realtime fan-out between API processes (change streams), and call-signaling state.
It must be a replica set because Prisma uses transactions and realtime delivery uses
change streams. A single-node replica set is enough.

## 1. Database

**Option A — MongoDB Atlas (simplest).** Create a cluster (the free tier is fine to
start), create a database user, add your server's IP to the network access list, and
copy the `mongodb+srv://` connection string. Append the database name:

```
MONGODB_URL="mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/solace?retryWrites=true&w=majority"
```

Atlas clusters are already replica sets. Note that GridFS media counts toward Atlas
storage; size the tier for the media volume you expect.

**Option B — self-hosted MongoDB on the same server.** Install MongoDB Community 7.x
from MongoDB's official packages, then enable a replica set and authentication in
`/etc/mongod.conf`:

```yaml
net:
  bindIp: 127.0.0.1        # never expose 27017 publicly
replication:
  replSetName: rs0
security:
  authorization: enabled   # after creating the admin user below
```

Restart (`sudo systemctl restart mongod`), then run `npm run db:setup` once (it initiates
the replica set). Create a user for the app with `mongosh`
(`db.getSiblingDB('admin').createUser({ user: 'solace', pwd: '<password>', roles: [{ role: 'readWrite', db: 'solace' }] })`),
enable `authorization`, restart again, and use:

```
MONGODB_URL="mongodb://solace:<password>@localhost:27017/solace?authSource=admin&replicaSet=rs0"
```

Back up with `mongodump` on a schedule (it includes GridFS media).

## 2. Build and configure

```bash
git clone <your repo> solace && cd solace
npm install --workspaces --include-workspace-root
cp apps/server/.env.example apps/server/.env      # then edit it (see below)
npm run prisma:generate
npm run db:setup                                  # replica set check + collections/indexes
npm run build -w @solace/server
NEXT_PUBLIC_API_URL=https://api.example.com npm run build -w @solace/web
```

`apps/server/.env` in production:

```bash
MONGODB_URL=...                                  # from step 1
JWT_ACCESS_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)    # a different value
WEB_ORIGIN=https://chat.example.com
PORT=4000
GIPHY_API_KEY=                                   # optional
PUBLIC_API_URL=                                  # optional, see below
```

Media uploads and downloads use signed, expiring URLs that point back at the API. The
API derives its public address from each request (honoring `X-Forwarded-Proto` and
`X-Forwarded-Host`, which Caddy sets). Set `PUBLIC_API_URL=https://api.example.com` only if
your proxy setup hides the real address.

## 3. Run under a process manager

Any process manager works. With [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start "npm run start -w @solace/server" --name solace-api
pm2 start "npm run start -w @solace/web" --name solace-web
pm2 save && pm2 startup                          # restart on reboot
```

Or with systemd, one unit per app (`WorkingDirectory=/path/to/solace`,
`ExecStart=/usr/bin/npm run start -w @solace/server`, `Restart=always`).

## 4. HTTPS with Caddy

Install Caddy from its official packages, point two DNS records at the server (e.g.
`chat.example.com` and `api.example.com`), put your domains in `deploy/Caddyfile`, and:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy provisions TLS automatically and proxies WebSockets (`/ws`) without extra config.

## Using MongoDB Compass

Compass connects with a normal MongoDB connection string.

- **Local development:** `mongodb://localhost:27017/?directConnection=true`
- **Self-hosted production:** never open 27017 publicly. Tunnel through SSH instead:
  `ssh -L 27017:localhost:27017 you@your-server`, then connect Compass to
  `mongodb://solace:<password>@localhost:27017/?authSource=admin&directConnection=true`.
- **Atlas:** paste the `mongodb+srv://` string from the Atlas dashboard.

In the `solace` database you will see one collection per Prisma model (`User`,
`Conversation`, `Message`, ...), plus `notes`, `decisions`, `polls`, `task_activity`,
`realtime_events`, `call_sessions`, `call_locks`, `call_rate_limits`, and the GridFS
pair `media.files` / `media.chunks`. Every field carrying user content is ciphertext;
seeing readable plaintext in one would mean the E2EE boundary broke.

## Voice and video calls (STUN/TURN)

Calls are peer to peer. Two things are needed for them to work in production:

- **HTTPS.** Browsers only allow camera and microphone access on secure origins (and
  `localhost`). Caddy provides this.
- **A TURN relay for strict NATs and mobile networks.** Without one, calls work only between
  peers that can reach each other directly, and fail for the rest. The relay only forwards
  encrypted media.

Install coturn natively (`sudo apt install coturn` on Ubuntu/Debian), copy
`deploy/turnserver.conf` to `/etc/turnserver.conf`, fill in the secret and public IP, and
`sudo systemctl enable --now coturn`. Then set on the API server:

```bash
TURN_SECRET=$(openssl rand -hex 32)      # same value as static-auth-secret in turnserver.conf
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
STUN_URLS=stun:turn.example.com:3478     # coturn answers STUN too
```

Point `turn.example.com` at the server and open **UDP and TCP 3478** and
**UDP 49160-49200** on the firewall. A managed TURN service that supports the same
time-limited HMAC credentials works too.

If `STUN_URLS` and `TURN_URLS` are both empty the server falls back to a public Google STUN
server, which is convenient for development but tells that provider each client's IP address.
`TURN_URLS` without `TURN_SECRET` is ignored rather than sent without credentials.

## Operational notes

- `GET /health` — process is up (for a basic liveness check).
- `GET /ready` — process can actually reach MongoDB through both Prisma and the native
  driver (use this for readiness checks).
- Running more than one API process is supported: realtime events and call state are
  shared through MongoDB, so a user connected to one process receives events published
  by another.
- The server holds two background sweeps in-process (`jobs/sweeps.ts`, for scheduled
  sends and disappearing messages). With several API processes they run redundantly on
  each one; they are idempotent, so this is harmless, just slightly wasteful.
- Rate limiting (`@fastify/rate-limit`) is in-memory per process; behind several
  processes it becomes per-process rather than global.
- Expired call state and realtime events are removed automatically by MongoDB TTL
  indexes; no cron job is needed.
