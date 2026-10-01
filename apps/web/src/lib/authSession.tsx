'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  E2EEEngine,
  generateDeviceIdentity,
  getCurrentDeviceId,
  loadIdentity,
  purgeLegacyStorage,
  saveIdentity,
  setCurrentDeviceId,
  type DeviceIdentity,
} from '@solace/crypto';
import { api, ApiError, setTokenRefresher, type AuthResponse } from './api';
import { createDeviceDirectory } from './e2ee';

interface AuthState {
  user: AuthResponse['user'] | null;
  deviceId: string | null;
  accessToken: string | null;
  /** The end-to-end encryption engine for this browser's device; null while signed out.
   *  Backed by a non-extractable key persisted in IndexedDB, so it is available again
   *  after a page reload without asking for the password. */
  e2ee: E2EEEngine | null;
  status: 'idle' | 'loading' | 'ready';
}

interface AuthContextValue extends AuthState {
  register(input: { username: string; displayName: string; password: string }): Promise<void>;
  login(input: { username: string; password: string }): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SIGNED_OUT: AuthState = { user: null, deviceId: null, accessToken: null, e2ee: null, status: 'ready' };

// Access tokens live 15 minutes. Refresh well inside that window, and again whenever a
// backgrounded tab (whose timers the browser throttles) becomes visible.
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const TOKEN_STALE_AFTER_MS = 5 * 60 * 1000;

function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Web client';
  return `${navigator.platform || 'Web'} · ${navigator.userAgent.includes('Chrome') ? 'Chrome' : 'Browser'}`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...SIGNED_OUT, status: 'idle' });

  // The device directory needs the newest access token at the moment it makes a request,
  // not the one that was current when the engine was created.
  const tokenRef = useRef<string | null>(null);
  const lastRefreshRef = useRef(0);

  const buildEngine = useCallback(
    (userId: string, deviceId: string, identity: DeviceIdentity) =>
      new E2EEEngine({ userId, deviceId, identity, directory: createDeviceDirectory(() => tokenRef.current) }),
    [],
  );

  const applySession = useCallback(
    (response: AuthResponse, identity: DeviceIdentity) => {
      tokenRef.current = response.accessToken;
      lastRefreshRef.current = Date.now();
      setState({
        user: response.user,
        deviceId: response.deviceId,
        accessToken: response.accessToken,
        e2ee: buildEngine(response.user.id, response.deviceId, identity),
        status: 'ready',
      });
    },
    [buildEngine],
  );

  /** Persists the identity so the next login or reload reuses this device. If the
   *  browser refuses storage (some private modes) the session still works, but the
   *  identity is lost on reload and the next login creates a new device. */
  const persistIdentity = useCallback(async (username: string, deviceId: string, identity: DeviceIdentity) => {
    try {
      await saveIdentity(deviceId, identity);
      await setCurrentDeviceId(username, deviceId);
    } catch (err) {
      console.warn('[solace] Could not persist the device key in this browser; it will be lost on reload.', err);
    }
  }, []);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    try {
      const { accessToken } = await api.refresh();
      tokenRef.current = accessToken;
      lastRefreshRef.current = Date.now();
      setState((s) => (s.user ? { ...s, accessToken } : s));
      return accessToken;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The refresh cookie itself is gone or expired: the session is genuinely over.
        tokenRef.current = null;
        setState(SIGNED_OUT);
      }
      return null; // network trouble: keep the session and try again later
    }
  }, []);

  // Lets api.ts recover from a 401 caused by an expired access token.
  useEffect(() => {
    setTokenRefresher(refreshAccessToken);
    return () => setTokenRefresher(null);
  }, [refreshAccessToken]);

  // Restore the session after a page load. The refresh cookie proves who the user is;
  // the device key lives in IndexedDB. Both are needed, and neither needs the password.
  useEffect(() => {
    let cancelled = false;
    void purgeLegacyStorage();
    (async () => {
      try {
        const { accessToken } = await api.refresh();
        const me = await api.me(accessToken);
        const identity = await loadIdentity(me.deviceId).catch(() => null);
        if (!identity) {
          // Signed in on the server but this browser does not hold the device's private
          // key (site data was cleared, or another browser). Nothing could be decrypted,
          // so end the session; logging in again provisions a fresh device here.
          await api.logout().catch(() => undefined);
          if (!cancelled) setState(SIGNED_OUT);
          return;
        }
        if (cancelled) return;
        applySession({ user: me.user, deviceId: me.deviceId, accessToken }, identity);
      } catch {
        if (!cancelled) setState(SIGNED_OUT);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  // Keep the access token fresh for as long as somebody is signed in.
  const signedIn = state.user !== null;
  useEffect(() => {
    if (!signedIn) return;
    const interval = setInterval(() => void refreshAccessToken(), TOKEN_REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefreshRef.current > TOKEN_STALE_AFTER_MS) {
        void refreshAccessToken();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [signedIn, refreshAccessToken]);

  const register = useCallback(
    async (input: { username: string; displayName: string; password: string }) => {
      setState((s) => ({ ...s, status: 'loading' }));
      try {
        const identity = await generateDeviceIdentity();
        const response = await api.register({
          username: input.username,
          displayName: input.displayName,
          password: input.password,
          device: { label: deviceLabel(), identityKeyPublic: identity.publicKey },
        });
        // Only persist after the server accepted the registration: a key for a device
        // the server never heard of is dead weight.
        await persistIdentity(input.username, response.deviceId, identity);
        applySession(response, identity);
      } catch (err) {
        setState((s) => ({ ...s, status: 'ready' }));
        throw err;
      }
    },
    [applySession, persistIdentity],
  );

  const login = useCallback(
    async (input: { username: string; password: string }) => {
      setState((s) => ({ ...s, status: 'loading' }));
      try {
        // Reuse this browser's existing device for the account when it has one, so
        // messages already addressed to that device stay readable across logins.
        const existingDeviceId = await getCurrentDeviceId(input.username).catch(() => null);
        if (existingDeviceId) {
          const existing = await loadIdentity(existingDeviceId).catch(() => null);
          if (existing) {
            try {
              const response = await api.login({ username: input.username, password: input.password, existingDeviceId });
              applySession(response, existing);
              return;
            } catch (err) {
              // "invalid_device" means the server no longer knows that device (for
              // example after a database reset). Fall through and register a new one.
              // Any other error (wrong password, network) is a real failure.
              if (!(err instanceof ApiError && err.code === 'invalid_device')) throw err;
            }
          }
        }

        const identity = await generateDeviceIdentity();
        const response = await api.login({
          username: input.username,
          password: input.password,
          device: { label: deviceLabel(), identityKeyPublic: identity.publicKey },
        });
        await persistIdentity(input.username, response.deviceId, identity);
        applySession(response, identity);
      } catch (err) {
        setState((s) => ({ ...s, status: 'ready' }));
        throw err;
      }
    },
    [applySession, persistIdentity],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    tokenRef.current = null;
    // The device key is deliberately kept: logging back in on this browser reuses the
    // same device, so nothing addressed to it in the meantime is lost.
    setState(SIGNED_OUT);
  }, []);

  const value = useMemo(() => ({ ...state, register, login, logout }), [state, register, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

export { ApiError };
