'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { useEffect, useState, type FormEvent } from 'react';
import type { ConversationMemberSummary, TaskActivityEntry, WireTaskWithDetails } from '../lib/api';
import { DecryptedText } from './DecryptedText';
import { decryptWorkspaceField } from '../lib/e2ee';

const STATUS_OPTIONS: { id: 'TODO' | 'IN_PROGRESS' | 'DONE'; label: string; color: string }[] = [
  { id: 'TODO', label: 'To Do', color: 'var(--color-accent-lavender)' },
  { id: 'IN_PROGRESS', label: 'In Progress', color: 'var(--color-warning)' },
  { id: 'DONE', label: 'Done', color: 'var(--color-success)' },
];

export function TaskDetailPanel({
  task,
  workspaceName,
  members,
  e2ee,
  activity,
  onClose,
  onToggleDone,
  onChangeStatus,
  onChangePriority,
  onChangeAssignee,
  onChangeDueDate,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  onAddComment,
  onJumpToSourceMessage,
  onDelete,
}: {
  task: WireTaskWithDetails;
  workspaceName: string;
  members: ConversationMemberSummary[];
  e2ee: E2EEEngine | null;
  activity: TaskActivityEntry[];
  onClose: () => void;
  onToggleDone: () => void;
  onChangeStatus: (status: 'TODO' | 'IN_PROGRESS' | 'DONE') => void;
  onChangePriority: (priority: 'LOW' | 'MEDIUM' | 'HIGH') => void;
  onChangeAssignee: (assigneeId: string | null) => void;
  onChangeDueDate: (dueDate: string | null) => void;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (subtaskId: string, done: boolean) => void;
  onDeleteSubtask: (subtaskId: string) => void;
  onAddComment: (text: string) => void;
  onJumpToSourceMessage?: () => void;
  onDelete: () => void;
}) {
  const [newSubtask, setNewSubtask] = useState('');
  const [comment, setComment] = useState('');
  const [decryptedComments, setDecryptedComments] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!e2ee) return;
    activity
      .filter((entry) => entry.type === 'comment' && entry.ciphertext && entry.sessionRef && !decryptedComments[entry._id])
      .forEach((entry) => {
        decryptWorkspaceField(entry.ciphertext!, entry.sessionRef!, e2ee).then((text) => {
          if (text) setDecryptedComments((prev) => ({ ...prev, [entry._id]: text }));
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, e2ee]);

  function handleAddSubtask(e: FormEvent) {
    e.preventDefault();
    if (!newSubtask.trim()) return;
    onAddSubtask(newSubtask.trim());
    setNewSubtask('');
  }

  function handleAddComment(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    onAddComment(comment.trim());
    setComment('');
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-card shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-soft p-5">
          <button
            onClick={onToggleDone}
            className="mt-1 h-6 w-6 shrink-0 rounded-pill border-2 border-coral"
            style={task.status === 'DONE' ? { backgroundColor: 'var(--color-accent-coral)' } : undefined}
          >
            {task.status === 'DONE' && <span className="text-sm text-cream">✓</span>}
          </button>
          <div className="min-w-0 flex-1">
            <DecryptedText
              ciphertext={task.titleCiphertext}
              sessionRef={task.sessionRef}
              e2ee={e2ee}
              className={`block font-display text-lg text-ink-card ${task.status === 'DONE' ? 'line-through opacity-60' : ''}`}
            />
            <div className="mt-2 flex gap-2">
              <span className="rounded-pill bg-card-alt px-2 py-0.5 text-xs text-ink-card">{workspaceName}</span>
              {task.sourceMessageId && onJumpToSourceMessage && (
                <button onClick={onJumpToSourceMessage} className="rounded-pill bg-card-alt px-2 py-0.5 text-xs text-lavender-deep">
                  ↩ From message
                </button>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-ink-card-muted hover:opacity-70">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
          {task.descriptionCiphertext && (
            <DecryptedText
              ciphertext={task.descriptionCiphertext}
              sessionRef={task.sessionRef}
              e2ee={e2ee}
              className="block text-ink-card-muted"
            />
          )}

          <Row label="Assignee">
            <select
              value={task.assigneeId ?? ''}
              onChange={(e) => onChangeAssignee(e.target.value || null)}
              className="rounded-sm bg-card-alt px-2 py-1 text-xs text-ink-card"
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Due date">
            <input
              type="date"
              value={task.dueDate ? task.dueDate.slice(0, 10) : ''}
              onChange={(e) => onChangeDueDate(e.target.value ? new Date(e.target.value).toISOString() : null)}
              className="rounded-sm bg-card-alt px-2 py-1 text-xs text-ink-card"
            />
          </Row>

          <Row label="Status">
            <div className="flex gap-1">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onChangeStatus(s.id)}
                  className="rounded-pill px-2 py-1 text-[11px] font-medium"
                  style={{
                    backgroundColor: task.status === s.id ? s.color : 'var(--color-bg-card-alt)',
                    color: task.status === s.id ? '#fff' : 'var(--color-text-on-card)',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Row>

          <Row label="Priority">
            <div className="flex gap-1">
              {(['LOW', 'MEDIUM', 'HIGH'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => onChangePriority(p)}
                  className={`rounded-pill px-2 py-1 text-[11px] font-medium ${
                    task.priority === p ? 'bg-coral text-cream' : 'bg-card-alt text-ink-card'
                  }`}
                >
                  {p[0] + p.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </Row>

          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-card-muted">Subtasks ({(task.subtasks ?? []).filter((s) => s.done).length}/{(task.subtasks ?? []).length})</p>
            <div className="space-y-1.5">
              {(task.subtasks ?? []).map((subtask) => (
                <div key={subtask.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={subtask.done} onChange={(e) => onToggleSubtask(subtask.id, e.target.checked)} />
                  <DecryptedText
                    ciphertext={subtask.titleCiphertext}
                    sessionRef={subtask.sessionRef}
                    e2ee={e2ee}
                    className={`flex-1 text-ink-card ${subtask.done ? 'line-through opacity-60' : ''}`}
                  />
                  <button onClick={() => onDeleteSubtask(subtask.id)} className="text-xs text-ink-card-muted hover:text-danger">
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <form onSubmit={handleAddSubtask} className="mt-2 flex gap-2">
              <input
                value={newSubtask}
                onChange={(e) => setNewSubtask(e.target.value)}
                placeholder="Add subtask"
                className="flex-1 rounded-sm bg-cream px-2 py-1 text-xs text-ink-card outline-none"
              />
              <button type="submit" className="text-xs font-medium text-coral">
                + Add
              </button>
            </form>
          </div>

          {activity.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-card-muted">Activity</p>
              <div className="space-y-2">
                {activity.map((entry) => (
                  <div key={entry._id} className="text-xs text-ink-card-muted">
                    {entry.type === 'comment' ? (
                      <p className="rounded-sm bg-card-alt px-2 py-1 text-ink-card">{decryptedComments[entry._id] ?? '🔒 …'}</p>
                    ) : (
                      <p className="italic">
                        {entry.activity?.kind === 'created' && 'Task created'}
                        {entry.activity?.kind === 'status_change' && `Status changed to ${entry.activity.to}`}
                        {entry.activity?.kind === 'assignee_change' && 'Assignee changed'}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleAddComment} className="flex items-center gap-2 border-t border-soft p-4">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment…"
            className="flex-1 rounded-pill bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          />
          <button type="submit" className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream">
            Send
          </button>
          <button type="button" onClick={onDelete} className="text-xs text-danger hover:underline">
            Delete
          </button>
        </form>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-ink-card-muted">{label}</span>
      {children}
    </div>
  );
}
