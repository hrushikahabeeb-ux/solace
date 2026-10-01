/**
 * MongoDB is the only datastore. Prisma (lib/prisma.ts) owns the relational-shaped core
 * models (users, conversations, messages, workspaces, ...). This native driver client
 * owns everything Prisma is not the right tool for:
 *
 *  - flexible, append-heavy content: task activity, notes, decisions, polls;
 *  - realtime fan-out between server instances (change streams on `realtime_events`);
 *  - short-lived call signaling state with TTL expiry (call sessions, busy locks,
 *    rate-limit windows) that previously lived in Redis;
 *  - encrypted media blobs in GridFS (bucket `media`), previously in S3/MinIO.
 *
 * Every document that carries user content stores it only as client-side ciphertext.
 */
export const Collections = {
  taskActivity: 'task_activity', // comments + status-change log per task, one doc per event
  notes: 'notes',
  decisions: 'decisions',
  polls: 'polls',
  realtimeEvents: 'realtime_events', // cross-instance event bus, consumed via change streams
  callSessions: 'call_sessions', // one document per ringing/active call
  callLocks: 'call_locks', // one document per user currently in a call ("busy" lock)
  callRateLimits: 'call_rate_limits', // fixed-window counters for call invites/signals
} as const;

/** GridFS bucket holding encrypted media ciphertext (see routes/media.ts). */
export const MEDIA_BUCKET_NAME = 'media';
