# Solace — Architecture & Roadmap

Solace is a privacy-first messaging platform. This document is the source of truth for
stack decisions, the end-to-end encryption design, the data model, and the phased build
plan. Every later phase builds on the contracts defined here; do not change the crypto
design without updating this file first.

## 1. Stack

| Layer | Choice | Reason |
|---|---|---|
| Web client | Next.js 14 (App Router) + TypeScript + Tailwind | Fast to build a polished UI; SSR only for public/marketing routes, the chat itself is a client-rendered app |
| Realtime | WebSocket (native `ws` on the server, native `WebSocket` on the client) | Lower overhead than Socket.IO for a single well-defined protocol; MongoDB change streams fan out across server instances |
| API | Fastify + TypeScript | Fast, schema-validated (JSON Schema/TypeBox), good plugin model |
| Database | MongoDB (replica set) — the only datastore; Prisma for the core models, the native driver for the rest | One service to run; Prisma keeps type-safe access and relation handling for conversations/memberships/devices |
| Realtime fan-out and call state | MongoDB (change streams, TTL-indexed collections) | WebSocket fan-out across instances, typing indicators, call busy-locks and rate limits |
| Media storage | MongoDB GridFS (bucket `media`) behind signed, expiring URLs | Stores ciphertext blobs only |
| E2EE cryptography | **WebCrypto** (ECDH P-256, HKDF-SHA256, AES-256-GCM) via the browser's native `crypto.subtle` | Standard, audited primitives with no WASM or third-party crypto dependency. The protocol composes them in the well-known multi-recipient hybrid-envelope pattern (as in age, PGP and JWE). It is stateless, so a message can be decrypted any number of times, in any order, concurrently, and after a reload. |
| Password hashing | Argon2id | Current OWASP recommendation |
| Auth transport | Short-lived JWT access token + rotating refresh token in an HttpOnly cookie | Standard, no custom session crypto |

No custom cryptographic primitives are implemented anywhere in this codebase. All
encryption, key agreement, and key derivation is delegated to the platform's WebCrypto
implementation. Application code only composes those primitives; the composition is in
`packages/crypto/src/engine.ts` and is covered by `packages/crypto/test`.

## 2. Threat model / non-negotiables

The server (API and MongoDB, including media storage) is treated as **honest-but-curious**: it
routes and stores what clients give it, but must never be able to derive plaintext.
Concretely, the server never receives:

- Message plaintext
- Unencrypted media/files
- Any private key (identity, one-time, session, or media key)

The server *does* legitimately see: who is talking to whom, when, message sizes,
device public keys, and ciphertext blobs. (This is the same metadata model Signal's
server has — full metadata hiding is out of scope for this project.)

## 3. E2EE design

### 3.1 Identity & key distribution
On first login on a device, the client:
1. Generates one static ECDH P-256 identity key pair with WebCrypto. The private key is
   created **non-extractable**: script running in the page can use it but can never read
   its bytes.
2. Uploads only the **public** key (raw uncompressed point, base64) when registering the
   device (`/auth/register`, `/auth/login`).
3. Stores the key pair in IndexedDB using the structured-clone support for `CryptoKey`
   objects (`packages/crypto/src/vault.ts`). No passphrase or pickle is involved, so a
   reload restores the identity with no user interaction.

There are no pre-keys, no signed pre-keys, and no key-exchange handshake. To find the
devices it must encrypt for, a client calls `POST /keys/lookup` with user ids (returns
each user's active devices) and/or device ids (returns exactly those devices, regardless
of age, so the sender of an old message can still be verified). Results are cached per
user with a short TTL and concurrent lookups are de-duplicated
(`packages/crypto/src/directory.ts`).

If the server knows a user's session but the browser no longer holds the matching device
private key (for example, site data was cleared), the client ends the session and
requires a fresh login, which registers a new device.

### 3.2 Message format and encryption (all conversation types)
Direct messages and groups use the same code path. To send a message the client:
1. Draws a fresh random 256-bit content key and encrypts the plaintext once with
   AES-256-GCM.
2. Computes the recipient set: every active device of every conversation member,
   including the sender's own devices (capped at 256 devices per message).
3. For each recipient device R, derives a key-encryption key
   `KEK = HKDF-SHA256(ECDH(privSender, pubR), info = "wrap" | senderDevice | R)` and
   wraps the content key under it with AES-256-GCM. The associated data binds the
   conversation id, sender device id, and recipient device id.
4. Sends `"s2." + JSON` containing the sender device id, the body IV and ciphertext, and
   the list of per-device wraps.

To decrypt, a device finds its own wrap, looks up the sender device's public key, derives
the same KEK from its own private key (ECDH is symmetric), unwraps the content key, and
decrypts the body. Decryption is a pure function of the ciphertext and the device's
static key. Nothing is written or advanced, so it is safe to repeat, reorder, run
concurrently, or run from several tabs. Failures are classified (`legacy`, `malformed`,
`not_for_this_device`, `unknown_sender`, `sender_mismatch`, `authentication_failed`,
`directory_unavailable`) and only `directory_unavailable` is retried by the client.

### 3.3 Group membership changes
Recipients are computed per message, so membership changes need no key distribution or
rotation. A newly added member can read messages sent after they joined. A removed member
is simply no longer wrapped for, so they cannot read anything sent after removal. A device
that registers later cannot read messages sent before it existed, because no wrap was
made for it.

### 3.3.1 Security properties and trade-offs
- Sender authentication: a wrap only opens under the KEK derived from the sender's device
  key, and the sender device recorded in the envelope is checked against the wrap.
- Replay across contexts is rejected: the conversation, sender, and recipient are bound
  into the AEAD associated data.
- Tampering with either the body or any wrap is detected by AES-GCM.
- Unlike the Double Ratchet, static device keys provide **no per-message forward secrecy
  and no post-compromise security**. An attacker who records ciphertext and later obtains
  a device's private key can read that device's history. Non-extractable keys and the
  absence of any server-side private key are the mitigations. Ratcheting was deliberately
  removed because its state advancing on every decrypt was the cause of the
  intermittent "could not decrypt" failures.
- A message scheduled for later delivery is encrypted at schedule time and is readable
  only by the devices that were recipients then.

### 3.4 Media & files
1. Client generates a random 256-bit AES key + IV locally (`crypto/mediaCipher.ts`,
   using WebCrypto AES-GCM — a standard, audited primitive, not custom code).
2. File is encrypted client-side in chunks (streaming, so large videos do not need to
   fit in memory).
3. Ciphertext is uploaded via a signed, expiring URL into media storage (GridFS); the
   server never sees the key or plaintext.
4. The AES key + IV are packaged into a small JSON blob and sent as the *body* of an
   ordinary end-to-end encrypted message to the recipient(s) — so key material travels
   through the exact same E2EE channel as text, never as a URL fragment or query param.
5. Recipient downloads the ciphertext through a signed, expiring URL and decrypts locally.

### 3.5 What "disappearing" and "delete" mean under E2EE
The server can delete its copy of ciphertext/blobs on a timer or on request, but cannot
force deletion on a recipient's device that already decrypted and stored the plaintext
locally — this is disclosed in the UI copy, not hidden.

### 3.6 Voice and video calls
Calls are one-to-one, in direct conversations only. The audio and video never touch the
server.

1. **Media** flows peer to peer over WebRTC (DTLS-SRTP). When two devices cannot reach each
   other directly it flows through a TURN relay, which only forwards DTLS-SRTP ciphertext
   and cannot decrypt it.
2. **Signaling** uses the existing `/ws` connection with `call.*` frames
   (`apps/server/src/realtime/calls.ts`). The server tracks only call *lifecycle* (ringing,
   active, ended) so that ringing, busy detection, timeouts and "answered on another device"
   work. That is routing metadata of the same kind it already sees for messages.
3. **Signaling payloads are end-to-end encrypted.** The SDP offer and answer, ICE candidates
   and mute/camera state are encrypted by the clients with the same engine and recipient-device
   wrapping as messages (section 3.2), with the call id bound into the plaintext so a recorded
   signal cannot be replayed into another call. The server relays ciphertext. This matters
   because the SDP carries the DTLS fingerprint that authenticates the media connection: if the
   server could edit it, it could sit in the middle of a call. It also carries IP addresses,
   which the server therefore never sees.
4. **Access control** is enforced by the server: only members of a `DIRECT` conversation can
   call each other; a block is reported to the caller as a generic "unavailable"; a user can
   be in one call at a time (busy locks live in MongoDB and expire on their own if both clients
   vanish); invites and signals are rate limited.
5. **TURN credentials** are short-lived and derived per user with an HMAC under a secret shared
   only with the TURN server (`GET /calls/ice-servers`). No long-lived credential is ever sent
   to a client.
6. **Call history.** When a call ends, the *caller's* client posts one end-to-end encrypted
   message of kind `call` (outcome and duration) into the conversation. Posting from one side
   only makes each call appear exactly once. To the server it is an ordinary encrypted message.

Trade-offs, stated plainly: the server can see who called whom, when, and for how long the
call was signaling, as it can for messages. Signaling encryption inherits the static-key
properties in section 3.3.1 (no per-message forward secrecy for the signaling). A public STUN
server, used only as a development default, learns each client's public IP address; production
should run its own (see `DEPLOYMENT.md`).

Voice messages (recorded clips) reuse the encrypted media pipeline of section 3.4 unchanged.
A recording is discarded, and the microphone released, if the user leaves the conversation.

## 4. Data model (see `apps/server/prisma/schema.prisma`)
Users, Devices (one row per logged-in device + its public keys), Conversations,
ConversationMembers, Messages (ciphertext + metadata only), MediaObjects (storage key +
size + content-hash, no plaintext fields), Reactions, PinnedMessages, StarredMessages.

## 5. Phased build plan

- **Phase 0 (this pass):** Monorepo scaffold, architecture doc, Prisma schema, design
  tokens matching the reference theme, Fastify server bootstrap, Next.js app shell.
- **Phase 1:** Registration/login, Argon2 auth, JWT issuance, device identity key
  generation + upload, key-bundle endpoints, local encrypted key vault.
- **Phase 2:** 1:1 E2EE text messaging over WebSocket: session establishment, send/
  receive/decrypt, message persistence (ciphertext), delivery + read receipts, typing
  indicators.
- **Phase 3:** Message features: edit, delete, reply, forward, reactions, mentions,
  pin, star, search (client-side, over decrypted local index), link previews (fetched
  and sanitized server-side without leaking the URL to the destination directly).
- **Phase 4:** Encrypted media & file pipeline (images, video, arbitrary files),
  thumbnailing, EXIF stripping, upload/download progress, retry/resume.
- **Phase 5:** Groups & channels via multi-recipient envelopes, membership management, admin roles.
- **Phase 6:** Voice messages, stickers/GIF picker, disappearing messages, scheduled
  messages, draft sync, spam/block/report.
- **Phase 7:** Visual polish pass against the theme reference, performance pass,
  deployment config.

Each phase ends with a runnable increment — nothing is left half-wired.
