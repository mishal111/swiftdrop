import { PageHeader } from '@/components/ui';
import { AdminOverviewDashboard, type OverviewData, type OverviewErrors } from '@/features/reports';
import { errorMessage } from '@/lib/api/errors';
import { serverApi } from '@/lib/api/server';
import { requireRole } from '@/lib/auth/session';

export const metadata = { title: 'Admin Overview' };

export default async function AdminPage() {
  await requireRole(['ADMIN']);
  const api = await serverApi();
  const [summary, dailyVolume, couriers, audit] = (await Promise.all([
    api.GET('/api/v1/admin/reports/deliveries'),
    api.GET('/api/v1/admin/reports/daily-volume'),
    api.GET('/api/v1/admin/reports/couriers'),
    api.GET('/api/v1/admin/audit-logs', {
      params: { query: { page: 1, pageSize: 5 } },
    }),
  ])) as [
    { data?: OverviewData['summary']; error?: unknown },
    { data?: OverviewData['dailyVolume']; error?: unknown },
    { data?: OverviewData['couriers']; error?: unknown },
    { data?: unknown; error?: unknown },
  ];
  const initialData: OverviewData = {
    summary: summary.data,
    dailyVolume: dailyVolume.data,
    couriers: couriers.data,
  };
  const initialErrors: OverviewErrors = {
    summary: summary.error
      ? errorMessage(summary.error, 'Could not load delivery summary')
      : undefined,
    dailyVolume: dailyVolume.error
      ? errorMessage(dailyVolume.error, 'Could not load daily delivery activity')
      : undefined,
    couriers: couriers.error
      ? errorMessage(couriers.error, 'Could not load courier performance')
      : undefined,
    audit: audit.error
      ? errorMessage(audit.error, 'Could not load recent audit activity')
      : undefined,
  };
  const auditData = audit.data as unknown as OverviewData['audit'] | undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Overview"
        description="Monitor parcel delivery operations and performance."
      />
      <AdminOverviewDashboard
        initialData={initialData}
        initialAudit={auditData ?? null}
        initialErrors={initialErrors}
      />
    </div>
  );
}
