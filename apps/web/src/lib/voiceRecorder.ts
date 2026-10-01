'use client';

/** Longest single voice message. Recording stops and sends itself at this point, so an
 *  unattended microphone cannot record (and upload) indefinitely. */
export const MAX_RECORDING_SECONDS = 5 * 60;

/** Tried in order. Chromium and Firefox record WebM/Opus; Safari records MP4. Passing an
 *  explicit type that the browser supports avoids relying on whatever its default is. */
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export function voiceRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'
  );
}

/** "0:07", "12:03". */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Turns a getUserMedia / MediaRecorder failure into something a person can act on. */
export function describeRecorderError(err: unknown): string {
  if (!voiceRecordingSupported()) return 'Voice messages are not supported in this browser, or need a secure (HTTPS) connection.';
  // Matched on the error's name rather than `instanceof DOMException`, which is false for an
  // error created in another realm (an iframe, for example).
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return "Access to your microphone was blocked. Allow it in your browser's site settings to record.";
    case 'NotFoundError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
      return 'Your microphone is being used by another application.';
    default:
      return 'Could not start recording.';
  }
}

export interface RecordingResult {
  blob: Blob;
  durationSeconds: number;
}

/** Wrapper around MediaRecorder for voice messages. No transcoding happens: the server
 *  only ever sees ciphertext, so the clip is sent in whatever format the browser recorded. */
export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stream: MediaStream | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private released = false;

  /** When recording began, in epoch milliseconds (0 before `start`). */
  get startedAtMs(): number {
    return this.startedAt;
  }

  /**
   * Starts recording. `onAutoStop` is called if recording has to end by itself (the length
   * limit was reached, or the microphone was unplugged or taken away); the caller should
   * then call `stop()` to collect what was recorded. Rejects, with everything released, if
   * the microphone cannot be opened.
   */
  async start(onAutoStop?: (reason: 'limit' | 'interrupted') => void): Promise<void> {
    if (!voiceRecordingSupported()) throw new Error('unsupported');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;

    try {
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.mediaRecorder = recorder;
      this.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };

      // A microphone that disappears mid-recording ends its tracks without any error.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (!this.released) onAutoStop?.('interrupted');
        };
      });

      recorder.start();
      this.startedAt = Date.now();
      this.limitTimer = setTimeout(() => {
        if (!this.released) onAutoStop?.('limit');
      }, MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      this.cancel();
      throw err;
    }
  }

  /** Stops recording and resolves with the clip. Always releases the microphone. */
  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      const recorder = this.mediaRecorder;
      if (!recorder || this.released) {
        reject(new Error('Not recording'));
        return;
      }
      if (this.limitTimer) clearTimeout(this.limitTimer);
      this.limitTimer = null;

      const finish = () => {
        const elapsed = (Date.now() - this.startedAt) / 1000;
        const durationSeconds = Math.min(elapsed, MAX_RECORDING_SECONDS);
        const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
        this.release();
        if (blob.size === 0) reject(new Error('Nothing was recorded'));
        else resolve({ blob, durationSeconds });
      };

      // If the browser already stopped the recorder (for example the microphone was
      // unplugged), there is no `stop` event to wait for: collect what was captured.
      // The final data event can land just after the track-ended notification, so give it
      // a moment before assembling the clip.
      if (recorder.state === 'inactive') {
        setTimeout(finish, 100);
        return;
      }
      recorder.onstop = finish;
      recorder.onerror = () => {
        this.release();
        reject(new Error('Recording failed'));
      };
      try {
        recorder.stop();
      } catch (err) {
        this.release();
        reject(err);
      }
    });
  }

  /** Discards the recording and releases the microphone. Safe to call at any time, any
   *  number of times, including when nothing is recording. */
  cancel(): void {
    const recorder = this.mediaRecorder;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // already stopping; the tracks are stopped below either way
        }
      }
    }
    this.chunks = [];
    this.release();
  }

  private release(): void {
    this.released = true;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop(); // stopping the tracks is what turns the browser's recording indicator off
    });
    this.stream = null;
    this.mediaRecorder = null;
  }
}
