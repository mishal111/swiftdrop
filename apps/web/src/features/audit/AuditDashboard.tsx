'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, EmptyState, Input } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { api } from '@/lib/api/client';

export type AuditActor = {
  id: string;
  name: string;
  email: string;
  role: string;
};

export type AuditPerson = {
  id: string;
  name: string;
  email: string;
};

export type AuditLog = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: AuditActor | null;
  actorRole: string | null;
  affectedPerson: AuditPerson | null;
  timestamp: string;
  metadata: Record<string, unknown> | null;
};

export type AuditLogPage = {
  data: AuditLog[];
  meta: { page: number; pageSize: number; total: number };
};

type UserOption = { id: string; name: string; email: string };
type UserLookupPage = {
  data: UserOption[];
  meta: { page: number; pageSize: number; total: number };
};
type AuditMode = 'person' | 'all';
type AuditFilters = {
  mode: AuditMode;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string;
  from: string;
  to: string;
};

const emptyFilters: AuditFilters = {
  mode: 'all',
  action: '',
  entityType: '',
  entityId: '',
  actorId: '',
  from: '',
  to: '',
};

// Must match the action names modules pass to AuditService.record().
const actions = [
  'user.created',
  'user.role_changed',
  'user.status_changed',
  'user.updated',
  'merchant.approved',
  'merchant.rejected',
  'merchant.suspended',
  'api_key.created',
  'api_key.revoked',
  'webhook_secret.rotated',
  'zone.created',
  'zone.updated',
  'pricing_rule.created',
  'pricing_rule.updated',
  'parcel.assigned',
  'parcel.unassigned',
  'webhook_attempt.retried',
];

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en-LK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Colombo',
  }).format(new Date(value));
}

function queryFromFilters(filters: AuditFilters, page: number, pageSize: number) {
  return {
    page,
    pageSize,
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}

function LoadingRows() {
  return (
    <div className="space-y-3" aria-label="Loading audit logs">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="h-14 animate-pulse rounded-md bg-canvas" />
      ))}
    </div>
  );
}

function MetadataDetails({ entry }: { entry: AuditLog }) {
  const metadata = entry.metadata;
  if (entry.action === 'user.role_changed') {
    const previousRole = metadata?.previousRole;
    const newRole = metadata?.newRole;
    if (typeof previousRole === 'string' || typeof newRole === 'string') {
      return (
        <details>
          <summary className="cursor-pointer font-medium text-brand">View details</summary>
          <dl className="mt-2 text-xs">
            {typeof previousRole === 'string' && <div>Previous role: {previousRole}</div>}
            {typeof newRole === 'string' && <div>New role: {newRole}</div>}
          </dl>
        </details>
      );
    }
  }
  if (!metadata || Object.keys(metadata).length === 0)
    return <span className="text-muted">No details</span>;
  return (
    <details>
      <summary className="cursor-pointer font-medium text-brand">View details</summary>
      <pre className="mt-2 max-w-md overflow-x-auto whitespace-pre-wrap break-words rounded bg-canvas p-3 text-xs text-ink">
        {JSON.stringify(metadata, null, 2)}
      </pre>
    </details>
  );
}

export function AuditDashboard({
  initialData,
  initialError,
}: {
  initialData: AuditLogPage | null;
  initialError?: string;
}) {
  const [filters, setFilters] = useState(emptyFilters);
  const [draft, setDraft] = useState(emptyFilters);
  const [personName, setPersonName] = useState('');
  const [selectedEmail, setSelectedEmail] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string>();
  const [lookupPage, setLookupPage] = useState(0);
  const [lookupTotal, setLookupTotal] = useState(0);
  const lookupRequestRef = useRef(0);
  const [data, setData] = useState<AuditLogPage | null>(initialData);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const pageSize = data?.meta.pageSize ?? 20;
  const currentPage = data?.meta.page ?? 1;
  const totalPages = Math.max(1, Math.ceil((data?.meta.total ?? 0) / pageSize));
  const matchingUsers = useMemo(
    () =>
      users.filter((user) =>
        user.name.toLocaleLowerCase().includes(personName.trim().toLocaleLowerCase()),
      ),
    [personName, users],
  );

  useEffect(() => {
    const name = personName.trim();
    const requestId = ++lookupRequestRef.current;
    if (draft.mode !== 'person' || !name) {
      return;
    }
    const timer = window.setTimeout(async () => {
      setLookupLoading(true);
      setLookupError(undefined);
      const response = (await api.GET('/api/v1/admin/audit-logs/users', {
        params: { query: { search: name, page: 1, pageSize: 100 } },
      })) as unknown as { data?: UserLookupPage; error?: unknown };
      if (requestId !== lookupRequestRef.current) return;
      if (response.error || !response.data) {
        setUsers([]);
        setLookupError(errorMessage(response.error, 'Could not search users'));
        setLookupPage(0);
        setLookupTotal(0);
      } else {
        setUsers(response.data.data);
        setLookupPage(response.data.meta.page);
        setLookupTotal(response.data.meta.total);
      }
      setLookupLoading(false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [personName, draft.mode]);

  async function loadMoreUsers() {
    const name = personName.trim();
    if (!name || lookupLoading || lookupPage === 0 || lookupPage * 100 >= lookupTotal) {
      return;
    }

    const requestId = lookupRequestRef.current;
    setLookupLoading(true);
    setLookupError(undefined);
    const response = (await api
      .GET('/api/v1/admin/audit-logs/users', {
        params: { query: { search: name, page: lookupPage + 1, pageSize: 100 } },
      })
      .catch((error: unknown) => ({ data: undefined, error }))) as unknown as {
      data?: UserLookupPage;
      error?: unknown;
    };
    if (requestId !== lookupRequestRef.current) return;
    if (response.error || !response.data) {
      setLookupError(errorMessage(response.error, 'Could not load more users'));
    } else {
      setUsers((current) => {
        const existingIds = new Set(current.map((user) => user.id));
        return [...current, ...response.data!.data.filter((user) => !existingIds.has(user.id))];
      });
      setLookupPage(response.data.meta.page);
      setLookupTotal(response.data.meta.total);
    }
    setLookupLoading(false);
  }

  async function load(nextFilters: AuditFilters, page: number) {
    setLoading(true);
    setError(undefined);
    // A network failure rejects instead of returning { error }; treat it as an error result.
    const response = (await api
      .GET('/api/v1/admin/audit-logs', {
        params: { query: queryFromFilters(nextFilters, page, pageSize) },
      })
      .catch((error: unknown) => ({ data: undefined, error }))) as unknown as {
      data?: unknown;
      error?: unknown;
    };
    const result = response.data as unknown as AuditLogPage | undefined;
    if (response.error || !result)
      setError(errorMessage(response.error, 'Could not load audit logs'));
    else setData(result);
    setLoading(false);
  }

  function updateDraft(name: keyof AuditFilters, value: string) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  function updateMode(mode: AuditMode) {
    setDraft((current) => ({
      ...current,
      mode,
      entityType: mode === 'person' ? 'User' : '',
      entityId: '',
    }));
    setPersonName('');
    setSelectedEmail('');
    setUsers([]);
    setLookupError(undefined);
    setLookupLoading(false);
  }

  function updatePersonName(name: string) {
    setPersonName(name);
    setSelectedEmail('');
    setDraft((current) => ({ ...current, entityId: '' }));
    setUsers([]);
    setLookupError(undefined);
    setLookupLoading(false);
  }

  function chooseEmail(email: string) {
    setSelectedEmail(email);
    const user = matchingUsers.find((candidate) => candidate.email === email);
    setDraft((current) => ({ ...current, entityId: user?.id ?? '' }));
  }

  function applyFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      draft.mode === 'person' &&
      (!personName.trim() ||
        !selectedEmail ||
        !draft.entityId ||
        !draft.from ||
        (draft.to && draft.to < draft.from))
    ) {
      return;
    }
    setFilters(draft);
    void load(draft, 1);
  }

  function clearFilters() {
    setDraft(emptyFilters);
    setFilters(emptyFilters);
    setPersonName('');
    setSelectedEmail('');
    void load(emptyFilters, 1);
  }

  function retry() {
    void load(filters, currentPage);
  }

  const personValid =
    personName.trim().length > 0 &&
    selectedEmail.length > 0 &&
    draft.entityId.length > 0 &&
    draft.from.length > 0 &&
    (!draft.to || draft.to >= draft.from);
  const canApply =
    draft.mode === 'all' ? !draft.to || !draft.from || draft.to >= draft.from : personValid;

  return (
    <div className="space-y-5">
      <Card>
        <form className="space-y-4" onSubmit={applyFilters}>
          <label className="grid gap-1.5 text-sm font-medium">
            Search mode
            <select
              className="rounded-md border border-line bg-surface px-3 py-2"
              value={draft.mode}
              onChange={(event) => updateMode(event.target.value as AuditMode)}
            >
              <option value="person">Search by Person</option>
              <option value="all">All Activity</option>
            </select>
          </label>

          {draft.mode === 'person' && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="grid gap-1.5 text-sm font-medium">
                Person name
                <Input
                  value={personName}
                  onChange={(event) => updatePersonName(event.target.value)}
                  placeholder="Search by name"
                />
              </label>
              <div className="grid gap-1.5 text-sm font-medium">
                <span>Email address</span>
                <select
                  className="rounded-md border border-line bg-surface px-3 py-2"
                  value={selectedEmail}
                  onChange={(event) => chooseEmail(event.target.value)}
                  disabled={lookupLoading || matchingUsers.length === 0}
                >
                  <option value="">{lookupLoading ? 'Searching...' : 'Select an email'}</option>
                  {matchingUsers.map((user) => (
                    <option key={user.id} value={user.email}>
                      {user.email} ({user.name})
                    </option>
                  ))}
                </select>
                {!lookupLoading && personName.trim() && matchingUsers.length === 0 && (
                  <span className="text-xs text-muted">No matching accounts found.</span>
                )}
                {lookupError && <span className="text-xs text-danger">{lookupError}</span>}
                {matchingUsers.length > 0 && lookupPage * 100 < lookupTotal && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={lookupLoading}
                    onClick={() => void loadMoreUsers()}
                  >
                    {lookupLoading ? 'Loading...' : 'Load more users'}
                  </Button>
                )}
              </div>
              <label className="grid gap-1.5 text-sm font-medium">
                Entity ID
                <div className="flex gap-2">
                  <Input value={draft.entityId} readOnly placeholder="Selected automatically" />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!draft.entityId}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(draft.entityId)
                        .catch(() => setError('Could not copy the Entity ID'))
                    }
                  >
                    Copy ID
                  </Button>
                </div>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Start date
                <Input
                  type="date"
                  value={draft.from}
                  onChange={(event) => updateDraft('from', event.target.value)}
                  required
                />
                {!draft.from && <span className="text-xs text-muted">Start date is required.</span>}
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                End date <span className="font-normal text-muted">(optional)</span>
                <Input
                  type="date"
                  value={draft.to}
                  min={draft.from || undefined}
                  onChange={(event) => updateDraft('to', event.target.value)}
                />
              </label>
            </div>
          )}

          {draft.mode === 'all' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                Start date (optional)
                <Input
                  type="date"
                  value={draft.from}
                  onChange={(event) => updateDraft('from', event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                End date (optional)
                <Input
                  type="date"
                  min={draft.from || undefined}
                  value={draft.to}
                  onChange={(event) => updateDraft('to', event.target.value)}
                />
              </label>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="grid gap-1.5 text-sm font-medium">
              Action
              <select
                className="rounded-md border border-line bg-surface px-3 py-2"
                value={draft.action}
                onChange={(event) => updateDraft('action', event.target.value)}
              >
                <option value="">All actions</option>
                {actions.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Entity type
              <Input
                value={draft.entityType}
                onChange={(event) => updateDraft('entityType', event.target.value)}
                placeholder={draft.mode === 'person' ? 'User' : 'All entity types'}
              />
            </label>
          </div>

          <details>
            <summary className="cursor-pointer text-sm font-medium text-brand">
              Advanced filters
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                Actor ID
                <Input
                  value={draft.actorId}
                  onChange={(event) => updateDraft('actorId', event.target.value)}
                />
              </label>
              {draft.mode === 'all' && (
                <label className="grid gap-1.5 text-sm font-medium">
                  Entity ID
                  <Input
                    value={draft.entityId}
                    onChange={(event) => updateDraft('entityId', event.target.value)}
                  />
                </label>
              )}
            </div>
          </details>

          {draft.to && draft.from && draft.to < draft.from && (
            <p className="text-sm text-danger">End date cannot be earlier than start date.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={loading || !canApply}>
              Apply filters
            </Button>
            <Button type="button" variant="secondary" onClick={clearFilters} disabled={loading}>
              Clear filters
            </Button>
          </div>
        </form>
      </Card>

      {error && (
        <Alert tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button type="button" variant="secondary" onClick={retry}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {loading ? (
        <LoadingRows />
      ) : data && data.data.length > 0 ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="min-w-[1100px] divide-y divide-line text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  {[
                    'Timestamp',
                    'Performed by',
                    'Affected person',
                    'Action',
                    'Entity type',
                    'Entity ID',
                    'View details',
                  ].map((heading) => (
                    <th key={heading} className="px-4 py-3 font-medium">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.data.map((entry) => (
                  <tr key={entry.id} className="align-top hover:bg-canvas">
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {formatDateTime(entry.timestamp)}
                    </td>
                    <td className="px-4 py-3">
                      {entry.actor ? (
                        <>
                          <p className="font-medium">{entry.actor.name}</p>
                          <p className="text-xs text-muted">{entry.actor.email}</p>
                        </>
                      ) : (
                        <span>System</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {entry.affectedPerson ? (
                        <>
                          <p className="font-medium">{entry.affectedPerson.name}</p>
                          <p className="text-xs text-muted">{entry.affectedPerson.email}</p>
                        </>
                      ) : (
                        <span className="text-muted">Unavailable</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{entry.action}</td>
                    <td className="px-4 py-3">{entry.entityType}</td>
                    <td className="px-4 py-3 font-mono text-xs">{entry.entityId}</td>
                    <td className="px-4 py-3">
                      <MetadataDetails entry={entry} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
            aria-label="Audit log pages"
          >
            <p className="text-muted">
              Page {currentPage} of {totalPages}, {data.meta.total} records
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={loading || currentPage <= 1}
                onClick={() => void load(filters, currentPage - 1)}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={loading || currentPage >= totalPages}
                onClick={() => void load(filters, currentPage + 1)}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      ) : (
        <EmptyState
          title="No audit records found"
          description="Try adjusting the filters or check back after administrative activity occurs."
        />
      )}
    </div>
  );
}
