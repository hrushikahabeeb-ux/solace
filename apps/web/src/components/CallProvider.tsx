'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../lib/authSession';
import { api } from '../lib/api';
import { decryptMessage, encryptForConversation } from '../lib/e2ee';
import { CallSignaling } from '../lib/callSignaling';
import {
  CallSession,
  acquireLocalTracks,
  describeMediaError,
  mediaDevicesAvailable,
  type LocalTracks,
  type SessionConnection,
} from '../lib/callSession';
import {
  decodeSignal,
  encodeSignal,
  newId,
  type CallEndReason,
  type CallMedia,
  type CallRejectReason,
  type CallServerEvent,
  type SignalMessage,
} from '../lib/callProtocol';
import { playEndTone, startRingback, startRingtone } from '../lib/callTones';
import { CallOverlay } from './CallOverlay';

// ---------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------

export type CallPhase = 'idle' | 'starting' | 'outgoing' | 'incoming' | 'connecting' | 'active';
export type CallOutcome = 'completed' | 'missed' | 'declined' | 'failed';

export interface CallUiState {
  phase: CallPhase;
  media: CallMedia;
  direction: 'outgoing' | 'incoming' | null;
  peerName: string;
  /** Outgoing: the server has confirmed the other side's devices are ringing. */
  ringing: boolean;
  connection: SessionConnection;
  connectedAt: number | null;
  /** True once a WebRTC session exists, i.e. mic/camera controls have something to act on. */
  canControl: boolean;
  micOn: boolean;
  cameraOn: boolean;
  remote: { audio: boolean; video: boolean };
  localVideoStream: MediaStream | null;
  remoteStream: MediaStream | null;
  notice: string | null;
}

export interface CallLogEntry {
  conversationId: string;
  media: CallMedia;
  outcome: CallOutcome;
  durationSeconds?: number;
}

export interface CallActions {
  accept(mode?: CallMedia): void;
  decline(): void;
  end(): void;
  toggleMute(): void;
  toggleCamera(): void;
  switchCamera(): void;
}

interface CallContextValue {
  state: CallUiState;
  /** False while the signaling connection is down; starting a call is not possible then. */
  signalingReady: boolean;
  startCall(args: { conversationId: string; peer: { id: string; displayName: string }; media: CallMedia }): Promise<void>;
  actions: CallActions;
  /** Registers the function that records a finished call in the chat. Only the CALLER's
   *  client reports a call, so each call appears in the thread exactly once. */
  registerCallLogger(logger: (entry: CallLogEntry) => void): () => void;
}

const IDLE: CallUiState = {
  phase: 'idle',
  media: 'audio',
  direction: null,
  peerName: '',
  ringing: false,
  connection: 'connecting',
  connectedAt: null,
  canControl: false,
  micOn: true,
  cameraOn: false,
  remote: { audio: true, video: false },
  localVideoStream: null,
  remoteStream: null,
  notice: null,
};

// If the server's own ring timer (45s) or our socket fails, this is the client's backstop.
const OUTGOING_RING_LIMIT_MS = 55_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const NOTICE_MS = 5_000;

/** Used only if the ICE endpoint is unreachable, so a call can still be attempted. */
const FALLBACK_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// ---------------------------------------------------------------------------------------
// Internal (non-React) record of the one call this tab can have at a time
// ---------------------------------------------------------------------------------------

interface ActiveCall {
  callId: string;
  conversationId: string;
  peerId: string;
  peerName: string;
  media: CallMedia;
  direction: 'outgoing' | 'incoming';
  phase: CallPhase;
  session: CallSession | null;
  /** Microphone/camera acquired but not yet handed to a session (outgoing, until answered). */
  pendingTracks: LocalTracks | null;
  iceServers: RTCIceServer[];
  connectedAt: number | null;
  finished: boolean;
  inbox: Promise<void>;
  outbox: Promise<void>;
  ringTimeout: ReturnType<typeof setTimeout> | null;
  keepalive: ReturnType<typeof setInterval> | null;
  stopTone: (() => void) | null;
}

function outcomeFor(call: ActiveCall, reason: CallEndReason | 'failed'): CallOutcome {
  if (reason === 'declined') return 'declined';
  if (reason === 'failed') return 'failed';
  if (call.connectedAt) return 'completed';
  // Answered but media never flowed, versus never answered at all.
  return reason === 'hangup' ? 'failed' : 'missed';
}

function rejectionNotice(reason: CallRejectReason, peerName: string): string {
  switch (reason) {
    case 'busy':
      return `${peerName} is on another call.`;
    case 'self_busy':
      return 'You are already in a call.';
    case 'unavailable':
      return `${peerName} is unavailable right now.`;
    case 'rate_limited':
      return 'Too many call attempts. Try again in a minute.';
    case 'not_allowed':
    default:
      return 'This call could not be placed.';
  }
}

function endNotice(reason: CallEndReason, call: ActiveCall): string | null {
  const incoming = call.direction === 'incoming';
  switch (reason) {
    case 'declined':
      return incoming ? null : 'Call declined.';
    case 'missed':
      return incoming ? `Missed call from ${call.peerName}.` : 'No answer.';
    case 'cancelled':
      return incoming ? `Missed call from ${call.peerName}.` : null;
    case 'hangup':
    default:
      return 'Call ended.';
  }
}

function stopTracks(tracks: LocalTracks | null): void {
  tracks?.audioTrack.stop();
  tracks?.videoTrack?.stop();
}

// ---------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const { user, accessToken, e2ee } = useAuth();

  const [state, setState] = useState<CallUiState>(IDLE);
  const [signalingReady, setSignalingReady] = useState(false);

  const callRef = useRef<ActiveCall | null>(null);
  const signalingRef = useRef<CallSignaling | null>(null);
  const loggerRef = useRef<((entry: CallLogEntry) => void) | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Handlers are created once and read the latest auth values through this ref, so they
  // never go stale and the signaling connection is never rebuilt because a token refreshed.
  const live = useRef({ userId: user?.id ?? null, accessToken, e2ee });
  live.current = { userId: user?.id ?? null, accessToken, e2ee };

  const patch = useCallback((changes: Partial<CallUiState>) => {
    setState((previous) => ({ ...previous, ...changes }));
  }, []);

  const showNotice = useCallback((notice: string | null) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = null;
    setState((previous) => ({ ...previous, notice }));
    if (notice) {
      noticeTimerRef.current = setTimeout(() => setState((previous) => ({ ...previous, notice: null })), NOTICE_MS);
    }
  }, []);

  /** The single place a call is torn down. Idempotent, so the several ways a call can end
   *  (hang up, remote hang up, failure, sign-out) can never double-report or double-free. */
  const finishCall = useCallback(
    (options: {
      notice?: string | null;
      outcome?: CallOutcome;
      sendEnd?: boolean;
      tone?: boolean;
    }) => {
      const call = callRef.current;
      if (!call || call.finished) return;
      call.finished = true;
      callRef.current = null;

      call.stopTone?.();
      if (call.ringTimeout) clearTimeout(call.ringTimeout);
      if (call.keepalive) clearInterval(call.keepalive);
      call.session?.close();
      stopTracks(call.pendingTracks);

      if (options.sendEnd) signalingRef.current?.send({ type: 'call.end', callId: call.callId });

      if (options.outcome && call.direction === 'outgoing') {
        loggerRef.current?.({
          conversationId: call.conversationId,
          media: call.media,
          outcome: options.outcome,
          durationSeconds: call.connectedAt ? Math.max(0, Math.round((Date.now() - call.connectedAt) / 1000)) : undefined,
        });
      }

      if (options.tone) playEndTone();
      setState({ ...IDLE, notice: options.notice ?? null });
      showNotice(options.notice ?? null);
    },
    [showNotice],
  );

  /** Encrypts a signal for the peer and relays it. Sends are chained so they leave in the
   *  order they were produced even though encryption is asynchronous. */
  const sendSignal = useCallback(
    (call: ActiveCall, message: SignalMessage) => {
      call.outbox = call.outbox
        .then(async () => {
          if (call.finished) return;
          const { e2ee: engine } = live.current;
          const signaling = signalingRef.current;
          if (!engine || !signaling) return;
          const { ciphertext } = await encryptForConversation(engine, {
            conversationId: call.conversationId,
            memberUserIds: [call.peerId],
            plaintext: encodeSignal(call.callId, message),
          });
          signaling.send({ type: 'call.signal', callId: call.callId, payload: ciphertext });
        })
        .catch(() => {
          // Losing an ICE candidate or a mute notice is survivable. Losing the offer or the
          // answer is not: the call cannot be set up without them.
          if (message.t === 'offer' || message.t === 'answer') {
            finishCall({
              notice: 'Could not set up a secure connection for this call.',
              outcome: 'failed',
              sendEnd: true,
              tone: true,
            });
          }
        });
    },
    [finishCall],
  );

  const createSession = useCallback(
    (call: ActiveCall, role: 'caller' | 'callee', tracks: LocalTracks): CallSession => {
      const session = new CallSession({
        role,
        iceServers: call.iceServers,
        tracks,
        sendSignal: (message) => sendSignal(call, message),
        onRemoteStream: (stream) => {
          if (callRef.current !== call) return;
          // A fresh MediaStream object each time makes the <video> element rebind, which is
          // what reliably picks up a track (for example remote video) that arrives late.
          patch({ remoteStream: new MediaStream(stream.getTracks()) });
        },
        onRemoteMediaState: (flags) => {
          if (callRef.current === call) patch({ remote: flags });
        },
        onConnectionChange: (connection) => {
          if (callRef.current !== call) return;
          if (connection === 'connected') {
            call.stopTone?.();
            call.stopTone = null;
            call.connectedAt ??= Date.now();
            call.phase = 'active';
            patch({ phase: 'active', connection, connectedAt: call.connectedAt, ringing: false });
          } else if (connection === 'failed') {
            finishCall({
              notice: call.connectedAt ? 'The call lost its connection.' : 'Could not connect the call.',
              outcome: 'failed',
              sendEnd: true,
              tone: true,
            });
          } else {
            patch({ connection });
          }
        },
      });

      call.keepalive = setInterval(() => {
        signalingRef.current?.send({ type: 'call.keepalive', callId: call.callId });
      }, KEEPALIVE_INTERVAL_MS);

      return session;
    },
    [finishCall, patch, sendSignal],
  );

  // -------------------------------------------------------------------------------------
  // Incoming server events
  // -------------------------------------------------------------------------------------

  const handleServerEvent = useCallback(
    (event: CallServerEvent) => {
      const call = callRef.current;

      switch (event.type) {
        case 'call.incoming': {
          if (call) return; // the server already reports us busy; defensive
          const incoming: ActiveCall = {
            callId: event.callId,
            conversationId: event.conversationId,
            peerId: event.from.id,
            peerName: event.from.displayName,
            media: event.media,
            direction: 'incoming',
            phase: 'incoming',
            session: null,
            pendingTracks: null,
            iceServers: FALLBACK_ICE,
            connectedAt: null,
            finished: false,
            inbox: Promise.resolve(),
            outbox: Promise.resolve(),
            ringTimeout: null,
            keepalive: null,
            stopTone: startRingtone(),
          };
          callRef.current = incoming;
          setState({
            ...IDLE,
            phase: 'incoming',
            media: event.media,
            direction: 'incoming',
            peerName: event.from.displayName,
            remote: { audio: true, video: event.media === 'video' },
          });
          return;
        }

        case 'call.ringing': {
          if (!call || call.callId !== event.callId || call.direction !== 'outgoing' || call.session) return;
          call.stopTone?.();
          call.stopTone = startRingback();
          patch({ ringing: true });
          return;
        }

        case 'call.rejected': {
          if (!call || call.callId !== event.callId) return;
          finishCall({ notice: rejectionNotice(event.reason, call.peerName) });
          return;
        }

        case 'call.accepted': {
          if (!call || call.callId !== event.callId) return;

          if (call.direction === 'incoming') {
            // We are told about every accept for this call. If it was not ours, another of
            // our devices answered: stop ringing, quietly.
            if (event.by !== signalingRef.current?.clientId) finishCall({});
            return;
          }

          // Outgoing: the callee answered, so start negotiating.
          if (call.session || !call.pendingTracks) return;
          call.stopTone?.();
          call.stopTone = null;
          if (call.ringTimeout) clearTimeout(call.ringTimeout);
          call.ringTimeout = null;

          const tracks = call.pendingTracks;
          call.pendingTracks = null;
          call.phase = 'connecting';
          call.session = createSession(call, 'caller', tracks);
          patch({ phase: 'connecting', ringing: false, canControl: true });
          void call.session.startOffer();
          return;
        }

        case 'call.signal': {
          if (!call || call.callId !== event.callId || event.from !== call.peerId) return;
          // Strictly one at a time and in arrival order, because decryption is async.
          call.inbox = call.inbox
            .then(async () => {
              const session = call.session;
              const engine = live.current.e2ee;
              if (!session || !engine || call.finished) return;
              const result = await decryptMessage(engine, {
                conversationId: call.conversationId,
                ciphertext: event.payload,
                senderUserId: event.from,
              });
              // Anything that does not verify as coming from the peer's own device is dropped.
              if (!result.ok) return;
              const message = decodeSignal(result.plaintext, call.callId);
              if (message) await session.handleSignal(message);
            })
            // A rejected promise would stay rejected and skip every later `.then`, silently
            // ending all signaling for this call. One bad message must not do that.
            .catch(() => undefined);
          return;
        }

        case 'call.ended': {
          if (!call || call.callId !== event.callId) return;
          const wasLive = call.phase === 'connecting' || call.phase === 'active';
          finishCall({
            notice: endNotice(event.reason, call),
            outcome: outcomeFor(call, event.reason),
            tone: wasLive,
          });
          return;
        }
      }
    },
    [createSession, finishCall, patch],
  );

  // -------------------------------------------------------------------------------------
  // Signaling lifecycle: lives exactly as long as the user is signed in
  // -------------------------------------------------------------------------------------

  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;

    const signaling = new CallSignaling(() => live.current.accessToken);
    signalingRef.current = signaling;
    const offEvent = signaling.onEvent(handleServerEvent);
    const offStatus = signaling.onStatus(setSignalingReady);
    signaling.connect();

    // Closing the tab mid-call should not leave the other person waiting on a dead call.
    // A ringing call is left alone: another tab of ours may still answer it.
    const onPageHide = () => {
      const call = callRef.current;
      if (call && !call.finished && call.phase !== 'incoming') {
        signaling.send({ type: 'call.end', callId: call.callId });
      }
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      offEvent();
      offStatus();
      finishCall({ sendEnd: true });
      signaling.disconnect();
      signalingRef.current = null;
      setSignalingReady(false);
    };
  }, [userId, handleServerEvent, finishCall]);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // -------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------

  const startCall = useCallback<CallContextValue['startCall']>(
    async ({ conversationId, peer, media }) => {
      const { accessToken: token, e2ee: engine } = live.current;
      const signaling = signalingRef.current;
      if (callRef.current) return;
      if (!token || !engine || !signaling) return;

      if (!mediaDevicesAvailable()) {
        showNotice('Calls need a secure (HTTPS) connection and a browser that supports them.');
        return;
      }
      if (!signaling.isOpen()) {
        showNotice('Cannot reach the call service. Check your connection and try again.');
        return;
      }

      const call: ActiveCall = {
        callId: newId(),
        conversationId,
        peerId: peer.id,
        peerName: peer.displayName,
        media,
        direction: 'outgoing',
        phase: 'starting',
        session: null,
        pendingTracks: null,
        iceServers: FALLBACK_ICE,
        connectedAt: null,
        finished: false,
        inbox: Promise.resolve(),
        outbox: Promise.resolve(),
        ringTimeout: null,
        keepalive: null,
        stopTone: null,
      };
      // Claim the slot synchronously so a double-click cannot start two calls.
      callRef.current = call;
      setState({ ...IDLE, phase: 'starting', media, direction: 'outgoing', peerName: peer.displayName });

      let tracks: LocalTracks;
      try {
        tracks = await acquireLocalTracks(media);
      } catch (err) {
        if (callRef.current === call) finishCall({ notice: describeMediaError(err, media === 'video') });
        return;
      }
      if (callRef.current !== call) {
        stopTracks(tracks); // cancelled while the permission prompt was open
        return;
      }
      call.pendingTracks = tracks;

      try {
        const { iceServers } = await api.getIceServers(token);
        call.iceServers = iceServers;
      } catch {
        // Keep the fallback: better to try a call than to refuse over a config lookup.
      }
      if (callRef.current !== call) {
        stopTracks(tracks);
        return;
      }

      const sent = signaling.send({
        type: 'call.invite',
        callId: call.callId,
        conversationId,
        media,
        clientId: signaling.clientId,
      });
      if (!sent) {
        finishCall({ notice: 'Lost the connection to the call service. Try again.' });
        return;
      }

      call.phase = 'outgoing';
      call.ringTimeout = setTimeout(() => {
        finishCall({ notice: 'No answer.', outcome: 'missed', sendEnd: true });
      }, OUTGOING_RING_LIMIT_MS);
      patch({
        phase: 'outgoing',
        cameraOn: Boolean(tracks.videoTrack),
        localVideoStream: tracks.videoTrack ? new MediaStream([tracks.videoTrack]) : null,
      });
      if (tracks.videoUnavailable) showNotice('Camera unavailable. Calling with audio only.');
    },
    [finishCall, patch, showNotice],
  );

  const accept = useCallback(
    (mode?: CallMedia) => {
      const call = callRef.current;
      const signaling = signalingRef.current;
      if (!call || call.direction !== 'incoming' || call.phase !== 'incoming' || !signaling) return;

      // From here the ringing UI is replaced by the "connecting" one, and the ringtone stops.
      call.stopTone?.();
      call.stopTone = null;
      call.phase = 'connecting';
      patch({ phase: 'connecting' });

      void (async () => {
        const wanted: CallMedia = mode ?? call.media;
        let tracks: LocalTracks;
        try {
          tracks = await acquireLocalTracks(wanted);
        } catch (err) {
          if (callRef.current === call) {
            signaling.send({ type: 'call.decline', callId: call.callId });
            finishCall({ notice: describeMediaError(err, wanted === 'video') });
          }
          return;
        }
        // The call may have ended, or been answered elsewhere, while the permission prompt was up.
        if (callRef.current !== call) {
          stopTracks(tracks);
          return;
        }

        try {
          const token = live.current.accessToken;
          if (token) call.iceServers = (await api.getIceServers(token)).iceServers;
        } catch {
          // fall back to the default
        }
        if (callRef.current !== call) {
          stopTracks(tracks);
          return;
        }

        // The session must exist BEFORE we tell the caller we answered, because the caller
        // sends its offer the moment it hears that.
        call.session = createSession(call, 'callee', tracks);
        patch({
          canControl: true,
          cameraOn: Boolean(tracks.videoTrack),
          localVideoStream: tracks.videoTrack ? new MediaStream([tracks.videoTrack]) : null,
        });
        if (tracks.videoUnavailable) showNotice('Camera unavailable. Joining with audio only.');

        const sent = signaling.send({ type: 'call.accept', callId: call.callId, clientId: signaling.clientId });
        if (!sent) finishCall({ notice: 'Lost the connection to the call service. Try again.' });
      })();
    },
    [createSession, finishCall, patch, showNotice],
  );

  const decline = useCallback(() => {
    const call = callRef.current;
    if (!call || call.direction !== 'incoming') return;
    signalingRef.current?.send({ type: 'call.decline', callId: call.callId });
    finishCall({});
  }, [finishCall]);

  const end = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const inviteSent = call.phase !== 'starting';
    const ringing = call.phase === 'outgoing';
    const wasLive = call.phase === 'connecting' || call.phase === 'active';
    // Nothing was ever sent while we were still waiting on the permission prompt, so there
    // is nothing to end and nothing to log. A call cancelled while ringing, however, is a
    // missed call for the other person.
    finishCall({
      sendEnd: inviteSent,
      outcome: !inviteSent ? undefined : ringing ? 'missed' : outcomeFor(call, 'hangup'),
      tone: wasLive,
    });
  }, [finishCall]);

  const toggleMute = useCallback(() => {
    const session = callRef.current?.session;
    if (!session) return;
    session.setMicEnabled(!session.micEnabled);
    patch({ micOn: session.micEnabled });
  }, [patch]);

  const toggleCamera = useCallback(() => {
    const session = callRef.current?.session;
    if (!session) return;
    void session
      .setCameraEnabled(!session.cameraEnabled)
      .then(() => patch({ cameraOn: session.cameraEnabled, localVideoStream: session.localVideoStream() }))
      .catch((err) => showNotice(describeMediaError(err, true)));
  }, [patch, showNotice]);

  const switchCamera = useCallback(() => {
    const session = callRef.current?.session;
    if (!session) return;
    void session
      .switchCamera()
      .then(() => patch({ localVideoStream: session.localVideoStream() }))
      .catch(() => {
        patch({ cameraOn: session.cameraEnabled, localVideoStream: session.localVideoStream() });
        showNotice('Could not switch cameras.');
      });
  }, [patch, showNotice]);

  const registerCallLogger = useCallback((logger: (entry: CallLogEntry) => void) => {
    loggerRef.current = logger;
    return () => {
      if (loggerRef.current === logger) loggerRef.current = null;
    };
  }, []);

  const actions = useMemo<CallActions>(
    () => ({ accept, decline, end, toggleMute, toggleCamera, switchCamera }),
    [accept, decline, end, toggleMute, toggleCamera, switchCamera],
  );

  const value = useMemo<CallContextValue>(
    () => ({ state, signalingReady, startCall, actions, registerCallLogger }),
    [state, signalingReady, startCall, actions, registerCallLogger],
  );

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallOverlay state={state} actions={actions} />
    </CallContext.Provider>
  );
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used within a CallProvider');
  return ctx;
}
