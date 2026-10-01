'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { useState, type FormEvent } from 'react';
import type { Decision } from '../lib/api';
import { DecryptedText } from './DecryptedText';

export function DecisionsTab({
  decisions,
  loading,
  e2ee,
  memberById,
  onCreate,
  onDelete,
}: {
  decisions: Decision[];
  loading: boolean;
  e2ee: E2EEEngine | null;
  memberById: (id: string) => { displayName: string } | undefined;
  onCreate: (title: string, description?: string) => void;
  onDelete: (decisionId: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto bg-canvas p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl text-ink-canvas">Decisions</h2>
          <button onClick={() => setShowForm(true)} className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream shadow-soft">
            + Log Decision
          </button>
        </div>

        {loading ? (
          <p className="mt-8 text-center text-sm text-ink-canvas-muted">Loading decisions…</p>
        ) : decisions.length === 0 ? (
          <div className="mt-8 rounded-lg bg-card p-8 text-center shadow-card">
            <p className="text-2xl">📌</p>
            <p className="mt-2 font-display text-lg text-ink-card">No decisions logged yet</p>
            <p className="mt-1 text-sm text-ink-card-muted">Keep a durable record of what the team has agreed on.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {decisions.map((decision) => {
              const decidedBy = memberById(decision.decidedById);
              return (
                <div key={decision._id} className="flex items-start gap-3 rounded-md bg-card p-4 shadow-soft">
                  <span className="mt-0.5">📌</span>
                  <div className="min-w-0 flex-1">
                    <DecryptedText
                      ciphertext={decision.titleCiphertext}
                      sessionRef={decision.sessionRef}
                      e2ee={e2ee}
                      className="block font-medium text-ink-card"
                    />
                    {decision.descriptionCiphertext && (
                      <DecryptedText
                        ciphertext={decision.descriptionCiphertext}
                        sessionRef={decision.sessionRef}
                        e2ee={e2ee}
                        className="mt-1 block text-sm text-ink-card-muted"
                      />
                    )}
                    <p className="mt-1.5 text-xs text-ink-card-muted">
                      {decidedBy?.displayName ?? 'Someone'} · {new Date(decision.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                  <button onClick={() => onDelete(decision._id)} className="text-xs text-ink-card-muted hover:text-danger">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showForm && (
        <DecisionForm
          onCreate={(title, description) => {
            onCreate(title, description);
            setShowForm(false);
          }}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

function DecisionForm({ onCreate, onClose }: { onCreate: (title: string, description?: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onCreate(title.trim(), description.trim() || undefined);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-lg bg-card p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-ink-card">Log a Decision</h3>
          <button type="button" onClick={onClose} className="text-ink-card-muted hover:opacity-70">✕</button>
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What was decided?"
          className="mt-4 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          autoFocus
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Any context (optional)"
          rows={3}
          className="mt-2 w-full resize-none rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        />
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-pill bg-card-alt py-2 text-sm text-ink-card">
            Cancel
          </button>
          <button type="submit" className="flex-1 rounded-pill bg-coral py-2 text-sm font-medium text-cream">
            Log Decision
          </button>
        </div>
      </form>
    </div>
  );
}
