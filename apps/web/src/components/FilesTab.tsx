'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { useEffect, useState } from 'react';
import type { WorkspaceFile, StorageSummary, Folder, FileCategory, ConversationMemberSummary } from '../lib/api';
import type { MessageEnvelope } from '../lib/messageEnvelope';
import { MediaBubble, type MediaPayload } from './MediaBubble';
import { decryptWorkspaceField } from '../lib/e2ee';

const CATEGORIES: { id: FileCategory | 'all'; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '📁' },
  { id: 'document', label: 'Documents', icon: '📄' },
  { id: 'image', label: 'Images', icon: '🖼️' },
  { id: 'video', label: 'Videos', icon: '🎥' },
  { id: 'audio', label: 'Audio', icon: '🎵' },
  { id: 'archive', label: 'Archives', icon: '📦' },
  { id: 'other', label: 'Other', icon: '📦' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function FilesTab({
  files,
  loading,
  storage,
  folders,
  category,
  onSelectCategory,
  memberById,
  accessToken,
  e2ee,
  decryptFile,
  onAssignFolder,
  onCreateFolder,
  onDeleteFolder,
  onDeleteFile,
  onJumpToMessage,
}: {
  files: WorkspaceFile[];
  loading: boolean;
  storage: StorageSummary | null;
  folders: Folder[];
  category: FileCategory | 'all';
  onSelectCategory: (c: FileCategory | 'all') => void;
  memberById: (id: string) => ConversationMemberSummary | { displayName: string } | undefined;
  accessToken: string;
  e2ee: E2EEEngine | null;
  decryptFile: (file: WorkspaceFile) => Promise<MessageEnvelope | null>;
  onAssignFolder: (messageId: string, folderId: string | null) => void;
  onCreateFolder: (name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onDeleteFile: (messageId: string) => void;
  onJumpToMessage: () => void;
}) {
  const [search, setSearch] = useState('');
  const [decodedByMessageId, setDecodedByMessageId] = useState<Record<string, MessageEnvelope | null>>({});
  const [folderNames, setFolderNames] = useState<Record<string, string>>({});
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    if (!e2ee) return;
    folders.forEach((folder) => {
      if (folderNames[folder.id] !== undefined) return;
      decryptWorkspaceField(folder.nameCiphertext, folder.sessionRef, e2ee).then((name) => {
        if (name) setFolderNames((prev) => ({ ...prev, [folder.id]: name }));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, e2ee]);

  useEffect(() => {
    files.forEach((file) => {
      if (decodedByMessageId[file.messageId] !== undefined) return;
      decryptFile(file).then((envelope) => setDecodedByMessageId((prev) => ({ ...prev, [file.messageId]: envelope })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const visible = files.filter((file) => {
    if (activeFolder !== null && file.folderId !== activeFolder) return false;
    if (!search.trim()) return true;
    const envelope = decodedByMessageId[file.messageId];
    if (!envelope || envelope.kind !== 'media') return false;
    return envelope.filename.toLowerCase().includes(search.trim().toLowerCase());
  });

  return (
    <div className="flex-1 overflow-y-auto bg-canvas p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl text-ink-canvas">Files</h2>
          {storage && (
            <p className="text-xs text-ink-canvas-muted">
              {formatBytes(storage.totalBytes)} used · {storage.fileCount} files
            </p>
          )}
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔎 Search files by name…"
          className="mt-3 w-full rounded-pill bg-canvas-alt px-4 py-2 text-sm text-ink-canvas placeholder:text-ink-canvas-muted outline-none focus:ring-2 focus:ring-coral/40"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelectCategory(c.id)}
              className={`rounded-pill px-3 py-1.5 text-xs font-medium ${
                category === c.id ? 'bg-coral text-cream' : 'bg-canvas-alt text-ink-canvas-muted'
              }`}
            >
              {c.icon} {c.label}
              {storage && c.id !== 'all' && ` (${formatBytes(storage.byCategory[c.id as FileCategory])})`}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setActiveFolder(null)}
            className={`rounded-pill px-3 py-1 text-xs ${activeFolder === null ? 'bg-lavender text-canvas' : 'bg-canvas-alt text-ink-canvas-muted'}`}
          >
            All locations
          </button>
          {folders.map((folder) => (
            <span
              key={folder.id}
              className={`flex items-center gap-1 rounded-pill px-3 py-1 text-xs ${
                activeFolder === folder.id ? 'bg-lavender text-canvas' : 'bg-canvas-alt text-ink-canvas-muted'
              }`}
            >
              <button onClick={() => setActiveFolder(folder.id)} className="flex items-center gap-1">
                📁 {folderNames[folder.id] ?? '…'}
              </button>
              <button
                onClick={() => {
                  if (activeFolder === folder.id) setActiveFolder(null);
                  onDeleteFolder(folder.id);
                }}
                className="opacity-60 hover:opacity-100"
                title="Delete folder (files stay, just become unfiled)"
              >
                ✕
              </button>
            </span>
          ))}
          <button onClick={() => setShowNewFolder(true)} className="text-xs font-medium text-coral">
            + New folder
          </button>
        </div>

        {loading ? (
          <p className="mt-8 text-center text-sm text-ink-canvas-muted">Loading files…</p>
        ) : visible.length === 0 ? (
          <div className="mt-8 rounded-lg bg-card p-8 text-center shadow-card">
            <p className="text-2xl">📂</p>
            <p className="mt-2 font-display text-lg text-ink-card">No files yet</p>
            <p className="mt-1 text-sm text-ink-card-muted">Drop something into the chat and it'll show up here.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {visible.map((file) => {
              const envelope = decodedByMessageId[file.messageId];
              const sender = memberById(file.senderId);
              const media: MediaPayload | null =
                envelope && envelope.kind === 'media'
                  ? {
                      mediaType: envelope.mediaType,
                      filename: envelope.filename,
                      mimeType: envelope.mimeType,
                      sizeBytes: envelope.sizeBytes,
                      keyMaterial: envelope.keyMaterial,
                      thumbnailBase64: envelope.thumbnailBase64,
                      durationSeconds: envelope.durationSeconds,
                    }
                  : null;

              return (
                <div key={file.messageId} className="flex items-center gap-3 rounded-md bg-card p-3 shadow-soft">
                  <span className="text-xl">{CATEGORIES.find((c) => c.id === file.category)?.icon ?? '📄'}</span>
                  <div className="min-w-0 flex-1">
                    {media ? (
                      <MediaBubble messageId={file.messageId} media={media} accessToken={accessToken} />
                    ) : (
                      <p className="text-sm text-ink-card-muted">🔒 Decrypting…</p>
                    )}
                    <p className="mt-1 text-xs text-ink-card-muted">
                      {formatBytes(file.sizeBytes)} · {sender?.displayName ?? 'Someone'} · {new Date(file.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <select
                    value={file.folderId ?? ''}
                    onChange={(e) => onAssignFolder(file.messageId, e.target.value || null)}
                    className="rounded-sm bg-card-alt px-2 py-1 text-xs text-ink-card"
                  >
                    <option value="">Unfiled</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {folderNames[f.id] ?? '…'}
                      </option>
                    ))}
                  </select>
                  <button onClick={onJumpToMessage} className="text-xs text-lavender-deep hover:underline">
                    ↩
                  </button>
                  <button onClick={() => onDeleteFile(file.messageId)} className="text-xs text-ink-card-muted hover:text-danger">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showNewFolder && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40" onClick={() => setShowNewFolder(false)}>
          <div className="w-full max-w-xs rounded-lg bg-card p-5 shadow-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-base text-ink-card">New folder</h3>
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              className="mt-3 w-full rounded-md bg-cream px-3 py-2 text-sm text-ink-card outline-none focus:ring-2 focus:ring-coral/40"
              autoFocus
            />
            <div className="mt-3 flex gap-2">
              <button onClick={() => setShowNewFolder(false)} className="flex-1 rounded-pill bg-card-alt py-1.5 text-sm text-ink-card">
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!newFolderName.trim()) return;
                  onCreateFolder(newFolderName.trim());
                  setNewFolderName('');
                  setShowNewFolder(false);
                }}
                className="flex-1 rounded-pill bg-coral py-1.5 text-sm font-medium text-cream"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
