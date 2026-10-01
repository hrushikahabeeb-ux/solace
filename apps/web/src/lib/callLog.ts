/**
 * Call history entries.
 *
 * When a call ends, the CALLER's client posts one end-to-end encrypted `call` message into
 * the conversation (see CallProvider.registerCallLogger). Posting from exactly one side is
 * what makes each call appear exactly once. The server sees an ordinary encrypted message:
 * it cannot tell a call entry from text.
 *
 * The entry records what happened from the caller's point of view; this module words it for
 * whichever participant is reading.
 */

export type CallLogMedia = 'audio' | 'video';
export type CallLogOutcome = 'completed' | 'missed' | 'declined' | 'failed';

export interface CallLogInfo {
  media: CallLogMedia;
  outcome: CallLogOutcome;
  durationSeconds?: number;
}

/** "45s", "2m 5s", "1h 2m". */
export function formatCallDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/** The sentence shown for a call entry. `mine` is true when the reader placed the call. */
export function describeCallLog(mine: boolean, info: CallLogInfo): string {
  const noun = info.media === 'video' ? 'video call' : 'voice call';
  const title = info.media === 'video' ? 'Video call' : 'Voice call';

  switch (info.outcome) {
    case 'completed': {
      const base = `${mine ? 'Outgoing' : 'Incoming'} ${noun}`;
      return info.durationSeconds !== undefined && info.durationSeconds > 0
        ? `${base} \u00b7 ${formatCallDuration(info.durationSeconds)}`
        : base;
    }
    case 'missed':
      return mine ? `${title} \u00b7 no answer` : `Missed ${noun}`;
    case 'declined':
      return mine ? `${title} declined` : `You declined a ${noun}`;
    case 'failed':
      return `${title} could not connect`;
  }
}
