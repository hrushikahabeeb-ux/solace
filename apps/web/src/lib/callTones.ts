'use client';

/**
 * Call tones, synthesized with WebAudio so there are no audio files to ship or license.
 *
 * Browsers only let a page make sound after the user has interacted with it. Signing in
 * counts, but a tab that was reloaded and never clicked will ring silently until the first
 * interaction; the visual incoming-call UI is unaffected.
 */

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
  return context;
}

/** One shaped burst of the given frequencies. The short attack/release avoids clicks. */
function burst(ctx: AudioContext, frequencies: number[], startAt: number, durationSec: number, volume: number): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + 0.02);
  gain.gain.setValueAtTime(volume, startAt + durationSec - 0.03);
  gain.gain.linearRampToValueAtTime(0, startAt + durationSec);
  gain.connect(ctx.destination);
  for (const frequency of frequencies) {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(startAt);
    oscillator.stop(startAt + durationSec + 0.05);
  }
}

/** Repeats `play` every `periodMs` until the returned function is called. */
function loop(play: (ctx: AudioContext, at: number) => void, periodMs: number): () => void {
  const ctx = audioContext();
  if (!ctx) return () => undefined;
  const tick = () => play(ctx, ctx.currentTime + 0.02);
  tick();
  const interval = setInterval(tick, periodMs);
  return () => clearInterval(interval);
}

/** Incoming call: a double chirp, repeated. */
export function startRingtone(): () => void {
  return loop((ctx, at) => {
    burst(ctx, [659, 784], at, 0.28, 0.12);
    burst(ctx, [659, 784], at + 0.4, 0.28, 0.12);
  }, 2400);
}

/** Outgoing call while the other side is ringing: a steady tone, repeated. */
export function startRingback(): () => void {
  return loop((ctx, at) => burst(ctx, [440, 480], at, 1.6, 0.08), 4000);
}

/** A short falling two-note tone when a call ends. */
export function playEndTone(): void {
  const ctx = audioContext();
  if (!ctx) return;
  const at = ctx.currentTime + 0.02;
  burst(ctx, [480], at, 0.14, 0.09);
  burst(ctx, [380], at + 0.18, 0.2, 0.09);
}
