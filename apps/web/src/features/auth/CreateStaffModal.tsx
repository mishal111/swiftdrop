'use client';

import { useState } from 'react';
import { Alert, Button, FormField, Input } from '@/components/ui';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Role } from '@swiftdrop/contracts';

interface CreateStaffModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateStaffModal({ open, onClose, onCreated }: CreateStaffModalProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(undefined);

    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const email = String(form.get('email') ?? '').trim();
    const role = String(form.get('role') ?? 'COURIER') as Role;
    const password = String(form.get('password') ?? '');
    const phone = String(form.get('phone') ?? '').trim();

    if (password.length < 8) {
      setPending(false);
      return setError('Password must be at least 8 characters long');
    }

    const { data, error: apiErr } = await api.POST('/api/v1/admin/users', {
      body: {
        name,
        email,
        role,
        password,
        phone: phone || undefined,
      },
    });

    setPending(false);

    if (apiErr || !data) {
      return setError(errorMessage(apiErr, 'Failed to create staff member'));
    }

    onCreated();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-xl animate-in fade-in zoom-in-95">
        <div className="flex items-center justify-between pb-4 border-b border-line">
          <div>
            <h2 className="text-lg font-semibold">Create Staff Account</h2>
            <p className="text-xs text-muted">Provision a new employee or administrator</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted hover:bg-canvas hover:text-ink transition"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {error && <Alert tone="error">{error}</Alert>}

          <FormField label="Full name" htmlFor="staff-name">
            <Input id="staff-name" name="name" required placeholder="e.g. Chamal Courier" />
          </FormField>

          <FormField label="Email address" htmlFor="staff-email">
            <Input
              id="staff-email"
              name="email"
              type="email"
              required
              placeholder="staff@swiftdrop.test"
            />
          </FormField>

          <FormField label="Staff role" htmlFor="staff-role">
            <select
              id="staff-role"
              name="role"
              defaultValue="COURIER"
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-hidden focus:ring-1 focus:ring-brand"
            >
              <option value="COURIER">Courier (Field delivery & POD)</option>
              <option value="DISPATCHER">Dispatcher (Assignment & Zones)</option>
              <option value="ADMIN">Administrator (Full Access)</option>
            </select>
          </FormField>

          <FormField label="Temporary password" htmlFor="staff-password">
            <Input
              id="staff-password"
              name="password"
              type="password"
              required
              minLength={8}
              placeholder="Minimum 8 characters"
            />
          </FormField>

          <FormField label="Phone number (optional)" htmlFor="staff-phone">
            <Input id="staff-phone" name="phone" type="tel" placeholder="+94770000000" />
          </FormField>

          <div className="flex justify-end gap-3 pt-3 border-t border-line">
            <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create Staff'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
