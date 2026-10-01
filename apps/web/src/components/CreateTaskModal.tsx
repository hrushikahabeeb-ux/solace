'use client';

import { useState, type FormEvent } from 'react';
import type { ConversationMemberSummary } from '../lib/api';

const PRIORITIES: { id: 'LOW' | 'MEDIUM' | 'HIGH'; label: string; color: string }[] = [
  { id: 'LOW', label: 'Low', color: 'var(--color-success)' },
  { id: 'MEDIUM', label: 'Medium', color: 'var(--color-warning)' },
  { id: 'HIGH', label: 'High', color: 'var(--color-danger)' },
];

export function CreateTaskModal({
  members,
  defaultTitle = '',
  onCreate,
  onClose,
}: {
  members: ConversationMemberSummary[];
  defaultTitle?: string;
  onCreate: (input: {
    title: string;
    description?: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH';
    dueDate?: string;
    assigneeId?: string;
  }) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
      assigneeId: assigneeId || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg bg-card p-6 shadow-card"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-ink-card">Create Task</h3>
          <button type="button" onClick={onClose} className="text-ink-card-muted hover:opacity-70">
            ✕
          </button>
        </div>

        <label className="mt-4 block text-xs font-medium text-ink-card-muted">Task title *</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          className="mt-1 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          autoFocus
        />

        <label className="mt-3 block text-xs font-medium text-ink-card-muted">Assignee</label>
        <select
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          className="mt-1 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>

        <label className="mt-3 block text-xs font-medium text-ink-card-muted">Due date</label>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="mt-1 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        />

        <label className="mt-3 block text-xs font-medium text-ink-card-muted">Priority</label>
        <div className="mt-1 flex gap-2">
          {PRIORITIES.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setPriority(p.id)}
              className="flex-1 rounded-pill py-1.5 text-xs font-medium"
              style={{
                backgroundColor: priority === p.id ? p.color : 'var(--color-bg-cream)',
                color: priority === p.id ? '#fff' : 'var(--color-text-on-card)',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="mt-3 block text-xs font-medium text-ink-card-muted">Description (optional)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add more details…"
          rows={2}
          className="mt-1 w-full resize-none rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        />

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-pill bg-card-alt py-2 text-sm text-ink-card">
            Cancel
          </button>
          <button type="submit" className="flex-1 rounded-pill bg-coral py-2 text-sm font-medium text-cream">
            Create Task
          </button>
        </div>
      </form>
    </div>
  );
}
