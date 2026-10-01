'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, ApiError } from '../lib/authSession';

const ERROR_MESSAGES: Record<string, string> = {
  username_taken: 'That username is already taken.',
  invalid_credentials: 'Incorrect username or passphrase.',
  invalid_request: 'Please check the form — something is missing or too short.',
};

/**
 * Phase 0/1 auth screen. Visual language locked to the approved theme reference:
 * dark muted navy/lavender canvas, a large central blush-pink card, soft organic
 * blob shapes behind it, thin botanical line accents in the corners, and coral as
 * the single call-to-action color.
 *
 * Submitting either form generates an end-to-end encryption identity for this browser
 * (an ECDH P-256 key pair whose private half is non-extractable and kept in IndexedDB)
 * and only sends the PUBLIC key to the server (see lib/authSession.tsx).
 */
export function AuthCard() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const auth = useAuth();
  const router = useRouter();

  // A session restored from the refresh cookie needs no second login.
  useEffect(() => {
    if (auth.status === 'ready' && auth.user) router.replace('/chat');
  }, [auth.status, auth.user, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'register') {
        await auth.register({ username, displayName, password });
      } else {
        await auth.login({ username, password });
      }
      router.push('/chat');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(ERROR_MESSAGES[err.code] ?? 'Something went wrong. Please try again.');
      } else {
        setError('Could not reach the server. Is it running?');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
      <div className="solace-backdrop" aria-hidden />
      <BotanicalCorner className="absolute left-6 top-6 h-24 w-24 text-lavender opacity-60" />
      <BotanicalCorner className="absolute bottom-6 right-6 h-24 w-24 rotate-180 text-peach opacity-60" />

      <div className="relative z-10 w-full max-w-md rounded-lg bg-card p-10 shadow-card">
        <div className="mb-8 text-center">
          <h1 className="font-display text-3xl text-ink-card">Solace</h1>
          <p className="mt-2 text-sm text-ink-card-muted">
            Private by design. Even we can&apos;t read your messages.
          </p>
        </div>

        <div className="mb-6 flex rounded-pill bg-card-alt p-1 text-sm font-medium">
          <button
            type="button"
            className={`flex-1 rounded-pill py-2 transition-colors ${
              mode === 'login' ? 'bg-coral text-cream shadow-soft' : 'text-ink-card-muted'
            }`}
            onClick={() => setMode('login')}
          >
            Log in
          </button>
          <button
            type="button"
            className={`flex-1 rounded-pill py-2 transition-colors ${
              mode === 'register' ? 'bg-coral text-cream shadow-soft' : 'text-ink-card-muted'
            }`}
            onClick={() => setMode('register')}
          >
            Create account
          </button>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <Field
              label="Display name"
              placeholder="Habeeb"
              name="displayName"
              value={displayName}
              onChange={setDisplayName}
            />
          )}
          <Field label="Username" placeholder="habeeb" name="username" value={username} onChange={setUsername} />
          <Field
            label="Passphrase"
            placeholder="At least 12 characters"
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 w-full rounded-pill bg-coral py-3 font-medium text-cream shadow-soft transition-colors hover:bg-coral-hover disabled:opacity-60"
          >
            {busy
              ? 'Generating your keys…'
              : mode === 'login'
                ? 'Log in'
                : 'Create my encrypted account'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-card-muted">
          Your keys are generated on this device and never leave it unencrypted.
        </p>
      </div>
    </main>
  );
}

function Field({
  label,
  placeholder,
  name,
  type = 'text',
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  name: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-card-muted">{label}</span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        minLength={type === 'password' ? 12 : undefined}
        className="w-full rounded-md bg-cream px-4 py-3 text-sm text-ink-card outline-none ring-coral/40 placeholder:text-ink-card-muted focus:ring-2"
      />
    </label>
  );
}

function BotanicalCorner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M10 90 C 20 60, 15 40, 40 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M18 55 C 28 50, 32 40, 30 30" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M14 72 C 26 70, 34 62, 34 50" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="40" cy="20" r="3" fill="currentColor" />
      <circle cx="30" cy="30" r="2" fill="currentColor" />
    </svg>
  );
}
