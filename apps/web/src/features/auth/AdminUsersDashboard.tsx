'use client';

import { useState } from 'react';
import { Alert, Button, Card, EmptyState, Input, Table, type Column } from '@/components/ui';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Role } from '@swiftdrop/contracts';
import { CreateStaffModal } from './CreateStaffModal';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  phone: string | null;
  createdAt: string;
}

interface AdminUsersDashboardProps {
  initialUsers: UserRow[];
  initialTotal: number;
}

const ROLE_BADGE_STYLES: Record<Role, string> = {
  ADMIN: 'bg-purple-100 text-purple-800 border-purple-200',
  DISPATCHER: 'bg-blue-100 text-blue-800 border-blue-200',
  COURIER: 'bg-amber-100 text-amber-800 border-amber-200',
  MERCHANT: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  CUSTOMER: 'bg-slate-100 text-slate-700 border-slate-200',
};

const ROLES_LIST: { label: string; value: Role | 'ALL' }[] = [
  { label: 'All Users', value: 'ALL' },
  { label: 'Couriers', value: 'COURIER' },
  { label: 'Dispatchers', value: 'DISPATCHER' },
  { label: 'Admins', value: 'ADMIN' },
  { label: 'Merchants', value: 'MERCHANT' },
  { label: 'Customers', value: 'CUSTOMER' },
];

export function AdminUsersDashboard({ initialUsers }: AdminUsersDashboardProps) {
  const [users, setUsers] = useState<UserRow[]>(initialUsers);
  const [roleFilter, setRoleFilter] = useState<Role | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [updatingId, setUpdatingId] = useState<string>();

  async function loadUsers(targetRole = roleFilter, targetSearch = search) {
    setLoading(true);
    setError(undefined);

    const query: { page: number; pageSize: number; role?: Role; search?: string } = {
      page: 1,
      pageSize: 100,
    };
    if (targetRole !== 'ALL') query.role = targetRole;
    if (targetSearch.trim()) query.search = targetSearch.trim();

    const { data, error: apiErr } = await api.GET('/api/v1/admin/users', {
      params: { query },
    });

    setLoading(false);

    if (apiErr || !data) {
      return setError(errorMessage(apiErr, 'Failed to fetch users'));
    }

    setUsers((data.data as unknown as UserRow[]) ?? []);
  }

  async function handleToggleActive(user: UserRow) {
    const nextState = !user.isActive;
    const confirmMessage = nextState
      ? `Re-activate ${user.name}'s account?`
      : `Deactivate ${user.name}? This will immediately terminate all active sessions.`;

    if (!window.confirm(confirmMessage)) return;

    setUpdatingId(user.id);
    setError(undefined);

    const { data, error: apiErr } = await api.PATCH('/api/v1/admin/users/{id}', {
      params: { path: { id: user.id } },
      body: { isActive: nextState },
    });

    setUpdatingId(undefined);

    if (apiErr || !data) {
      return setError(errorMessage(apiErr, 'Failed to update account status'));
    }

    setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, isActive: nextState } : u)));
  }

  async function handleRoleChange(user: UserRow, newRole: Role) {
    if (user.role === newRole) return;
    if (!window.confirm(`Change ${user.name}'s role to ${newRole}?`)) return;

    setUpdatingId(user.id);
    setError(undefined);

    const { data, error: apiErr } = await api.PATCH('/api/v1/admin/users/{id}', {
      params: { path: { id: user.id } },
      body: { role: newRole },
    });

    setUpdatingId(undefined);

    if (apiErr || !data) {
      return setError(errorMessage(apiErr, 'Failed to update role'));
    }

    setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: newRole } : u)));
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    loadUsers(roleFilter, search);
  }

  const columns: Column<UserRow>[] = [
    {
      header: 'User',
      cell: (u) => (
        <div>
          <div className="font-medium text-ink">{u.name}</div>
          <div className="text-xs text-muted">{u.email}</div>
        </div>
      ),
    },
    {
      header: 'Role',
      cell: (u) => (
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${ROLE_BADGE_STYLES[u.role]}`}
        >
          {u.role}
        </span>
      ),
    },
    {
      header: 'Phone',
      cell: (u) => <span className="text-xs text-muted">{u.phone ?? '—'}</span>,
    },
    {
      header: 'Status',
      cell: (u) => (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            u.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'
          }`}
        >
          {u.isActive ? 'Active' : 'Disabled'}
        </span>
      ),
    },
    {
      header: 'Joined',
      cell: (u) => (
        <span className="text-xs text-muted">
          {new Date(u.createdAt).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </span>
      ),
    },
    {
      header: 'Actions',
      className: 'px-4 py-3 text-right',
      cell: (u) => (
        <div className="flex items-center justify-end gap-2">
          <select
            value={u.role}
            disabled={updatingId === u.id}
            onChange={(e) => handleRoleChange(u, e.target.value as Role)}
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-canvas"
          >
            <option value="CUSTOMER">Customer</option>
            <option value="COURIER">Courier</option>
            <option value="DISPATCHER">Dispatcher</option>
            <option value="MERCHANT">Merchant</option>
            <option value="ADMIN">Admin</option>
          </select>

          <Button
            variant={u.isActive ? 'secondary' : 'primary'}
            disabled={updatingId === u.id}
            onClick={() => handleToggleActive(u)}
            className="px-2.5 py-1 text-xs"
          >
            {updatingId === u.id ? '…' : u.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {error && <Alert tone="error">{error}</Alert>}

      {/* Top Controls: Filter Pills, Search Bar, Create Staff Button */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Role Filter Tabs */}
        <div className="flex flex-wrap gap-1.5">
          {ROLES_LIST.map((tab) => (
            <button
              key={tab.value}
              onClick={() => {
                setRoleFilter(tab.value);
                loadUsers(tab.value, search);
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                roleFilter === tab.value
                  ? 'bg-brand text-white shadow-xs'
                  : 'bg-surface text-muted border border-line hover:bg-canvas hover:text-ink'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Create Staff Button */}
        <div className="flex items-center gap-2">
          <form onSubmit={handleSearchSubmit} className="flex gap-1.5">
            <Input
              type="search"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48 sm:w-64 text-xs"
            />
            <Button type="submit" variant="secondary" className="px-3 py-1.5 text-xs">
              Search
            </Button>
          </form>

          <Button onClick={() => setModalOpen(true)} className="whitespace-nowrap text-xs">
            + Create Staff
          </Button>
        </div>
      </div>

      {/* Data Table */}
      {loading ? (
        <Card className="py-12 text-center text-sm text-muted">Loading user accounts…</Card>
      ) : (
        <Table
          columns={columns}
          rows={users}
          rowKey={(u) => u.id}
          empty={
            <EmptyState
              title="No users found"
              description={
                search || roleFilter !== 'ALL'
                  ? 'Try adjusting your search criteria or role filters.'
                  : 'There are no user accounts registered in the system yet.'
              }
              action={
                <Button variant="secondary" onClick={() => loadUsers('ALL', '')}>
                  Reset Filters
                </Button>
              }
            />
          }
        />
      )}

      {/* Create Staff Modal */}
      <CreateStaffModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => loadUsers(roleFilter, search)}
      />
    </div>
  );
}
