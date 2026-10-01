'use client';

/**
 * Draft sync — LOCAL ONLY, deliberately. True cross-device draft sync would need the
 * draft text to travel to your other devices somehow, and this project's architecture
 * has no mechanism for that: each device has its own independent encryption identity with no
 * device-linking/key-backup system built (see ARCHITECTURE.md). The honest options
 * were: (a) store drafts in plaintext server-side, which is a real confidentiality
 * regression the rest of this app goes out of its way to avoid, or (b) keep drafts
 * local to the device that's typing them. This picks (b).
 */
const KEY_PREFIX = 'solace:draft:';

export function saveDraft(conversationId: string, text: string): void {
  try {
    if (text) localStorage.setItem(KEY_PREFIX + conversationId, text);
    else localStorage.removeItem(KEY_PREFIX + conversationId);
  } catch {
    // non-fatal
  }
}

export function loadDraft(conversationId: string): string {
  return localStorage.getItem(KEY_PREFIX + conversationId) ?? '';
}
