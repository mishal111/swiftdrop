import { PageHeader } from '@/components/ui';
import { AuditDashboard, type AuditLogPage } from '@/features/audit';
import { errorMessage } from '@/lib/api/errors';
import { serverApi } from '@/lib/api/server';
import { requireRole } from '@/lib/auth/session';

export const metadata = { title: 'Audit Logs' };

export default async function AdminAuditPage() {
  await requireRole(['ADMIN']);
  const api = await serverApi();
  const response = (await api.GET('/api/v1/admin/audit-logs', {
    params: { query: { page: 1, pageSize: 20 } },
  })) as unknown as { data?: unknown; error?: unknown };
  const initialData = response.data as unknown as AuditLogPage | undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Logs"
        description="Review administrative and operational activity."
      />
      <AuditDashboard
        initialData={initialData ?? null}
        initialError={
          response.error ? errorMessage(response.error, 'Could not load audit logs') : undefined
        }
      />
    </div>
  );
}
