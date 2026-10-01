'use client';

import type { WireMessage, WireTaskWithDetails, Subtask, TaskActivityEntry, WireEventWithParticipants, EventParticipant, Note, Decision, Poll } from './api';

type ServerEvent =
  | { type: 'ready' }
  | { type: 'message.new'; conversationId: string; message: WireMessage }
  | {
      type: 'message.receipt';
      conversationId: string;
      messageId: string;
      userId: string;
      status: 'DELIVERED' | 'READ';
      at: string;
    }
  | { type: 'typing'; conversationId: string; userId: string; state: 'start' | 'stop' }
  | { type: 'message.edited'; conversationId: string; message: WireMessage }
  | { type: 'message.deleted'; conversationId: string; messageId: string }
  | {
      type: 'message.reaction';
      conversationId: string;
      messageId: string;
      userId: string;
      emoji: string;
      action: 'added' | 'removed';
    }
  | { type: 'message.pinned'; conversationId: string; messageId: string }
  | { type: 'message.unpinned'; conversationId: string; messageId: string }
  | { type: 'disappearing.changed'; conversationId: string; seconds: number | null }
  | { type: 'task.created'; workspaceId: string; task: WireTaskWithDetails }
  | { type: 'task.updated'; workspaceId: string; task: WireTaskWithDetails }
  | { type: 'task.deleted'; workspaceId: string; taskId: string }
  | { type: 'subtask.created'; workspaceId: string; taskId: string; subtask: Subtask }
  | { type: 'subtask.updated'; workspaceId: string; taskId: string; subtask: Subtask }
  | { type: 'subtask.deleted'; workspaceId: string; taskId: string; subtaskId: string }
  | { type: 'task.comment'; workspaceId: string; taskId: string; entry: TaskActivityEntry }
  | { type: 'event.created'; workspaceId: string; event: WireEventWithParticipants }
  | { type: 'event.updated'; workspaceId: string; event: WireEventWithParticipants }
  | { type: 'event.deleted'; workspaceId: string; eventId: string }
  | { type: 'event.rsvp'; workspaceId: string; eventId: string; participant: EventParticipant }
  | { type: 'note.created'; workspaceId: string; note: Note }
  | { type: 'note.updated'; workspaceId: string; note: Note }
  | { type: 'note.deleted'; workspaceId: string; noteId: string }
  | { type: 'decision.created'; workspaceId: string; decision: Decision }
  | { type: 'decision.deleted'; workspaceId: string; decisionId: string }
  | { type: 'poll.created'; workspaceId: string; poll: Poll }
  | { type: 'poll.voted'; workspaceId: string; poll: Poll }
  | { type: 'poll.deleted'; workspaceId: string; pollId: string };

type Listener = (event: ServerEvent) => void;

const WS_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/^http/, 'ws');

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectDelayMs = 1000;
  private closedByUser = false;

  constructor(private accessToken: string) {}

  connect(): void {
    this.closedByUser = false;
    this.socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(this.accessToken)}`);

    this.socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ServerEvent;
        this.listeners.forEach((listener) => listener(parsed));
      } catch {
        // ignore malformed frames
      }
    };

    this.socket.onclose = () => {
      if (this.closedByUser) return;
      // Basic exponential backoff, capped at 15s — enough for a demo; a production
      // client would also re-sync missed messages on reconnect via listMessages(before).
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15_000);
    };

    this.socket.onopen = () => {
      this.reconnectDelayMs = 1000;
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    this.socket?.close();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendTyping(conversationId: string, state: 'start' | 'stop'): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'typing', conversationId, state }));
    }
  }
}
