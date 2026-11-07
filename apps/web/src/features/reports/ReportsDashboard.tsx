'use client';

import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Table,
  type Column,
} from '@/components/ui';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { Role } from '@swiftdrop/contracts';
import { csvCell } from './csv';

export interface ReportZone {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

interface DeliverySummary {
  total: number;
  delivered: number;
  failed: number;
  inProgress: number;
  successRate: number;
}

interface DailyVolume {
  date: string;
  created: number;
  delivered: number;
  failed: number;
}

interface CourierPerformance {
  courierId: string;
  name: string;
  assigned: number;
  delivered: number;
  failed: number;
}

export interface ReportData {
  summary: DeliverySummary;
  dailyVolume: DailyVolume[];
  couriers: CourierPerformance[];
}

interface ReportsDashboardProps {
  role: Role;
  initialData: ReportData | null;
  initialError?: string;
  zoneError?: string;
  zones: ReportZone[];
}

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function courierSuccessRate(row: CourierPerformance): number {
  const terminalOutcomes = row.delivered + row.failed;
  return terminalOutcomes === 0 ? 0 : row.delivered / terminalOutcomes;
}

function exportCsv(data: ReportData) {
  const rows = [
    ['Daily volume'],
    ['Date', 'Created', 'Delivered', 'Failed'],
    ...data.dailyVolume.map((row) => [row.date, row.created, row.delivered, row.failed]),
    [],
    ['Courier performance'],
    ['Courier', 'Assigned', 'Delivered', 'Failed', 'Success rate'],
    ...data.couriers.map((row) => [
      row.name,
      row.assigned,
      row.delivered,
      row.failed,
      percentage(courierSuccessRate(row)),
    ]),
  ];
  const csv = rows.map((row) => row.map((cell) => csvCell(cell ?? '')).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'swiftdrop-reports.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading reports" role="status">
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

export function ReportsDashboard({
  role,
  initialData,
  initialError,
  zoneError,
  zones,
}: ReportsDashboardProps) {
  const [data, setData] = useState<ReportData | null>(initialData);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(!initialData && !initialError);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [zoneId, setZoneId] = useState('');
  const activeZones = zones.filter((zone) => zone.isActive);

  async function loadReports() {
    setLoading(true);
    setError(undefined);
    const query = {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(zoneId ? { zoneId } : {}),
    };
    // A network failure rejects instead of returning { error }; show it rather than spin forever.
    const responses = await Promise.all([
      api.GET('/api/v1/admin/reports/deliveries', { params: { query } }),
      api.GET('/api/v1/admin/reports/daily-volume', { params: { query } }),
      api.GET('/api/v1/admin/reports/couriers', {
        params: { query },
      }),
    ]).catch(() => null);
    setLoading(false);
    if (!responses) {
      setError('Could not reach the server. Check your connection and try again.');
      return;
    }
    const [summary, dailyVolume, couriers] = responses;
    const requestError = summary.error ?? dailyVolume.error ?? couriers.error;
    if (requestError || !summary.data || !dailyVolume.data || !couriers.data) {
      setError(errorMessage(requestError, 'Could not load reports'));
      return;
    }
    setData({
      summary: summary.data,
      dailyVolume: dailyVolume.data,
      couriers: couriers.data,
    });
  }

  const maxVolume = useMemo(
    () =>
      Math.max(
        1,
        ...(data?.dailyVolume.flatMap((row) => [row.created, row.delivered, row.failed]) ?? []),
      ),
    [data],
  );

  const courierColumns: Column<CourierPerformance>[] = [
    {
      header: 'Courier',
      cell: (row) => <span className="font-medium text-ink">{row.name}</span>,
    },
    { header: 'Assigned', cell: (row) => numberFormat.format(row.assigned) },
    { header: 'Delivered', cell: (row) => numberFormat.format(row.delivered) },
    { header: 'Failed', cell: (row) => numberFormat.format(row.failed) },
    { header: 'Success rate', cell: (row) => percentage(courierSuccessRate(row)) },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <form
          className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void loadReports();
          }}
        >
          <label className="text-sm font-medium">
            From
            <Input
              className="mt-1"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="text-sm font-medium">
            To
            <Input
              className="mt-1"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label className="text-sm font-medium">
            Zone
            <Select
              className="mt-1"
              value={zoneId}
              onChange={(event) => setZoneId(event.target.value)}
            >
              <option value="">All zones</option>
              {activeZones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name} ({zone.code})
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" disabled={loading}>
            {loading ? 'Loading…' : 'Apply filters'}
          </Button>
        </form>
        {zoneError ? (
          <Alert tone="error">
            <span className="mt-3 block">
              {zoneError}. Zone filtering is unavailable until the Zone Management service is
              available.
            </span>
          </Alert>
        ) : activeZones.length === 0 ? (
          <p className="mt-3 text-xs text-muted">
            No configured delivery zones are available. All zones is selected.
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          Reports use Asia/Colombo calendar days. KPI cards count unique parcels with activity in
          the range; daily rows show creation and latest terminal events. Leave dates blank for the
          last 30 days.
        </p>
      </Card>

      {loading && !data ? <LoadingSkeleton /> : null}
      {error ? (
        <Alert tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="secondary" onClick={() => void loadReports()}>
              Retry
            </Button>
          </div>
        </Alert>
      ) : null}

      {data ? (
        <>
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

          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Daily delivery volume</h2>
                <p className="mt-1 text-sm text-muted">
                  Creation and latest delivered/failed events by Colombo calendar day.
                </p>
              </div>
              <Button variant="secondary" onClick={() => exportCsv(data)}>
                Export CSV
              </Button>
            </div>
            {data.dailyVolume.length === 0 ? (
              <div className="mt-6">
                <EmptyState
                  title="No daily volume data"
                  description="Try a different date range or zone."
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
                  aria-label="Daily parcel volume bar chart"
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

          <Card>
            <div className="mb-4">
              <h2 className="text-lg font-semibold">Courier performance</h2>
              <p className="mt-1 text-sm text-muted">
                {role === 'ADMIN'
                  ? 'Delivery outcomes by courier.'
                  : 'Courier workload and delivery outcomes.'}
              </p>
            </div>
            <Table
              columns={courierColumns}
              rows={data.couriers}
              rowKey={(row) => row.courierId}
              empty={
                <EmptyState
                  title="No courier activity"
                  description="No assignments matched this date range."
                />
              }
            />
          </Card>
        </>
      ) : null}
    </div>
  );
}
