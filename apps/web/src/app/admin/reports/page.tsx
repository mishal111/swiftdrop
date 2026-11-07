import { PageHeader } from '@/components/ui';
import { ReportsDashboard, type ReportData, type ReportZone } from '@/features/reports';
import { errorMessage } from '@/lib/api/errors';
import { serverApi } from '@/lib/api/server';
import { requireRole } from '@/lib/auth/session';

export const metadata = { title: 'Reports' };

export default async function AdminReportsPage() {
  const user = await requireRole(['ADMIN', 'DISPATCHER']);
  const api = await serverApi();
  const [summary, dailyVolume, couriers, zones] = await Promise.all([
    api.GET('/api/v1/admin/reports/deliveries'),
    api.GET('/api/v1/admin/reports/daily-volume'),
    api.GET('/api/v1/admin/reports/couriers'),
    api.GET('/api/v1/admin/zones'),
  ]);

  const reportError = summary.error ?? dailyVolume.error ?? couriers.error;
  const zoneResponse = zones as unknown as { data?: ReportZone[]; error?: unknown };
  const zoneError = zoneResponse.error
    ? errorMessage(zoneResponse.error, 'Could not load delivery zones')
    : undefined;
  const initialData: ReportData | null =
    summary.data && dailyVolume.data && couriers.data
      ? {
          summary: summary.data,
          dailyVolume: dailyVolume.data,
          couriers: couriers.data,
        }
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={
          user.role === 'ADMIN'
            ? 'Operational delivery performance and courier insights'
            : 'Operational delivery and courier workload insights'
        }
      />
      <ReportsDashboard
        role={user.role}
        initialData={initialData}
        initialError={reportError ? errorMessage(reportError, 'Could not load reports') : undefined}
        zoneError={zoneError}
        zones={zoneResponse.data ?? []}
      />
    </div>
  );
}
