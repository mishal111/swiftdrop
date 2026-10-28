'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, FormField, Input } from '@/components/ui';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { GoogleButton } from './GoogleButton';

/** Owner: M2. Email + password sign-in, plus a Google sign-in link. */
export function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setPending(true);
    setError(undefined);
    const { data, error } = await api.POST('/api/v1/auth/login', {
      body: { email: String(form.get('email')), password: String(form.get('password')) },
    });
    setPending(false);
    if (error || !data) return setError(errorMessage(error, 'Sign-in failed'));
    router.push(next ?? data.home);
    router.refresh();
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      <FormField label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </FormField>
      <FormField label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </FormField>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>

      <GoogleButton label="Sign in with Google" />
    </form>
  );
}

/** Only same-site paths are allowed after login, so `?next=https://evil.example` can't redirect off-site. */
function safeNext(next: string | null): string | null {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : null;
}
