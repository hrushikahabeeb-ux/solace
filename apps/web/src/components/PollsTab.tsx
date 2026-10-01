'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { useState, type FormEvent } from 'react';
import type { Poll } from '../lib/api';
import { DecryptedText } from './DecryptedText';

export function PollsTab({
  polls,
  loading,
  e2ee,
  myUserId,
  onCreate,
  onVote,
  onDelete,
}: {
  polls: Poll[];
  loading: boolean;
  e2ee: E2EEEngine | null;
  myUserId: string;
  onCreate: (question: string, options: string[]) => void;
  onVote: (pollId: string, optionId: string) => void;
  onDelete: (pollId: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto bg-canvas p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl text-ink-canvas">Polls</h2>
          <button onClick={() => setShowForm(true)} className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream shadow-soft">
            + New Poll
          </button>
        </div>

        {loading ? (
          <p className="mt-8 text-center text-sm text-ink-canvas-muted">Loading polls…</p>
        ) : polls.length === 0 ? (
          <div className="mt-8 rounded-lg bg-card p-8 text-center shadow-card">
            <p className="text-2xl">📊</p>
            <p className="mt-2 font-display text-lg text-ink-card">No polls yet</p>
            <p className="mt-1 text-sm text-ink-card-muted">Ask the group a quick question and see where everyone stands.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {polls.map((poll) => {
              const totalVotes = poll.votes.length;
              const myVote = poll.votes.find((v) => v.userId === myUserId)?.optionId;
              return (
                <div key={poll._id} className="rounded-md bg-card p-4 shadow-soft">
                  <div className="flex items-start justify-between gap-2">
                    <DecryptedText
                      ciphertext={poll.questionCiphertext}
                      sessionRef={poll.sessionRef}
                      e2ee={e2ee}
                      className="font-medium text-ink-card"
                    />
                    <button onClick={() => onDelete(poll._id)} className="shrink-0 text-xs text-ink-card-muted hover:text-danger">
                      ✕
                    </button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {poll.options.map((option) => {
                      const count = poll.votes.filter((v) => v.optionId === option.id).length;
                      const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                      const isMine = myVote === option.id;
                      return (
                        <button
                          key={option.id}
                          onClick={() => onVote(poll._id, option.id)}
                          className="relative block w-full overflow-hidden rounded-md bg-card-alt px-3 py-2 text-left text-sm"
                        >
                          <div
                            className="absolute inset-y-0 left-0 bg-coral/20"
                            style={{ width: `${pct}%` }}
                          />
                          <div className="relative flex items-center justify-between">
                            <span className={`flex items-center gap-1.5 text-ink-card ${isMine ? 'font-medium' : ''}`}>
                              {isMine && '✓ '}
                              <DecryptedText ciphertext={option.textCiphertext} sessionRef={poll.sessionRef} e2ee={e2ee} />
                            </span>
                            <span className="text-xs text-ink-card-muted">{count} ({pct}%)</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-ink-card-muted">{totalVotes} vote{totalVotes === 1 ? '' : 's'}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showForm && (
        <CreatePollModal
          onCreate={(question, options) => {
            onCreate(question, options);
            setShowForm(false);
          }}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

function CreatePollModal({ onCreate, onClose }: { onCreate: (question: string, options: string[]) => void; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);

  function updateOption(i: number, value: string) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || cleaned.length < 2) return;
    onCreate(question.trim(), cleaned);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-lg bg-card p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-ink-card">Create Poll</h3>
          <button type="button" onClick={onClose} className="text-ink-card-muted hover:opacity-70">✕</button>
        </div>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question…"
          className="mt-4 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          autoFocus
        />
        <div className="mt-3 space-y-2">
          {options.map((option, i) => (
            <input
              key={i}
              value={option}
              onChange={(e) => updateOption(i, e.target.value)}
              placeholder={`Option ${i + 1}`}
              className="w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
            />
          ))}
        </div>
        {options.length < 6 && (
          <button type="button" onClick={() => setOptions((prev) => [...prev, ''])} className="mt-2 text-xs font-medium text-coral">
            + Add option
          </button>
        )}
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-pill bg-card-alt py-2 text-sm text-ink-card">
            Cancel
          </button>
          <button type="submit" className="flex-1 rounded-pill bg-coral py-2 text-sm font-medium text-cream">
            Create Poll
          </button>
        </div>
      </form>
    </div>
  );
}
