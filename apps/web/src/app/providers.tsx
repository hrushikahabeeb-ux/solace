'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '../lib/authSession';
import { CallProvider } from '../components/CallProvider';

export function Providers({ children }: { children: ReactNode }) {
  // CallProvider sits inside AuthProvider (it needs the session and keys) and above every
  // page, so an incoming call can ring, and an active call survives, whatever screen the
  // user is on.
  return (
    <AuthProvider>
      <CallProvider>{children}</CallProvider>
    </AuthProvider>
  );
}
