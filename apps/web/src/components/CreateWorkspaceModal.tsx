'use client';

import { useState, type FormEvent } from 'react';

const EMOJI_CHOICES = ['🚀', '📚', '💼', '🎨', '🏗️', '🎯', '🌱', '⚡'];

/** Deliberately tiny — one name field, an optional emoji/description, one button.
 *  The spec is explicit about this: workspace creation should never feel like filling
 *  out enterprise-software paperwork. */
export function CreateWorkspaceModal({
  defaultName,
  onCreate,
  onClose,
}: {
  defaultName: string;
  onCreate: (input: { name: string; emoji?: string; description?: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [emoji, setEmoji] = useState(EMOJI_CHOICES[0]);
  const [description, setDescription] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate({ name: name.trim(), emoji, description: description.trim() || undefined });
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg bg-card p-6 shadow-card"
      >
        <h3 className="font-display text-lg text-ink-card">Create Workspace</h3>
        <p className="mt-1 text-xs text-ink-card-muted">Tasks, a shared calendar, and files — right inside this chat.</p>

        <div className="mt-4 flex gap-2">
          {EMOJI_CHOICES.map((e) => (
            <button
              type="button"
              key={e}
              onClick={() => setEmoji(e)}
              className={`rounded-sm p-1.5 text-xl ${emoji === e ? 'bg-coral/20 ring-2 ring-coral' : 'hover:bg-card-alt'}`}
            >
              {e}
            </button>
          ))}
        </div>

        <input
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          placeholder="Workspace name"
          className="mt-3 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
          autoFocus
        />
        <input
          value={description}
          onChange={(ev) => setDescription(ev.target.value)}
          placeholder="What's this workspace for? (optional)"
          className="mt-2 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
        />

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-pill bg-card-alt py-2 text-sm text-ink-card">
            Cancel
          </button>
          <button type="submit" className="flex-1 rounded-pill bg-coral py-2 text-sm font-medium text-cream">
            Create Workspace
          </button>
        </div>
      </form>
    </div>
  );
}
