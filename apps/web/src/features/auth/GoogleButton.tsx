'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui';

const GOOGLE_START = '/api/v1/auth/google';

/**
 * Owner: M2. "Continue with Google" button with an "or" divider above it.
 * It checks the OAuth start endpoint first, so an environment without Google credentials (501)
 * shows a friendly message instead of a raw JSON error page.
 */
export function GoogleButton({ label = 'Continue with Google' }: { label?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function start() {
    setPending(true);
    setError(undefined);
    try {
      const res = await fetch(GOOGLE_START, { redirect: 'manual' });
      if (res.status === 501) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? 'Google sign-in is not configured in this environment');
        setPending(false);
        return;
      }
    } catch {
      // Network hiccup: fall through and let the full-page navigation report it.
    }
    // A full-page navigation is required: this is an API redirect, not a Next.js route.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(GOOGLE_START);
  }

  return (
    <>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:bg-canvas disabled:opacity-60"
      >
        {/* Google's brand colours are fixed by their guidelines, so they are not design tokens. */}
        <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
          />
        </svg>
        {pending ? 'Connecting to Google…' : label}
      </button>
    </>
  );
}
