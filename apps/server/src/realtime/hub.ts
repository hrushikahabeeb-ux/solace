import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { ChangeStream, ChangeStreamInsertDocument, ResumeToken } from 'mongodb';
import { Collections, getCollection } from '../lib/mongo.js';

/**
 * Realtime event hub.
 *
 * Every publish is delivered immediately to sockets connected to THIS process, and is
 * also appended to the `realtime_events` collection. Every server process watches that
 * collection with a MongoDB change stream and delivers events that other processes
 * wrote to its own sockets. This is the same "any server instance" fan-out the Redis
 * pub/sub channel provided, with MongoDB as the only moving part.
 *
 * Events carry the id of the process that wrote them, so a process never delivers its
 * own events twice. Payloads are stored as the exact JSON string sent on the wire, so a
 * frame received through the change stream is byte-for-byte what a local socket gets.
 */

const INSTANCE_ID = randomUUID();

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** Change stream resume point has fallen off the oplog; start from "now" instead. */
const CHANGE_STREAM_HISTORY_LOST = 286;

interface BusEvent {
  origin: string;
  targetUserId: string;
  payload: string; // JSON-encoded frame
  createdAt: Date;
}

// Local (this process only) registry of connected sockets, keyed by userId. A single
// user can have multiple sockets open (multiple tabs/devices), so each entry is a Set.
const localConnections = new Map<string, Set<WebSocket>>();

let started = false;
let stopped = false;
let stream: ChangeStream<BusEvent, ChangeStreamInsertDocument<BusEvent>> | null = null;
let resumeToken: ResumeToken | undefined;
let reconnectTimer: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;

function ensureSubscribed(): void {
  if (started) return;
  started = true;
  void openStream();
}

function scheduleReopen(): void {
  if (stopped || reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** consecutiveFailures, RECONNECT_MAX_DELAY_MS);
  consecutiveFailures += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openStream();
  }, delay);
  reconnectTimer.unref();
}

async function openStream(): Promise<void> {
  if (stopped) return;
  try {
    const events = await getCollection<BusEvent>(Collections.realtimeEvents);
    const pipeline = [{ $match: { operationType: 'insert', 'fullDocument.origin': { $ne: INSTANCE_ID } } }];
    const current = events.watch<BusEvent, ChangeStreamInsertDocument<BusEvent>>(
      pipeline,
      resumeToken ? { resumeAfter: resumeToken } : {},
    );
    stream = current;

    // Emitted once the server has accepted the stream: the connection is healthy again.
    current.on('init', () => {
      consecutiveFailures = 0;
    });

    current.on('change', (change) => {
      consecutiveFailures = 0;
      resumeToken = change._id;
      const event = change.fullDocument;
      if (!event) return;
      deliverFrameLocally(event.targetUserId, event.payload);
    });

    current.on('error', (err: Error & { code?: number }) => {
      // The driver already retries resumable errors internally; anything reaching here
      // needs a fresh stream. If our resume point is gone, resume from the present.
      if (err.code === CHANGE_STREAM_HISTORY_LOST) resumeToken = undefined;
      if (consecutiveFailures === 0) console.error('realtime change stream failed; reconnecting', err);
      if (stream === current) stream = null;
      void current.close().catch(() => undefined);
      scheduleReopen();
    });

    current.on('close', () => {
      if (stream === current) {
        stream = null;
        scheduleReopen();
      }
    });
  } catch (err) {
    if (consecutiveFailures === 0) console.error('realtime change stream could not start; retrying', err);
    scheduleReopen();
  }
}

function deliverFrameLocally(userId: string, frame: string): void {
  const sockets = localConnections.get(userId);
  if (!sockets) return;
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(frame);
  }
}

export function registerConnection(userId: string, socket: WebSocket): void {
  ensureSubscribed();
  if (!localConnections.has(userId)) localConnections.set(userId, new Set());
  localConnections.get(userId)!.add(socket);

  socket.on('close', () => {
    const sockets = localConnections.get(userId);
    sockets?.delete(socket);
    if (sockets && sockets.size === 0) localConnections.delete(userId);
  });
}

/** Publishes an event to every connection a user has open, on any server instance. */
export async function publishToUser(targetUserId: string, payload: unknown): Promise<void> {
  const frame = JSON.stringify(payload);
  // Local delivery is synchronous, so events published in order reach sockets in order.
  deliverFrameLocally(targetUserId, frame);
  try {
    const events = await getCollection<BusEvent>(Collections.realtimeEvents);
    await events.insertOne({ origin: INSTANCE_ID, targetUserId, payload: frame, createdAt: new Date() });
  } catch (err) {
    // Sockets on this process already have the event; only cross-instance fan-out is
    // affected, so this is logged rather than failing the request that published it.
    console.error('realtime fan-out write failed', err);
  }
}

/** Starts the cross-instance subscription eagerly (called once at server start-up). */
export function startRealtimeHub(): void {
  ensureSubscribed();
}

/** Stops the change stream on shutdown. */
export async function stopRealtimeHub(): Promise<void> {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = stream;
  stream = null;
  if (current) await current.close().catch(() => undefined);
}
