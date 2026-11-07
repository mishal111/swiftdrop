import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('applies filters, pagination, deterministic ordering, and safe metadata projection', async () => {
    const rows = [
      {
        id: 'audit-2',
        action: 'zone.updated',
        entityType: 'zone',
        entityId: 'zone-2',
        actorRole: 'ADMIN',
        affectedPerson: null,
        metadata: {
          changed: true,
          apiKey: 'must-not-leak',
          nested: { token: 'must-not-leak', count: 2 },
        },
        createdAt: new Date('2026-11-02T10:00:00.000Z'),
        actor: {
          id: 'admin-1',
          name: 'Ada Admin',
          email: 'admin@swiftdrop.test',
          role: 'ADMIN',
        },
      },
    ];
    const findMany = jest.fn().mockResolvedValue(rows);
    const count = jest.fn().mockResolvedValue(3);
    const prisma = {
      auditLog: { findMany, count },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (operations) => Promise.all(operations)),
    };
    const service = new AuditService(prisma as never);
    const query = {
      action: 'zone.updated',
      entityType: 'zone',
      entityId: 'zone-2',
      actorId: 'admin-1',
      from: '2026-11-01',
      to: '2026-11-02',
      page: 2,
      pageSize: 1,
      skip: 1,
      take: 1,
    };

    await expect(service.list(query)).resolves.toEqual({
      data: [
        {
          id: 'audit-2',
          action: 'zone.updated',
          entityType: 'zone',
          entityId: 'zone-2',
          actor: {
            id: 'admin-1',
            name: 'Ada Admin',
            email: 'admin@swiftdrop.test',
            role: 'ADMIN',
          },
          actorRole: 'ADMIN',
          affectedPerson: null,
          timestamp: new Date('2026-11-02T10:00:00.000Z'),
          metadata: { changed: true, nested: { count: 2 } },
        },
      ],
      meta: { page: 2, pageSize: 1, total: 3 },
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 1,
        take: 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: expect.objectContaining({
          action: 'zone.updated',
          entityType: { equals: 'zone', mode: 'insensitive' },
          entityId: 'zone-2',
          actorId: 'admin-1',
          createdAt: {
            gte: new Date('2026-10-31T18:30:00.000Z'),
            lte: new Date('2026-11-02T18:29:59.999Z'),
          },
        }),
      }),
    );
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.any(Object) }));
  });

  it('returns an empty paginated result without exposing actor data', async () => {
    const prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (operations) => Promise.all(operations)),
    };

    await expect(
      new AuditService(prisma as never).list({ page: 1, pageSize: 20, skip: 0, take: 20 }),
    ).resolves.toEqual({
      data: [],
      meta: { page: 1, pageSize: 20, total: 0 },
    });
  });

  it('returns only the minimum fields for audit user lookup', async () => {
    const userCount = jest.fn().mockResolvedValue(2);
    const userFindMany = jest.fn().mockResolvedValue([
      { id: 'user-1', name: 'Ada Admin', email: 'ada@example.com' },
      { id: 'user-2', name: 'Ada Admin', email: 'ada.duplicate@example.com' },
    ]);
    const prisma = {
      auditLog: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      user: { count: userCount, findMany: userFindMany },
      $transaction: jest.fn(),
    };

    await expect(
      new AuditService(prisma as never).listUsers({
        search: 'ada',
        page: 1,
        pageSize: 100,
        skip: 0,
        take: 100,
      }),
    ).resolves.toEqual({
      data: [
        { id: 'user-1', name: 'Ada Admin', email: 'ada@example.com' },
        { id: 'user-2', name: 'Ada Admin', email: 'ada.duplicate@example.com' },
      ],
      meta: { page: 1, pageSize: 100, total: 2 },
    });

    expect(userCount).toHaveBeenCalledWith({
      where: { name: { contains: 'ada', mode: 'insensitive' } },
    });
    expect(userFindMany).toHaveBeenCalledWith({
      where: { name: { contains: 'ada', mode: 'insensitive' } },
      skip: 0,
      take: 100,
      orderBy: [{ name: 'asc' }, { email: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, email: true },
    });
  });

  it('returns no lookup matches without exposing unrelated user fields', async () => {
    const userCount = jest.fn().mockResolvedValue(0);
    const userFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      auditLog: { findMany: jest.fn(), count: jest.fn() },
      user: { count: userCount, findMany: userFindMany },
      $transaction: jest.fn(),
    };

    await expect(
      new AuditService(prisma as never).listUsers({
        search: 'missing',
        page: 1,
        pageSize: 100,
        skip: 0,
        take: 100,
      }),
    ).resolves.toEqual({
      data: [],
      meta: { page: 1, pageSize: 100, total: 0 },
    });
    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, name: true, email: true } }),
    );
  });

  it('returns later lookup pages in the same deterministic order', async () => {
    const userCount = jest.fn().mockResolvedValue(101);
    const userFindMany = jest
      .fn()
      .mockResolvedValue([{ id: 'user-101', name: 'Ada Admin', email: 'ada.101@example.com' }]);
    const prisma = {
      auditLog: { findMany: jest.fn(), count: jest.fn() },
      user: { count: userCount, findMany: userFindMany },
      $transaction: jest.fn(),
    };

    await expect(
      new AuditService(prisma as never).listUsers({
        search: 'ada',
        page: 2,
        pageSize: 100,
        skip: 100,
        take: 100,
      }),
    ).resolves.toEqual({
      data: [{ id: 'user-101', name: 'Ada Admin', email: 'ada.101@example.com' }],
      meta: { page: 2, pageSize: 100, total: 101 },
    });
    expect(userFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 100 }));
  });
});
