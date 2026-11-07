import request from 'supertest';
import { AuditService } from '../../src/modules/audit';
import { createTestApp, type TestContext } from '../utils/app';

const ACTION = 'm9.audit.integration';

/** YYYY-MM-DD `days` from now, so the test doesn't expire. */
const isoDay = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('audit module (integration)', () => {
  let t: TestContext;
  let audit: AuditService;
  let adminId: string;
  let auditIds: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    audit = t.app.get(AuditService);
    const admin = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'admin@swiftdrop.test' },
    });
    adminId = admin.id;

    for (const [index, entityId] of ['m9-entity-1', 'm9-entity-2', 'm9-entity-3'].entries()) {
      await audit.record({
        actor: { id: admin.id, role: 'ADMIN' },
        action: ACTION,
        entityType: 'integration_test',
        entityId,
        metadata: {
          index,
          safe: 'visible',
          previousValue: null,
          accessToken: 'must-not-be-returned',
        },
      });
    }

    const created = await t.prisma.auditLog.findMany({
      where: { action: ACTION },
      select: { id: true },
    });
    auditIds = created.map((entry) => entry.id);
  });

  afterAll(async () => {
    await t.prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await t.close();
  });

  it('returns filtered, paginated audit records for admins', async () => {
    const response = await request(t.http)
      .get('/api/v1/admin/audit-logs')
      .query({
        action: ACTION,
        entityType: 'integration_test',
        actorId: adminId,
        from: isoDay(-1),
        to: isoDay(1),
        page: 1,
        pageSize: 2,
      })
      .set('Cookie', await t.cookieFor('ADMIN'))
      .expect(200);

    expect(response.body.data).toHaveLength(2);
    expect(response.body.meta).toEqual({ page: 1, pageSize: 2, total: 3 });
    expect(response.body.data[0]).toEqual(
      expect.objectContaining({
        action: ACTION,
        entityType: 'integration_test',
        actor: {
          id: adminId,
          name: 'Ada Admin',
          email: 'admin@swiftdrop.test',
          role: 'ADMIN',
        },
      }),
    );
    expect(response.body.data[0].metadata).toEqual(expect.objectContaining({ safe: 'visible' }));
    expect(response.body.data[0].metadata.accessToken).toBeUndefined();
    expect(response.body.data[0].metadata).toHaveProperty('previousValue', null);
    expect(response.body.data[0].timestamp).toBeDefined();
  });

  it('filters by entity and supports empty results', async () => {
    const response = await request(t.http)
      .get('/api/v1/admin/audit-logs')
      .query({ action: ACTION, entityId: 'does-not-exist' })
      .set('Cookie', await t.cookieFor('ADMIN'))
      .expect(200);

    expect(response.body).toEqual({
      data: [],
      meta: { page: 1, pageSize: 20, total: 0 },
    });
  });

  it.each(['DISPATCHER', 'CUSTOMER', 'MERCHANT', 'COURIER'] as const)(
    'rejects %s access to both endpoints (403)',
    async (role) => {
      const cookie = await t.cookieFor(role);
      await request(t.http).get('/api/v1/admin/audit-logs').set('Cookie', cookie).expect(403);
      await request(t.http)
        .get('/api/v1/admin/audit-logs/users')
        .query({ search: 'Ada' })
        .set('Cookie', cookie)
        .expect(403);
    },
  );

  it.each(['/api/v1/admin/audit-logs', '/api/v1/admin/audit-logs/users?search=Ada'])(
    '%s requires a session (401)',
    async (url) => {
      await request(t.http).get(url).expect(401);
    },
  );

  it('matches entity types regardless of case', async () => {
    const response = await request(t.http)
      .get('/api/v1/admin/audit-logs')
      .query({ action: ACTION, entityType: 'INTEGRATION_TEST' })
      .set('Cookie', await t.cookieFor('ADMIN'))
      .expect(200);
    expect(response.body.meta.total).toBe(3);
  });

  it('rejects an end date before the start date (400)', async () => {
    await request(t.http)
      .get('/api/v1/admin/audit-logs')
      .query({ from: isoDay(0), to: isoDay(-5) })
      .set('Cookie', await t.cookieFor('ADMIN'))
      .expect(400);
  });

  describe('GET /admin/audit-logs/users', () => {
    it('finds users by name for admins', async () => {
      const response = await request(t.http)
        .get('/api/v1/admin/audit-logs/users')
        .query({ search: 'ada' })
        .set('Cookie', await t.cookieFor('ADMIN'))
        .expect(200);
      expect(response.body.data).toEqual(
        expect.arrayContaining([{ id: adminId, name: 'Ada Admin', email: 'admin@swiftdrop.test' }]),
      );
    });

    it.each([{}, { search: '' }, { search: '   ' }])(
      'requires a non-blank search (400) for %o',
      async (query) => {
        await request(t.http)
          .get('/api/v1/admin/audit-logs/users')
          .query(query)
          .set('Cookie', await t.cookieFor('ADMIN'))
          .expect(400);
      },
    );
  });

  it('does not persist audit records from a rolled-back transaction', async () => {
    const entityId = 'm9-rollback';
    await expect(
      t.prisma.$transaction(async (tx) => {
        await audit.record(
          {
            actor: { id: adminId, role: 'ADMIN' },
            action: ACTION,
            entityType: 'integration_test',
            entityId,
          },
          tx,
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await t.prisma.auditLog.count({ where: { action: ACTION, entityId } })).toBe(0);
  });
});
