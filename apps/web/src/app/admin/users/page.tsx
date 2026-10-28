import { PageHeader } from '@/components/ui';
import { AdminUsersDashboard, type UserRow } from '@/features/auth';
import { serverApi } from '@/lib/api/server';
import { requireRole } from '@/lib/auth/session';

export const metadata = { title: 'User Management' };

/**
 * Owner: M2 — Admin user management dashboard (GET/POST/PATCH /api/v1/admin/users).
 */
export default async function AdminUsersPage() {
  await requireRole(['ADMIN']);

  const api = await serverApi();
  const { data } = await api.GET('/api/v1/admin/users', {
    params: { query: { page: 1, pageSize: 100 } },
  });

  const initialUsers = (data?.data as unknown as UserRow[]) ?? [];
  const initialTotal = data?.meta?.total ?? initialUsers.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="User & Staff Management"
        description="Oversee user accounts, assign roles, create delivery staff, and manage operational permissions"
      />
      <AdminUsersDashboard initialUsers={initialUsers} initialTotal={initialTotal} />
    </div>
  );
}
