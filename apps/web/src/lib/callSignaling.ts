'use client';

import { newId, type CallClientFrame, type CallServerEvent } from './callProtocol';

const WS_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/^http/, 'ws');

const CALL_EVENT_TYPES = new Set<string>([
  'call.incoming',
  'call.ringing',
  'call.accepted',
  'call.signal',
  'call.ended',
  'call.rejected',
]);

type EventListener = (event: CallServerEvent) => void;
type StatusListener = (connected: boolean) => void;

/**
 * The signaling connection for calls.
 *
 * It is deliberately separate from the chat page's RealtimeClient. That client is torn
 * down and rebuilt whenever unrelated page state changes (for example opening a task or a
 * workspace), and it reconnects with the token it was created with, which expires after
 * fifteen minutes. A call must survive both, so this connection:
 *   - is owned by CallProvider and lives as long as the user is signed in;
 *   - asks for the CURRENT access token every time it (re)connects;
 *   - is authenticated once when it opens, so a token refresh never interrupts it.
 *
 * It speaks the same /ws endpoint as the chat client, so the server needs no second
 * transport. Frames that are not call frames are ignored here, and the chat client
 * likewise ignores call frames.
 */
export class CallSignaling {
  /** Identifies this browser tab to the server so "answered on another device" can be
   *  told apart from "answered here". Random per instance; carries no identity. */
  readonly clientId = newId();

  private socket: WebSocket | null = null;
  private eventListeners = new Set<EventListener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectDelayMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly getToken: () => string | null) {}

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
      this.emitStatus(false);
    }
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Returns false (and sends nothing) when the socket is not currently open. */
  send(frame: CallClientFrame): boolean {
    if (!this.isOpen()) return false;
    this.socket!.send(JSON.stringify(frame));
    return true;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(connected: boolean) {
    this.statusListeners.forEach((listener) => listener(connected));
  }

  private open() {
    const token = this.getToken();
    if (!token) {
      // Not signed in yet (or mid-refresh). Try again shortly instead of giving up.
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelayMs = 1000;
      this.emitStatus(true);
    };

    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const type = (parsed as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !CALL_EVENT_TYPES.has(type)) return;
      this.eventListeners.forEach((listener) => listener(parsed as CallServerEvent));
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.emitStatus(false);
      if (!this.stopped) this.scheduleReconnect();
    };

    // onerror is always followed by onclose, which owns the reconnect logic.
    socket.onerror = () => undefined;
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15_000);
  }
}
