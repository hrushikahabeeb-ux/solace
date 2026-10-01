'use client';
import type { E2EEEngine } from '../lib/e2ee';

import { DecryptedText } from './DecryptedText';
import type { WireTaskWithDetails } from '../lib/api';

/** A brief, dismissible celebration — matches the product philosophy's "subtle
 *  celebration when tasks are completed" without being childish. Pure CSS confetti
 *  dots (no animation library needed) fall away automatically; the card stays until
 *  the person closes it or picks an action. */
export function TaskCelebration({
  task,
  workspaceName,
  e2ee,
  onViewTask,
  onCreateAnother,
  onClose,
}: {
  task: WireTaskWithDetails;
  workspaceName: string;
  e2ee: E2EEEngine | null;
  onViewTask: () => void;
  onCreateAnother: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="relative w-full max-w-sm overflow-hidden rounded-lg bg-card p-8 text-center shadow-card" onClick={(e) => e.stopPropagation()}>
        <Confetti />
        <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-pill bg-success text-3xl text-cream">✓</div>
        <p className="relative mt-4 font-display text-xl text-ink-card">Task completed!</p>
        <p className="relative mt-1 text-sm text-ink-card-muted">Great job! 🎉</p>

        <button
          onClick={onViewTask}
          className="relative mt-5 flex w-full items-center gap-3 rounded-md bg-card-alt p-3 text-left hover:opacity-90"
        >
          <span className="text-xl">🚀</span>
          <span className="min-w-0 flex-1">
            <DecryptedText
              ciphertext={task.titleCiphertext}
              sessionRef={task.sessionRef}
              e2ee={e2ee}
              className="block truncate text-sm font-medium text-ink-card"
            />
            <span className="block text-xs text-ink-card-muted">{workspaceName}</span>
          </span>
          <span className="text-ink-card-muted">›</span>
        </button>

        <button onClick={onViewTask} className="relative mt-3 w-full rounded-pill bg-coral py-2.5 text-sm font-medium text-cream">
          View task
        </button>
        <button onClick={onCreateAnother} className="relative mt-2 text-xs text-lavender-deep hover:underline">
          Create another task
        </button>
      </div>
    </div>
  );
}

function Confetti() {
  const dots = Array.from({ length: 18 });
  const colors = ['var(--color-accent-coral)', 'var(--color-accent-peach)', 'var(--color-accent-lavender)', 'var(--color-warning)'];
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {dots.map((_, i) => (
        <span
          key={i}
          className="absolute h-2 w-2 rounded-pill opacity-80"
          style={{
            left: `${(i * 37) % 100}%`,
            top: `${-10 - ((i * 13) % 30)}%`,
            backgroundColor: colors[i % colors.length],
            animation: `confetti-fall 1.2s ease-in ${(i % 6) * 0.08}s forwards`,
          }}
        />
      ))}
      <style>{`
        @keyframes confetti-fall {
          to { transform: translateY(140px) rotate(180deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
