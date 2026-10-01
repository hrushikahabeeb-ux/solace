'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { useEffect, useState, type FormEvent } from 'react';
import type { Note } from '../lib/api';
import { DecryptedText } from './DecryptedText';
import { decryptWorkspaceField } from '../lib/e2ee';

export function NotesTab({
  notes,
  loading,
  e2ee,
  onCreate,
  onUpdate,
  onDelete,
}: {
  notes: Note[];
  loading: boolean;
  e2ee: E2EEEngine | null;
  onCreate: (title: string, body: string) => void;
  onUpdate: (noteId: string, title: string, body: string) => void;
  onDelete: (noteId: string) => void;
}) {
  const [editing, setEditing] = useState<Note | 'new' | null>(null);

  return (
    <div className="flex-1 overflow-y-auto bg-canvas p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl text-ink-canvas">Notes</h2>
          <button onClick={() => setEditing('new')} className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream shadow-soft">
            + New Note
          </button>
        </div>

        {loading ? (
          <p className="mt-8 text-center text-sm text-ink-canvas-muted">Loading notes…</p>
        ) : notes.length === 0 ? (
          <div className="mt-8 rounded-lg bg-card p-8 text-center shadow-card">
            <p className="text-2xl">📝</p>
            <p className="mt-2 font-display text-lg text-ink-card">No notes yet</p>
            <p className="mt-1 text-sm text-ink-card-muted">Jot down anything the workspace should remember.</p>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3">
            {notes.map((note) => (
              <button key={note._id} onClick={() => setEditing(note)} className="rounded-md bg-card p-4 text-left shadow-soft hover:opacity-90">
                <DecryptedText ciphertext={note.titleCiphertext} sessionRef={note.sessionRef} e2ee={e2ee} className="block font-medium text-ink-card" />
                <DecryptedText
                  ciphertext={note.bodyCiphertext}
                  sessionRef={note.sessionRef}
                  e2ee={e2ee}
                  className="mt-1 block line-clamp-3 text-xs text-ink-card-muted"
                />
                <p className="mt-2 text-[10px] text-ink-card-muted">{new Date(note.updatedAt).toLocaleDateString()}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <NoteEditor
          note={editing === 'new' ? null : editing}
          e2ee={e2ee}
          onSave={(title, body) => {
            if (editing === 'new') onCreate(title, body);
            else onUpdate(editing._id, title, body);
            setEditing(null);
          }}
          onDelete={editing !== 'new' ? () => { onDelete(editing._id); setEditing(null); } : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function NoteEditor({
  note,
  e2ee,
  onSave,
  onDelete,
  onClose,
}: {
  note: Note | null;
  e2ee: E2EEEngine | null;
  onSave: (title: string, body: string) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [ready, setReady] = useState(!note); // a new note needs no decryption, so it's ready immediately

  useEffect(() => {
    if (!note || !e2ee) return;
    Promise.all([
      decryptWorkspaceField(note.titleCiphertext, note.sessionRef, e2ee),
      decryptWorkspaceField(note.bodyCiphertext, note.sessionRef, e2ee),
    ]).then(([decryptedTitle, decryptedBody]) => {
      setTitle(decryptedTitle ?? '');
      setBody(decryptedBody ?? '');
      setReady(true);
    });
  }, [note, e2ee]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSave(title.trim(), body.trim());
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg bg-card p-6 shadow-card">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-ink-card">{note ? 'Edit note' : 'New note'}</h3>
          <button type="button" onClick={onClose} className="text-ink-card-muted hover:opacity-70">✕</button>
        </div>
        {!ready ? (
          <p className="mt-4 text-sm text-ink-card-muted">Decrypting…</p>
        ) : (
          <>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              className="mt-4 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
              autoFocus
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write something…"
              rows={6}
              className="mt-2 w-full resize-none rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
            />
          </>
        )}
        <div className="mt-4 flex gap-2">
          {onDelete && (
            <button type="button" onClick={onDelete} className="text-xs text-danger hover:underline">
              Delete
            </button>
          )}
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-pill bg-card-alt px-4 py-2 text-sm text-ink-card">
            Cancel
          </button>
          <button type="submit" disabled={!ready} className="rounded-pill bg-coral px-4 py-2 text-sm font-medium text-cream disabled:opacity-60">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
