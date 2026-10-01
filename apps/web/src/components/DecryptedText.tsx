'use client';

import { useEffect, useState } from 'react';
import { decryptWorkspaceField, type E2EEEngine } from '../lib/e2ee';

type FieldState = { status: 'pending' } | { status: 'ok'; text: string } | { status: 'failed' };

/** Decrypts one workspace-content field (a task title, event name, note body, etc.)
 *  on mount. Reused everywhere workspace content is displayed, so every task/event/
 *  note/folder name in the app decrypts through the exact same path. Decryption is
 *  stateless, so re-running it (re-render, remount, reopening a tab) is always safe. */
export function DecryptedText({
  ciphertext,
  sessionRef,
  e2ee,
  className,
  fallback = '\uD83D\uDD12 Decrypting\u2026',
  failedText = '\uD83D\uDD12 Not available on this device',
}: {
  ciphertext: string;
  sessionRef: string;
  e2ee: E2EEEngine | null;
  className?: string;
  fallback?: string;
  failedText?: string;
}) {
  const [state, setState] = useState<FieldState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'pending' });
    if (!e2ee) return;
    decryptWorkspaceField(ciphertext, sessionRef, e2ee)
      .then((result) => {
        if (!cancelled) setState(result === null ? { status: 'failed' } : { status: 'ok', text: result });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [ciphertext, sessionRef, e2ee]);

  const text = state.status === 'ok' ? state.text : state.status === 'failed' ? failedText : fallback;
  return <span className={className}>{text}</span>;
}
