'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CallActions, CallUiState } from './CallProvider';
import { MicIcon, MicOffIcon, PhoneHangupIcon, PhoneIcon, SwitchCameraIcon, VideoIcon, VideoOffIcon } from './callIcons';

/**
 * The visible half of calling. CallProvider owns every piece of call state and behavior;
 * this component only renders it and forwards button presses to `actions`. It holds no call
 * logic of its own, so nothing here can put a call into a state the provider did not choose.
 */

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Seconds since `startedAt`, re-rendering once per second. Zero while there is no start. */
function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** True only when the device reports more than one camera, so the switch button is not
 *  offered on a laptop where it could only ever fail. Labels and ids are only exposed once
 *  camera permission exists, hence this runs only while the camera is on. */
function useHasMultipleCameras(enabled: boolean): boolean {
  const [multiple, setMultiple] = useState(false);
  useEffect(() => {
    const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!enabled || !devices?.enumerateDevices) {
      setMultiple(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const list = await devices.enumerateDevices();
        if (!cancelled) setMultiple(list.filter((device) => device.kind === 'videoinput').length > 1);
      } catch {
        if (!cancelled) setMultiple(false);
      }
    };
    void check();
    devices.addEventListener?.('devicechange', check);
    return () => {
      cancelled = true;
      devices.removeEventListener?.('devicechange', check);
    };
  }, [enabled]);
  return enabled && multiple;
}

/** A <video> element that owns the binding of a MediaStream to itself. Because the element
 *  and the effect share a lifetime, a stream is attached whenever the element appears, not
 *  only when the stream object changes. */
function StreamVideo({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    // A refused autoplay is not actionable here: the user has already interacted with the
    // page to place or answer the call, and a later track arrival retries this.
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

function RoundButton({
  label,
  onClick,
  tone = 'neutral',
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'neutral' | 'off' | 'danger' | 'accept';
  /** Set for toggles, so assistive technology announces the current state. */
  pressed?: boolean;
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-canvas-alt text-ink-canvas hover:bg-lavender-deep',
    off: 'bg-cream text-canvas hover:bg-card-alt',
    danger: 'bg-danger text-cream hover:opacity-90',
    accept: 'bg-success text-canvas hover:opacity-90',
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`flex h-14 w-14 items-center justify-center rounded-pill shadow-soft transition ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

function Avatar({ name, pulsing }: { name: string; pulsing?: boolean }) {
  return (
    <span
      className={`flex h-24 w-24 items-center justify-center rounded-pill bg-lavender font-display text-4xl text-canvas ${
        pulsing ? 'animate-pulse' : ''
      }`}
    >
      {name.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

function statusText(state: CallUiState, elapsedSeconds: number): string {
  switch (state.phase) {
    case 'starting':
      return 'Starting\u2026';
    case 'outgoing':
      return state.ringing ? 'Ringing\u2026' : 'Calling\u2026';
    case 'connecting':
      return 'Connecting\u2026';
    case 'active':
      return state.connection === 'reconnecting' ? 'Reconnecting\u2026' : formatElapsed(elapsedSeconds);
    default:
      return '';
  }
}

function IncomingCall({ state, actions }: { state: CallUiState; actions: CallActions }) {
  const isVideo = state.media === 'video';
  return (
    <div
      role="alertdialog"
      aria-labelledby="incoming-call-title"
      className="fixed inset-x-4 top-4 z-[100] rounded-lg bg-card p-5 text-ink-card shadow-card sm:left-auto sm:right-4 sm:w-96"
    >
      <div className="flex items-center gap-4">
        <span className="flex h-12 w-12 flex-none items-center justify-center rounded-pill bg-lavender font-display text-xl text-canvas">
          {state.peerName.trim()[0]?.toUpperCase() ?? '?'}
        </span>
        <div className="min-w-0 flex-1">
          <p id="incoming-call-title" className="truncate font-display text-lg">
            {state.peerName}
          </p>
          <p className="text-xs text-ink-card-muted">
            Incoming {isVideo ? 'video' : 'voice'} call &middot; end-to-end encrypted
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {isVideo && (
          <button
            type="button"
            onClick={() => actions.accept('audio')}
            className="mr-auto text-xs text-ink-card-muted underline hover:text-ink-card"
          >
            Answer with audio only
          </button>
        )}
        <RoundButton label="Decline call" tone="danger" onClick={actions.decline}>
          <PhoneHangupIcon className="h-6 w-6" />
        </RoundButton>
        <RoundButton label="Accept call" tone="accept" onClick={() => actions.accept()}>
          {isVideo ? <VideoIcon className="h-6 w-6" /> : <PhoneIcon className="h-6 w-6" />}
        </RoundButton>
      </div>
    </div>
  );
}

function ActiveCall({ state, actions }: { state: CallUiState; actions: CallActions }) {
  const elapsed = useElapsedSeconds(state.phase === 'active' ? state.connectedAt : null);
  const multipleCameras = useHasMultipleCameras(state.cameraOn);

  const showRemoteVideo = state.remote.video && state.remoteStream !== null;
  const showSelfView = state.cameraOn && state.localVideoStream !== null;
  const remoteMuted = state.phase === 'active' && !state.remote.audio;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${state.media === 'video' ? 'Video' : 'Voice'} call with ${state.peerName}`}
      className="fixed inset-0 z-[100] flex flex-col bg-canvas text-ink-canvas"
    >
      <div className="relative flex-1 overflow-hidden">
        {/* This single element plays the remote audio in every call. For a voice call it is
            kept mounted but invisible rather than removed: removing it would silence the
            call, and `display: none` media is not reliably played on every browser. */}
        <StreamVideo
          stream={state.remoteStream}
          className={showRemoteVideo ? 'absolute inset-0 h-full w-full object-cover' : 'pointer-events-none absolute h-px w-px opacity-0'}
        />

        {!showRemoteVideo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <Avatar name={state.peerName} pulsing={state.phase === 'outgoing' || state.phase === 'connecting'} />
            <p className="font-display text-2xl">{state.peerName}</p>
            <p className="text-sm text-ink-canvas-muted" aria-live="polite">
              {statusText(state, elapsed)}
            </p>
            {state.phase === 'active' && state.media === 'video' && !state.remote.video && (
              <p className="text-xs text-ink-canvas-muted">Their camera is off</p>
            )}
          </div>
        )}

        {showRemoteVideo && (
          <div className="absolute left-4 top-4 rounded-pill bg-black/50 px-3 py-1.5 text-sm text-white">
            <span className="font-medium">{state.peerName}</span>
            <span className="ml-2 opacity-80" aria-live="polite">
              {statusText(state, elapsed)}
            </span>
          </div>
        )}

        {remoteMuted && (
          <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-pill bg-black/50 px-3 py-1.5 text-xs text-white">
            {state.peerName} is muted
          </div>
        )}

        {showSelfView && (
          <div className="absolute bottom-4 right-4 h-40 w-28 overflow-hidden rounded-md bg-canvas-alt shadow-card sm:h-44 sm:w-32">
            <StreamVideo stream={state.localVideoStream} muted className="h-full w-full -scale-x-100 object-cover" />
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-4 px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4">
        {state.canControl && (
          <>
            <RoundButton
              label={state.micOn ? 'Mute microphone' : 'Unmute microphone'}
              tone={state.micOn ? 'neutral' : 'off'}
              pressed={!state.micOn}
              onClick={actions.toggleMute}
            >
              {state.micOn ? <MicIcon className="h-6 w-6" /> : <MicOffIcon className="h-6 w-6" />}
            </RoundButton>
            <RoundButton
              label={state.cameraOn ? 'Turn camera off' : 'Turn camera on'}
              tone={state.cameraOn ? 'neutral' : 'off'}
              pressed={!state.cameraOn}
              onClick={actions.toggleCamera}
            >
              {state.cameraOn ? <VideoIcon className="h-6 w-6" /> : <VideoOffIcon className="h-6 w-6" />}
            </RoundButton>
            {multipleCameras && (
              <RoundButton label="Switch camera" onClick={actions.switchCamera}>
                <SwitchCameraIcon className="h-6 w-6" />
              </RoundButton>
            )}
          </>
        )}
        <RoundButton label="End call" tone="danger" onClick={actions.end}>
          <PhoneHangupIcon className="h-6 w-6" />
        </RoundButton>
      </div>
    </div>
  );
}

export function CallOverlay({ state, actions }: { state: CallUiState; actions: CallActions }) {
  const inCallScreen =
    state.phase === 'starting' || state.phase === 'outgoing' || state.phase === 'connecting' || state.phase === 'active';

  return (
    <>
      {state.phase === 'incoming' && <IncomingCall state={state} actions={actions} />}
      {inCallScreen && <ActiveCall state={state} actions={actions} />}
      {state.notice && (
        <div
          role="status"
          className={`fixed left-1/2 z-[110] max-w-[90vw] -translate-x-1/2 rounded-pill bg-card px-4 py-2 text-sm text-ink-card shadow-card ${
            inCallScreen ? 'bottom-32' : 'bottom-6'
          }`}
        >
          {state.notice}
        </div>
      )}
    </>
  );
}
