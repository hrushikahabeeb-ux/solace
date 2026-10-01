'use client';

import { useState, type FormEvent } from 'react';
import type { ConversationMemberSummary } from '../lib/api';

export function MembersPanel({
  title,
  members,
  myUserId,
  myRole,
  onAddMember,
  onRemoveMember,
  onChangeRole,
  onClose,
}: {
  title: string;
  members: ConversationMemberSummary[];
  myUserId: string;
  myRole: 'OWNER' | 'ADMIN' | 'MEMBER' | undefined;
  onAddMember: (username: string) => void;
  onRemoveMember: (userId: string) => void;
  onChangeRole: (userId: string, role: 'ADMIN' | 'MEMBER') => void;
  onClose: () => void;
}) {
  const [username, setUsername] = useState('');
  const canManage = myRole === 'OWNER' || myRole === 'ADMIN';

  function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    onAddMember(username.trim());
    setUsername('');
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="max-h-[70vh] w-full max-w-md overflow-y-auto rounded-lg bg-card p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-lg text-ink-card">{title}</h3>

        <ul className="mt-4 space-y-2">
          {members.map((member) => (
            <li key={member.id} className="flex items-center justify-between rounded-sm bg-card-alt px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate text-ink-card">
                  {member.displayName} {member.id === myUserId && <span className="text-ink-card-muted">(you)</span>}
                </p>
                <p className="text-xs text-ink-card-muted">{member.role.toLowerCase()}</p>
              </div>
              {canManage && member.id !== myUserId && member.role !== 'OWNER' && (
                <div className="flex shrink-0 gap-2 text-xs">
                  {myRole === 'OWNER' && (
                    <button
                      onClick={() => onChangeRole(member.id, member.role === 'ADMIN' ? 'MEMBER' : 'ADMIN')}
                      className="text-lavender-deep hover:underline"
                    >
                      {member.role === 'ADMIN' ? 'Demote' : 'Promote'}
                    </button>
                  )}
                  <button onClick={() => onRemoveMember(member.id)} className="text-danger hover:underline">
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {canManage && (
          <form onSubmit={handleAdd} className="mt-4 flex gap-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Add by username"
              className="flex-1 rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
            />
            <button type="submit" className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream">
              Add
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
