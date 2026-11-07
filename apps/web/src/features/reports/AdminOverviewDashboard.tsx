'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Alert, Button, Card, EmptyState, Table, type Column } from '@/components/ui';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';

type DeliverySummary = {
  total: number;
  delivered: number;
  failed: number;
  inProgress: number;
  successRate: number;
};

type DailyVolume = {
  date: string;
  created: number;
  delivered: number;
  failed: number;
};

type CourierPerformance = {
  courierId: string;
  name: string;
  assigned: number;
  delivered: number;
  failed: number;
};

type OverviewAudit = {
  id: string;
  action: string;
  entityType: string;
  actor: { name: string; role: string } | null;
  actorRole: string | null;
  timestamp: string;
};

export type OverviewData = {
  summary?: DeliverySummary;
  dailyVolume?: DailyVolume[];
  couriers?: CourierPerformance[];
  audit?: { data: OverviewAudit[]; meta: { total: number } };
};

export type OverviewErrors = {
  summary?: string;
  dailyVolume?: string;
  couriers?: string;
  audit?: string;
};

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat('en-LK', {
  month: 'short',
  day: 'numeric',
  timeZone: 'Asia/Colombo',
});
const dateTimeFormat = new Intl.DateTimeFormat('en-LK', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Colombo',
});

function percentage(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading overview" role="status">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Card key={index} className="animate-pulse">
            <div className="h-4 w-24 rounded bg-canvas" />
            <div className="mt-4 h-8 w-16 rounded bg-canvas" />
          </Card>
        ))}
      </div>
      <Card className="animate-pulse">
        <div className="h-5 w-40 rounded bg-canvas" />
        <div className="mt-6 h-48 rounded bg-canvas" />
      </Card>
    </div>
  );
}

function courierSuccessRate(row: CourierPerformance) {
  const terminalOutcomes = row.delivered + row.failed;
  return terminalOutcomes === 0 ? 0 : row.delivered / terminalOutcomes;
}

export function AdminOverviewDashboard({
  initialData,
  initialAudit,
  initialErrors,
}: {
  initialData: OverviewData;
  initialAudit: OverviewData['audit'] | null;
  initialErrors: OverviewErrors;
}) {
  const [data, setData] = useState(initialData);
  const [audit, setAudit] = useState(initialAudit);
  const [errors, setErrors] = useState(initialErrors);
  const [loading, setLoading] = useState(false);

  async function loadOverview() {
    setLoading(true);
    const [summary, dailyVolume, couriers, auditResponse] = (await Promise.all([
      api.GET('/api/v1/admin/reports/deliveries'),
      api.GET('/api/v1/admin/reports/daily-volume'),
      api.GET('/api/v1/admin/reports/couriers'),
      api.GET('/api/v1/admin/audit-logs', { params: { query: { page: 1, pageSize: 5 } } }),
    ])) as [
      { data?: OverviewData['summary']; error?: unknown },
      { data?: OverviewData['dailyVolume']; error?: unknown },
      { data?: OverviewData['couriers']; error?: unknown },
      { data?: unknown; error?: unknown },
    ];
    setData({
      summary: summary.data ?? undefined,
      dailyVolume: dailyVolume.data ?? undefined,
      couriers: couriers.data ?? undefined,
    });
    setErrors({
      summary: summary.error
        ? errorMessage(summary.error, 'Could not load delivery summary')
        : undefined,
      dailyVolume: dailyVolume.error
        ? errorMessage(dailyVolume.error, 'Could not load daily delivery activity')
        : undefined,
      couriers: couriers.error
        ? errorMessage(couriers.error, 'Could not load courier performance')
        : undefined,
      audit: auditResponse.error
        ? errorMessage(auditResponse.error, 'Could not load recent audit activity')
        : undefined,
    });
    if (auditResponse.data) {
      setAudit(auditResponse.data as unknown as OverviewData['audit']);
    } else {
      setAudit(null);
    }
    setLoading(false);
  }

  const maxVolume = useMemo(
    () =>
      Math.max(
        1,
        ...(data.dailyVolume?.flatMap((row) => [row.created, row.delivered, row.failed]) ?? []),
      ),
    [data],
  );

  const courierColumns: Column<CourierPerformance>[] = [
    { header: 'Courier', cell: (row) => <span className="font-medium">{row.name}</span> },
    { header: 'Assigned', cell: (row) => numberFormat.format(row.assigned) },
    { header: 'Delivered', cell: (row) => numberFormat.format(row.delivered) },
    { header: 'Failed', cell: (row) => numberFormat.format(row.failed) },
    { header: 'Success rate', cell: (row) => percentage(courierSuccessRate(row)) },
  ];

  return (
    <div className="space-y-6">
      {loading && !data ? <LoadingSkeleton /> : null}
      {(errors.summary || errors.dailyVolume || errors.couriers || errors.audit) && (
        <Alert tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Some overview sections could not be loaded.</span>
            <Button variant="secondary" onClick={() => void loadOverview()} disabled={loading}>
              {loading ? 'Retrying...' : 'Retry'}
            </Button>
          </div>
        </Alert>
      )}

      {data.summary ||
      data.dailyVolume ||
      data.couriers ||
      audit ||
      errors.summary ||
      errors.dailyVolume ||
      errors.couriers ||
      errors.audit ? (
        <>
          {errors.summary ? (
            <Alert tone="error">{errors.summary}</Alert>
          ) : data.summary ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              {[
                ['Total parcels', data.summary.total],
                ['Delivered', data.summary.delivered],
                ['Failed', data.summary.failed],
                ['In progress', data.summary.inProgress],
                ['Success rate', percentage(data.summary.successRate)],
              ].map(([label, value]) => (
                <Card key={String(label)}>
                  <p className="text-sm text-muted">{label}</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight">
                    {typeof value === 'number' ? numberFormat.format(value) : value}
                  </p>
                </Card>
              ))}
            </div>
          ) : null}

          {errors.dailyVolume ? (
            <Alert tone="error">{errors.dailyVolume}</Alert>
          ) : data.dailyVolume ? (
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Delivery activity</h2>
                  <p className="mt-1 text-sm text-muted">
                    Creation and latest terminal events by Asia/Colombo calendar day.
                  </p>
                </div>
                <Link
                  className="text-sm font-medium text-brand hover:text-brand-dark"
                  href="/admin/reports"
                >
                  View detailed reports
                </Link>
              </div>
              {data.dailyVolume.length === 0 ? (
                <div className="mt-6">
                  <EmptyState
                    title="No delivery activity"
                    description="No daily volume data is available."
                  />
                </div>
              ) : (
                <div className="mt-6">
                  <div
                    className="mb-4 flex flex-wrap gap-4 text-xs text-muted"
                    aria-label="Chart legend"
                  >
                    <span>
                      <i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-brand" />
                      Created
                    </span>
                    <span>
                      <i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-success" />
                      Delivered
                    </span>
                    <span>
                      <i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-danger" />
                      Failed
                    </span>
                  </div>
                  <div
                    className="flex min-h-56 items-end gap-2 overflow-x-auto border-b border-line pb-2"
                    role="img"
                    aria-label="Recent daily parcel volume bar chart"
                  >
                    {data.dailyVolume.map((row) => (
                      <div
                        key={row.date}
                        className="flex min-w-12 flex-1 flex-col items-center gap-2"
                      >
                        <div className="flex h-44 items-end gap-0.5">
                          {[
                            ['Created', row.created, 'bg-brand'],
                            ['Delivered', row.delivered, 'bg-success'],
                            ['Failed', row.failed, 'bg-danger'],
                          ].map(([label, value, color]) => (
                            <div
                              key={String(label)}
                              className={`w-3 rounded-t ${color}`}
                              style={{
                                height: `${(Number(value) / maxVolume) * 100}%`,
                                minHeight: value ? '4px' : '0',
                              }}
                              title={`${label}: ${value}`}
                            />
                          ))}
                        </div>
                        <span className="text-[10px] text-muted">
                          {dateFormat.format(new Date(`${row.date}T00:00:00`))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            {errors.couriers ? (
              <Alert tone="error">{errors.couriers}</Alert>
            ) : data.couriers ? (
              <Card>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Courier performance</h2>
                    <p className="mt-1 text-sm text-muted">
                      Current workload and delivery outcomes.
                    </p>
                  </div>
                  <Link
                    className="text-sm font-medium text-brand hover:text-brand-dark"
                    href="/admin/reports"
                  >
                    Details
                  </Link>
                </div>
                <Table
                  columns={courierColumns}
                  rows={data.couriers.slice(0, 5)}
                  rowKey={(row) => row.courierId}
                  empty={
                    <EmptyState title="No courier activity" description="No assignments found." />
                  }
                />
              </Card>
            ) : null}

            <Card>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Recent audit activity</h2>
                  <p className="mt-1 text-sm text-muted">Safe administrative activity summary.</p>
                </div>
                <Link
                  className="text-sm font-medium text-brand hover:text-brand-dark"
                  href="/admin/audit"
                >
                  View all
                </Link>
              </div>
              {errors.audit ? (
                <Alert tone="error">{errors.audit}</Alert>
              ) : audit?.data.length ? (
                <ul className="divide-y divide-line">
                  {audit.data.map((entry) => (
                    <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{entry.action}</p>
                          <p className="text-xs text-muted">
                            {entry.actor?.name ?? 'System'} ·{' '}
                            {entry.actor?.role ?? entry.actorRole ?? 'SYSTEM'}
                          </p>
                        </div>
                        <time className="text-xs text-muted" dateTime={entry.timestamp}>
                          {dateTimeFormat.format(new Date(entry.timestamp))}
                        </time>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="No recent audit activity"
                  description="Administrative activity will appear here when recorded."
                />
              )}
            </Card>
          </div>
        </>
      ) : !loading ? (
        <EmptyState
          title="No overview data"
          description="There is no operational data to display."
        />
      ) : null}
    </div>
  );
}
