'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { useState } from 'react';
import type { WireTaskWithDetails } from '../lib/api';
import { DecryptedText } from './DecryptedText';
import { avatarColorFor } from '../lib/avatarColor';

type Filter = 'ALL' | 'TODO' | 'IN_PROGRESS' | 'DONE';

const PRIORITY_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  LOW: { bg: 'var(--color-success)', fg: '#fff', label: 'Low' },
  MEDIUM: { bg: 'var(--color-warning)', fg: '#fff', label: 'Medium' },
  HIGH: { bg: 'var(--color-danger)', fg: '#fff', label: 'High' },
};

export function TaskBoard({
  tasks,
  loading,
  e2ee,
  memberById,
  onOpenTask,
  onToggleDone,
  onCreateNew,
}: {
  tasks: WireTaskWithDetails[];
  loading: boolean;
  e2ee: E2EEEngine | null;
  memberById: (id: string) => { displayName: string } | undefined;
  onOpenTask: (taskId: string) => void;
  onToggleDone: (task: WireTaskWithDetails) => void;
  onCreateNew: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('ALL');

  const counts = {
    ALL: tasks.length,
    TODO: tasks.filter((t) => t.status === 'TODO').length,
    IN_PROGRESS: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    DONE: tasks.filter((t) => t.status === 'DONE').length,
  };
  const visible = filter === 'ALL' ? tasks : tasks.filter((t) => t.status === filter);

  return (
    <div className="flex-1 overflow-y-auto bg-canvas p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl text-ink-canvas">Tasks</h2>
          <button onClick={onCreateNew} className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream shadow-soft">
            + New Task
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          {(['ALL', 'TODO', 'IN_PROGRESS', 'DONE'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-pill px-3 py-1.5 text-xs font-medium ${
                filter === f ? 'bg-coral text-cream' : 'bg-canvas-alt text-ink-canvas-muted'
              }`}
            >
              {f === 'ALL' ? 'All' : f === 'IN_PROGRESS' ? 'In Progress' : f === 'TODO' ? 'To Do' : 'Done'} ({counts[f]})
            </button>
          ))}
        </div>

        {loading ? (
          <p className="mt-8 text-center text-sm text-ink-canvas-muted">Loading tasks…</p>
        ) : visible.length === 0 ? (
          <div className="mt-8 rounded-lg bg-card p-8 text-center shadow-card">
            <p className="text-2xl">📋</p>
            <p className="mt-2 font-display text-lg text-ink-card">No tasks here yet</p>
            <p className="mt-1 text-sm text-ink-card-muted">Create one, or turn a message into a task from the chat.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {visible.map((task) => {
              const doneSubtasks = (task.subtasks ?? []).filter((s) => s.done).length;
              const progress = task.subtasks?.length ? Math.round((doneSubtasks / task.subtasks.length) * 100) : null;
              const assignee = task.assigneeId ? memberById(task.assigneeId) : undefined;
              const priorityStyle = PRIORITY_STYLE[task.priority];

              return (
                <div key={task.id} className="rounded-md bg-card p-3 shadow-soft">
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => onToggleDone(task)}
                      className="mt-0.5 h-5 w-5 shrink-0 rounded-pill border-2 border-coral text-xs"
                      style={task.status === 'DONE' ? { backgroundColor: 'var(--color-accent-coral)' } : undefined}
                    >
                      {task.status === 'DONE' && <span className="text-cream">✓</span>}
                    </button>
                    <button onClick={() => onOpenTask(task.id)} className="flex-1 text-left">
                      <DecryptedText
                        ciphertext={task.titleCiphertext}
                        sessionRef={task.sessionRef}
                        e2ee={e2ee}
                        className={`block text-sm font-medium text-ink-card ${task.status === 'DONE' ? 'line-through opacity-60' : ''}`}
                      />
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-card-muted">
                        <span className="rounded-pill px-2 py-0.5 text-[10px] font-medium" style={{ backgroundColor: priorityStyle.bg, color: priorityStyle.fg }}>
                          {priorityStyle.label}
                        </span>
                        {assignee && (
                          <span className="flex items-center gap-1">
                            <span
                              className="flex h-4 w-4 items-center justify-center rounded-pill text-[9px] text-canvas"
                              style={{ backgroundColor: avatarColorFor(task.assigneeId!) }}
                            >
                              {assignee.displayName[0]?.toUpperCase()}
                            </span>
                            {assignee.displayName}
                          </span>
                        )}
                        {task.dueDate && <span>📅 {new Date(task.dueDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
                      </div>
                      {progress !== null && (
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-pill bg-card-alt">
                          <div className="h-full bg-coral" style={{ width: `${progress}%` }} />
                        </div>
                      )}
                    </button>
                    <button onClick={() => onOpenTask(task.id)} className="text-ink-card-muted">
                      ›
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
