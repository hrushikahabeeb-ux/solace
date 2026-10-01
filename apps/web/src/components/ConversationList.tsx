'use client';

import { useState, type FormEvent } from 'react';
import type { ConversationSummary } from '../lib/api';
import { avatarColorFor } from '../lib/avatarColor';

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onStartChat,
  startChatError,
  startingChatBusy,
  onCreateGroup,
  loading,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStartChat: (username: string) => void;
  startChatError: string | null;
  startingChatBusy: boolean;
  onCreateGroup: (title: string, usernames: string[]) => void;
  loading?: boolean;
}) {
  const [username, setUsername] = useState('');
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupUsernames, setGroupUsernames] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    onStartChat(username.trim());
    setUsername('');
  }

  function handleCreateGroup(e: FormEvent) {
    e.preventDefault();
    const usernames = groupUsernames
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (!groupTitle.trim() || usernames.length === 0) return;
    onCreateGroup(groupTitle.trim(), usernames);
    setGroupTitle('');
    setGroupUsernames('');
    setShowGroupForm(false);
  }

  return (
    <aside className="flex h-full w-full max-w-xs flex-col border-r border-on-canvas bg-canvas-alt">
      <div className="flex items-center justify-between px-4 py-5">
        <h2 className="font-display text-lg text-ink-canvas">Chats</h2>
        <button
          onClick={() => setShowGroupForm((v) => !v)}
          className="text-xs text-lavender hover:underline"
          title="Create a group"
        >
          + Group
        </button>
      </div>

      <form onSubmit={handleSubmit} className="px-4 pb-3">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Start a chat with username…"
          className="w-full rounded-md bg-canvas px-3 py-2 text-sm text-ink-canvas placeholder:text-ink-canvas-muted outline-none ring-coral/40 focus:ring-2"
        />
        {startChatError && <p className="mt-1 text-xs text-danger">{startChatError}</p>}
        <button
          type="submit"
          disabled={startingChatBusy}
          className="mt-2 w-full rounded-pill bg-coral py-1.5 text-sm font-medium text-cream disabled:opacity-60"
        >
          {startingChatBusy ? 'Starting…' : 'Start chat'}
        </button>
      </form>

      {showGroupForm && (
        <form onSubmit={handleCreateGroup} className="space-y-2 border-b border-on-canvas px-4 pb-4">
          <input
            value={groupTitle}
            onChange={(e) => setGroupTitle(e.target.value)}
            placeholder="Group name"
            className="w-full rounded-md bg-canvas px-3 py-2 text-sm text-ink-canvas placeholder:text-ink-canvas-muted outline-none focus:ring-2 focus:ring-coral/40"
          />
          <input
            value={groupUsernames}
            onChange={(e) => setGroupUsernames(e.target.value)}
            placeholder="usernames, comma-separated"
            className="w-full rounded-md bg-canvas px-3 py-2 text-sm text-ink-canvas placeholder:text-ink-canvas-muted outline-none focus:ring-2 focus:ring-coral/40"
          />
          <button type="submit" className="w-full rounded-pill bg-lavender py-1.5 text-sm font-medium text-canvas">
            Create group
          </button>
        </form>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading &&
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <span className="h-10 w-10 flex-shrink-0 animate-pulse rounded-pill bg-canvas" />
              <span className="flex-1 space-y-2">
                <span className="block h-3 w-24 animate-pulse rounded-sm bg-canvas" />
                <span className="block h-2.5 w-16 animate-pulse rounded-sm bg-canvas" />
              </span>
            </div>
          ))}
        {!loading && conversations.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-ink-canvas-muted">No conversations yet — start one above.</p>
        )}
        {conversations.map((conversation) => {
          const isGroup = conversation.type !== 'DIRECT';
          const peer = conversation.members[0];
          const title = isGroup ? (conversation.title ?? 'Group') : (peer?.displayName ?? 'Unknown');
          const subtitle = isGroup ? `${conversation.members.length + 1} members` : `@${peer?.username}`;

          return (
            <button
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                selectedId === conversation.id ? 'bg-canvas' : 'hover:bg-canvas/60'
              }`}
            >
              <span
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-pill text-sm font-medium text-canvas"
                style={{ backgroundColor: avatarColorFor(peer?.id ?? conversation.id) }}
              >
                {isGroup ? '👥' : (peer?.displayName?.[0]?.toUpperCase() ?? '?')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink-canvas">{title}</span>
                <span className="block truncate text-xs text-ink-canvas-muted">{subtitle}</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
