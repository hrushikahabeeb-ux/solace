'use client';

import type { CallMedia, SignalMessage } from './callProtocol';

export type SessionConnection = 'connecting' | 'connected' | 'reconnecting' | 'failed';
export interface MediaFlags {
  audio: boolean;
  video: boolean;
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function videoConstraints(facingMode: 'user' | 'environment'): MediaTrackConstraints {
  return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode };
}

// Timings. Media can outlive brief network changes, so a "disconnected" state is given a
// grace period before it is treated as a failure.
const ICE_BATCH_MS = 80;
const CONNECT_TIMEOUT_MS = 30_000;
const DISCONNECT_GRACE_MS = 6_000;
const RESTART_TIMEOUT_MS = 15_000;
const MAX_ICE_RESTARTS = 3;

export interface LocalTracks {
  audioTrack: MediaStreamTrack;
  videoTrack: MediaStreamTrack | null;
  /** Set when video was requested but had to be dropped (no camera, camera busy). */
  videoUnavailable: boolean;
}

/** Errors worth translating into something a person can act on. */
export function describeMediaError(err: unknown, wantedVideo: boolean): string {
  const name = err instanceof DOMException ? err.name : '';
  const device = wantedVideo ? 'microphone or camera' : 'microphone';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Access to your ${device} was blocked. Allow it in your browser's site settings to make calls.`;
    case 'NotFoundError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
      return `Your ${device} is being used by another application.`;
    default:
      return `Could not start your ${device}.`;
  }
}

export function mediaDevicesAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof RTCPeerConnection !== 'undefined';
}

/**
 * Asks for the microphone (and camera for video calls). A video call whose camera cannot
 * be opened for a reason other than the user refusing degrades to an audio call rather
 * than failing outright. A refusal is respected and reported.
 */
export async function acquireLocalTracks(media: CallMedia): Promise<LocalTracks> {
  const wantsVideo = media === 'video';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: wantsVideo ? videoConstraints('user') : false,
    });
    return {
      audioTrack: stream.getAudioTracks()[0],
      videoTrack: stream.getVideoTracks()[0] ?? null,
      videoUnavailable: false,
    };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    const isRefusal = name === 'NotAllowedError' || name === 'SecurityError';
    if (!wantsVideo || isRefusal) throw err;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
    return { audioTrack: stream.getAudioTracks()[0], videoTrack: null, videoUnavailable: true };
  }
}

export interface CallSessionOptions {
  role: 'caller' | 'callee';
  iceServers: RTCIceServer[];
  tracks: LocalTracks;
  /** Hands a signal to the transport, which encrypts and relays it. */
  sendSignal(msg: SignalMessage): void;
  onRemoteStream(stream: MediaStream): void;
  onConnectionChange(state: SessionConnection): void;
  onRemoteMediaState(flags: MediaFlags): void;
}

/**
 * One peer-to-peer call.
 *
 * Both an audio and a video transceiver are negotiated up front, in every call, whatever it
 * started as. Turning the camera on or off later is then just `replaceTrack` on a sender
 * that already exists, which needs no renegotiation. That removes the whole class of
 * mid-call offer/answer "glare" problems: the ONLY offers ever made are the initial one
 * and ICE restarts, and only the caller makes either.
 *
 * The session knows nothing about encryption, the server or React; it is handed a
 * `sendSignal` callback and feeds incoming signals to `handleSignal`.
 */
export class CallSession {
  private readonly pc: RTCPeerConnection;
  private readonly remoteStream = new MediaStream();

  private audioTrack: MediaStreamTrack;
  private videoTrack: MediaStreamTrack | null;
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  private facingMode: 'user' | 'environment' = 'user';

  private queue: Promise<void> = Promise.resolve();
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private outgoingCandidates: RTCIceCandidateInit[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;
  private tracksAttached = false;
  private everConnected = false;
  private closed = false;

  constructor(private readonly opts: CallSessionOptions) {
    this.audioTrack = opts.tracks.audioTrack;
    this.videoTrack = opts.tracks.videoTrack;

    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers, bundlePolicy: 'max-bundle' });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.outgoingCandidates.push(event.candidate.toJSON());
        this.scheduleCandidateFlush();
      } else {
        this.flushCandidates(); // end of gathering: do not sit on the last few
      }
    };

    this.pc.ontrack = (event) => {
      if (!this.remoteStream.getTracks().includes(event.track)) this.remoteStream.addTrack(event.track);
      this.opts.onRemoteStream(this.remoteStream);
    };

    this.pc.onconnectionstatechange = () => this.onPeerConnectionState();

    if (opts.role === 'caller') {
      // The caller creates the transceivers (and so decides the m-line order). The callee
      // receives them with the offer and attaches its own tracks in attachCalleeTracks().
      const audio = this.pc.addTransceiver(this.audioTrack, { direction: 'sendrecv' });
      const video = this.pc.addTransceiver('video', { direction: 'sendrecv' });
      this.audioSender = audio.sender;
      this.videoSender = video.sender;
      if (this.videoTrack) void video.sender.replaceTrack(this.videoTrack).catch(() => undefined);
      this.tracksAttached = true;
    }

    this.connectTimer = setTimeout(() => {
      if (!this.everConnected) this.fail();
    }, CONNECT_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------------------
  // Negotiation
  // -------------------------------------------------------------------------------------

  /** Caller only: creates and sends the first offer. */
  startOffer(): Promise<void> {
    return this.enqueue(() => this.makeOffer(false));
  }

  /** Feeds one decrypted, validated signal from the peer. Signals are processed strictly
   *  one at a time, in arrival order. */
  handleSignal(msg: SignalMessage): Promise<void> {
    return this.enqueue(async () => {
      switch (msg.t) {
        case 'offer':
          if (this.opts.role === 'callee') await this.acceptOffer(msg.sdp);
          return;
        case 'answer':
          if (this.opts.role === 'caller' && this.pc.signalingState === 'have-local-offer') {
            await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            await this.drainRemoteCandidates();
          }
          return;
        case 'ice':
          for (const candidate of msg.candidates) {
            if (this.pc.remoteDescription) await this.addCandidate(candidate);
            else this.pendingRemoteCandidates.push(candidate);
          }
          return;
        case 'state':
          this.opts.onRemoteMediaState({ audio: msg.audio, video: msg.video });
          return;
      }
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(() => (this.closed ? undefined : task()))
      .catch((err) => {
        console.warn('[solace] call negotiation step failed', err);
        this.fail();
      });
    return this.queue;
  }

  private async makeOffer(iceRestart: boolean): Promise<void> {
    if (this.pc.signalingState !== 'stable') return;
    const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await this.pc.setLocalDescription(offer);
    this.opts.sendSignal({ t: 'offer', sdp: offer.sdp ?? '' });
  }

  private async acceptOffer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    if (!this.tracksAttached) await this.attachCalleeTracks();
    await this.drainRemoteCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.opts.sendSignal({ t: 'answer', sdp: answer.sdp ?? '' });
  }

  /** Callee: transceivers created by the offer default to receive-only. Make them
   *  send-and-receive and hand each sender our track (or none, for video that is off). */
  private async attachCalleeTracks(): Promise<void> {
    for (const transceiver of this.pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind;
      if (kind === 'audio') {
        transceiver.direction = 'sendrecv';
        this.audioSender = transceiver.sender;
        await transceiver.sender.replaceTrack(this.audioTrack);
      } else if (kind === 'video') {
        transceiver.direction = 'sendrecv';
        this.videoSender = transceiver.sender;
        if (this.videoTrack) await transceiver.sender.replaceTrack(this.videoTrack);
      }
    }
    this.tracksAttached = true;
  }

  // -------------------------------------------------------------------------------------
  // ICE
  // -------------------------------------------------------------------------------------

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // A candidate that does not apply (for example one from before an ICE restart) is
      // harmless to drop; the remaining candidates still connect the call.
    }
  }

  private async drainRemoteCandidates(): Promise<void> {
    const pending = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    for (const candidate of pending) await this.addCandidate(candidate);
  }

  private scheduleCandidateFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushCandidates(), ICE_BATCH_MS);
  }

  private flushCandidates(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.closed || this.outgoingCandidates.length === 0) return;
    const candidates = this.outgoingCandidates;
    this.outgoingCandidates = [];
    this.opts.sendSignal({ t: 'ice', candidates });
  }

  // -------------------------------------------------------------------------------------
  // Connection health
  // -------------------------------------------------------------------------------------

  private onPeerConnectionState(): void {
    if (this.closed) return;
    switch (this.pc.connectionState) {
      case 'connected':
        this.everConnected = true;
        this.clearTimer('connectTimer');
        this.clearTimer('disconnectTimer');
        this.clearTimer('restartTimer');
        this.restartCount = 0;
        this.opts.onConnectionChange('connected');
        this.sendMediaState(); // tell the peer our mute/camera state as soon as media flows
        break;
      case 'disconnected':
        // Often a momentary blip that heals itself. Show it, but only act if it lasts.
        this.opts.onConnectionChange('reconnecting');
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (this.pc.connectionState !== 'connected') this.recover();
          }, DISCONNECT_GRACE_MS);
        }
        break;
      case 'failed':
        this.recover();
        break;
      default:
        break;
    }
  }

  /** The caller restarts ICE (new candidates, same call). The callee has nothing to
   *  initiate, so it waits for the caller's restart offer. Either gives up after a bound. */
  private recover(): void {
    if (this.closed) return;
    this.opts.onConnectionChange('reconnecting');
    if (!this.restartTimer) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.pc.connectionState !== 'connected') this.fail();
      }, RESTART_TIMEOUT_MS);
    }
    if (this.opts.role === 'caller') {
      if (this.restartCount >= MAX_ICE_RESTARTS) {
        this.fail();
        return;
      }
      this.restartCount += 1;
      this.pc.restartIce();
      void this.enqueue(() => this.makeOffer(true));
    }
  }

  private fail(): void {
    if (this.closed) return;
    this.opts.onConnectionChange('failed');
  }

  private clearTimer(name: 'connectTimer' | 'disconnectTimer' | 'restartTimer'): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  // -------------------------------------------------------------------------------------
  // Local controls
  // -------------------------------------------------------------------------------------

  get micEnabled(): boolean {
    return this.audioTrack.enabled;
  }

  get cameraEnabled(): boolean {
    return this.videoTrack !== null;
  }

  /** The local camera as a stream for the self-view, or null when the camera is off. */
  localVideoStream(): MediaStream | null {
    return this.videoTrack ? new MediaStream([this.videoTrack]) : null;
  }

  setMicEnabled(enabled: boolean): void {
    this.audioTrack.enabled = enabled;
    this.sendMediaState();
  }

  /** Turns the camera on or off. Never renegotiates: it swaps the track on the existing
   *  video sender. Throws if the camera cannot be opened, leaving the call untouched. */
  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (this.closed || !this.videoSender) return;
    if (enabled) {
      if (this.videoTrack) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(this.facingMode) });
      const track = stream.getVideoTracks()[0];
      try {
        await this.videoSender.replaceTrack(track);
      } catch (err) {
        track.stop();
        throw err;
      }
      this.videoTrack = track;
    } else {
      const track = this.videoTrack;
      this.videoTrack = null;
      await this.videoSender.replaceTrack(null);
      track?.stop(); // stopping it is what turns the camera light off
    }
    this.sendMediaState();
  }

  /** Switches between front and rear cameras (a no-op result on devices with only one). */
  async switchCamera(): Promise<void> {
    if (this.closed || !this.videoSender || !this.videoTrack) return;
    const next = this.facingMode === 'user' ? 'environment' : 'user';
    // Release the current camera first: many phones cannot open two cameras at once.
    const previous = this.videoTrack;
    previous.stop();
    let track: MediaStreamTrack;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(next) });
      track = stream.getVideoTracks()[0];
    } catch (err) {
      // Could not open the other camera: bring the original one back rather than
      // leaving the user with no video and no explanation.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(this.facingMode) });
        const restored = stream.getVideoTracks()[0];
        await this.videoSender.replaceTrack(restored);
        this.videoTrack = restored;
      } catch {
        // Neither camera can be opened. Do not leave a dead track claiming to be live:
        // fall back to "camera off" and tell the peer.
        this.videoTrack = null;
        await this.videoSender.replaceTrack(null).catch(() => undefined);
        this.sendMediaState();
      }
      throw err;
    }
    await this.videoSender.replaceTrack(track);
    this.videoTrack = track;
    this.facingMode = next;
  }

  private sendMediaState(): void {
    if (this.closed) return;
    this.opts.sendSignal({ t: 'state', audio: this.audioTrack.enabled, video: this.videoTrack !== null });
  }

  // -------------------------------------------------------------------------------------

  /** Stops all local media (turning off the microphone and camera indicators) and tears
   *  the connection down. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer('connectTimer');
    this.clearTimer('disconnectTimer');
    this.clearTimer('restartTimer');
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;

    this.audioTrack.stop();
    this.videoTrack?.stop();
    this.videoTrack = null;
    this.remoteStream.getTracks().forEach((track) => this.remoteStream.removeTrack(track));

    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
