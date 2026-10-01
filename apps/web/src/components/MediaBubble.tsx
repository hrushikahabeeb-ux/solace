'use client';

import { useEffect, useState } from 'react';
import type { MediaKeyMaterial } from '@solace/crypto';
import { downloadAndDecryptMedia } from '../lib/mediaPipeline';
import { formatClock } from '../lib/voiceRecorder';

export interface MediaPayload {
  mediaType: 'image' | 'file' | 'voice';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  keyMaterial?: MediaKeyMaterial; // absent while our own upload is still in flight
  thumbnailBase64?: string;
  durationSeconds?: number;
  uploadProgress?: number; // 0–1, present only while WE are actively uploading this
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function MediaBubble({
  messageId,
  media,
  accessToken,
}: {
  messageId: string;
  media: MediaPayload;
  accessToken: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  async function handleDownload() {
    if (!media.keyMaterial) return;
    setError(null);
    setProgress(0);
    try {
      const url = await downloadAndDecryptMedia(
        messageId,
        { kind: 'media', ...media, keyMaterial: media.keyMaterial },
        accessToken,
        setProgress,
      );
      setObjectUrl(url);
    } catch {
      setError('Download failed.');
    } finally {
      setProgress(null);
    }
  }

  const uploading = media.uploadProgress !== undefined && media.uploadProgress < 1;
  const canDownload = Boolean(media.keyMaterial) && !uploading;

  if (media.mediaType === 'voice') {
    return (
      <div className="flex items-center gap-3 rounded-pill bg-black/5 px-3 py-2">
        <span className="text-lg">{uploading ? '\u23F3' : '\uD83C\uDFA4'}</span>
        {objectUrl ? (
          <audio controls src={objectUrl} className="h-8 max-w-[180px]" />
        ) : (
          <button
            onClick={handleDownload}
            disabled={!canDownload || progress !== null}
            className="text-sm underline disabled:opacity-60"
          >
            {progress !== null ? `${Math.round(progress * 100)}%` : uploading ? 'Uploading\u2026' : 'Play voice message'}
          </button>
        )}
        {media.durationSeconds !== undefined && (
          <span className="text-xs opacity-70">{formatClock(media.durationSeconds)}</span>
        )}
        {error && (
          <button onClick={handleDownload} className="text-xs text-danger underline">
            {error} Retry
          </button>
        )}
      </div>
    );
  }

  if (media.mediaType === 'image') {
    return (
      <div className="relative">
        <img
          src={objectUrl ?? media.thumbnailBase64}
          alt={media.filename}
          onClick={() => !objectUrl && canDownload && handleDownload()}
          className={`max-h-72 w-full rounded-sm object-cover ${!objectUrl && canDownload ? 'cursor-pointer' : ''}`}
        />
        {(uploading || progress !== null) && (
          <div className="absolute inset-0 flex items-center justify-center rounded-sm bg-black/40">
            <span className="text-xs font-medium text-white">
              {Math.round((uploading ? media.uploadProgress! : (progress ?? 0)) * 100)}%
            </span>
          </div>
        )}
        {error && (
          <button onClick={handleDownload} className="mt-1 block text-xs text-danger underline">
            {error} Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-sm bg-black/5 p-3">
      <span className="text-2xl">📄</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{media.filename}</p>
        <p className="text-xs opacity-70">{formatBytes(media.sizeBytes)}</p>
        {uploading && <ProgressBar fraction={media.uploadProgress!} />}
        {progress !== null && <ProgressBar fraction={progress} />}
        {error && (
          <button onClick={handleDownload} className="text-xs text-danger underline">
            {error} Retry
          </button>
        )}
      </div>
      {canDownload && progress === null && (
        <a
          href={objectUrl ?? undefined}
          download={objectUrl ? media.filename : undefined}
          onClick={(e) => {
            if (!objectUrl) {
              e.preventDefault();
              handleDownload();
            }
          }}
          className="shrink-0 rounded-pill bg-coral px-3 py-1 text-xs font-medium text-cream"
        >
          {objectUrl ? 'Save' : 'Download'}
        </a>
      )}
    </div>
  );
}

function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-black/10">
      <div className="h-full bg-coral" style={{ width: `${Math.round(fraction * 100)}%` }} />
    </div>
  );
}
