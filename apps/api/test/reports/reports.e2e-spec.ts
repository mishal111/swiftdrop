import type { Parcel } from '@swiftdrop/db';
import request from 'supertest';
import { createTestApp, type TestContext } from '../utils/app';

const PREFIX = 'SD990000';

describe('reports module (integration)', () => {
  let t: TestContext;
  let zoneId: string;
  let courierId: string;
  let dispatcherId: string;
  let parcelIds: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    const [zone, courier, dispatcher] = await Promise.all([
      t.prisma.deliveryZone.findUniqueOrThrow({ where: { code: 'CMB' } }),
      t.prisma.user.findUniqueOrThrow({ where: { email: 'courier1@swiftdrop.test' } }),
      t.prisma.user.findUniqueOrThrow({ where: { email: 'dispatcher@swiftdrop.test' } }),
    ]);
    zoneId = zone.id;
    courierId = courier.id;
    dispatcherId = dispatcher.id;

    const parcels: Parcel[] = [];
    parcels.push(
      await createParcel('1', 'DELIVERED', [
        { toStatus: 'CREATED', at: '2026-10-01T04:00:00.000Z' },
        { toStatus: 'DELIVERED', at: '2026-10-02T04:00:00.000Z' },
      ]),
      await createParcel('2', 'FAILED', [
        { toStatus: 'CREATED', at: '2026-10-01T05:00:00.000Z' },
        { toStatus: 'FAILED', at: '2026-10-02T05:00:00.000Z' },
      ]),
      await createParcel('3', 'IN_TRANSIT', [
        { toStatus: 'CREATED', at: '2026-10-03T05:00:00.000Z' },
      ]),
    );
    parcelIds = parcels.map((parcel) => parcel.id);

    await t.prisma.courierAssignment.create({
      data: {
        parcelId: parcels[0].id,
        courierId,
        assignedById: dispatcherId,
        status: 'COMPLETED',
        assignedAt: new Date('2026-10-01T06:00:00.000Z'),
        completedAt: new Date('2026-10-02T05:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    await t.prisma.parcel.deleteMany({ where: { id: { in: parcelIds } } });
    await t.close();
  });

  async function createParcel(
    suffix: string,
    status: 'DELIVERED' | 'FAILED' | 'IN_TRANSIT',
    history: { toStatus: 'CREATED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED'; at: string }[],
  ): Promise<Parcel> {
    const customer = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'customer@swiftdrop.test' },
    });
    return t.prisma.parcel.create({
      data: {
        trackingNumber: `${PREFIX}${suffix}`,
        status,
        customerId: customer.id,
        pickupZoneId: zoneId,
        dropoffZoneId: zoneId,
        senderName: 'Report Sender',
        senderPhone: '+94770000001',
        pickupAddress: 'Report Pickup',
        pickupCity: 'colombo',
        recipientName: 'Report Recipient',
        recipientPhone: '+94770000002',
        dropoffAddress: 'Report Dropoff',
        dropoffCity: 'colombo',
        size: 'SMALL',
        weightKg: 1,
        feeCents: 500,
        createdAt: new Date(history[0].at),
        deliveredAt:
          status === 'DELIVERED'
            ? new Date([...history].reverse().find((h) => h.toStatus === 'DELIVERED')!.at)
            : null,
        statusHistory: {
          create: history.map((entry, index) => ({
            fromStatus: index === 0 ? null : history[index - 1].toStatus,
            toStatus: entry.toStatus,
            actorRole: 'SYSTEM',
            createdAt: new Date(entry.at),
          })),
        },
      },
    });
  }

  it('returns delivery summary, daily volume, and courier performance', async () => {
    const cookie = await t.cookieFor('ADMIN');
    const query = { from: '2026-10-01', to: '2026-10-03', zoneId };

    const summary = await request(t.http)
      .get('/api/v1/admin/reports/deliveries')
      .query(query)
      .set('Cookie', cookie)
      .expect(200);
    expect(summary.body).toEqual({
      total: 3,
      delivered: 1,
      failed: 1,
      inProgress: 1,
      successRate: 0.5,
    });

    const daily = await request(t.http)
      .get('/api/v1/admin/reports/daily-volume')
      .query(query)
      .set('Cookie', cookie)
      .expect(200);
    expect(daily.body).toEqual([
      { date: '2026-10-01', created: 2, delivered: 0, failed: 0 },
      { date: '2026-10-02', created: 0, delivered: 1, failed: 1 },
      { date: '2026-10-03', created: 1, delivered: 0, failed: 0 },
    ]);

    const couriers = await request(t.http)
      .get('/api/v1/admin/reports/couriers')
      .query({ from: query.from, to: query.to })
      .set('Cookie', cookie)
      .expect(200);
    // Filter to this courier: other suites may add assignments to the shared test DB.
    expect(couriers.body.filter((c: { courierId: string }) => c.courierId === courierId)).toEqual([
      { courierId, name: 'Chamal Courier', assigned: 1, delivered: 1, failed: 0 },
    ]);
  });

  it('allows dispatchers and rejects customers', async () => {
    await request(t.http)
      .get('/api/v1/admin/reports/deliveries')
      .set('Cookie', await t.cookieFor('DISPATCHER'))
      .expect(200);
    await request(t.http)
      .get('/api/v1/admin/reports/deliveries')
      .set('Cookie', await t.cookieFor('CUSTOMER'))
      .expect(403);
  });

  it('rejects ranges longer than 366 days', async () => {
    await request(t.http)
      .get('/api/v1/admin/reports/deliveries')
      .query({ from: '2025-01-01', to: '2026-01-02' })
      .set('Cookie', await t.cookieFor('ADMIN'))
      .expect(400)
      .expect((response) => {
        expect(response.body.error.code).toBe('VALIDATION_FAILED');
      });
  });

  describe('re-attempts and reassignment', () => {
    // A separate week, so the first test's totals are unaffected.
    const range = { from: '2026-09-10', to: '2026-09-12' };
    let courier2Id: string;

    beforeAll(async () => {
      courier2Id = (
        await t.prisma.user.findUniqueOrThrow({ where: { email: 'courier2@swiftdrop.test' } })
      ).id;
      // Courier 1 fails the first attempt, the parcel is reassigned, courier 2 delivers it.
      const parcel = await createParcel('4', 'DELIVERED', [
        { toStatus: 'CREATED', at: '2026-09-10T03:00:00.000Z' },
        { toStatus: 'FAILED', at: '2026-09-10T08:00:00.000Z' },
        { toStatus: 'OUT_FOR_DELIVERY', at: '2026-09-11T03:00:00.000Z' },
        { toStatus: 'DELIVERED', at: '2026-09-11T06:00:00.000Z' },
      ]);
      parcelIds.push(parcel.id);
      await t.prisma.courierAssignment.createMany({
        data: [
          {
            parcelId: parcel.id,
            courierId,
            assignedById: dispatcherId,
            status: 'CANCELLED',
            assignedAt: new Date('2026-09-10T04:00:00.000Z'),
          },
          {
            parcelId: parcel.id,
            courierId: courier2Id,
            assignedById: dispatcherId,
            status: 'COMPLETED',
            assignedAt: new Date('2026-09-10T09:00:00.000Z'),
            completedAt: new Date('2026-09-11T06:00:00.000Z'),
          },
        ],
      });
    });

    it('counts a parcel that failed and was then delivered once, as delivered', async () => {
      const res = await request(t.http)
        .get('/api/v1/admin/reports/deliveries')
        .query({ ...range, zoneId })
        .set('Cookie', await t.cookieFor('ADMIN'))
        .expect(200);
      expect(res.body).toMatchObject({ total: 1, delivered: 1, failed: 0, inProgress: 0 });
    });

    it('credits the failure to the first courier and the delivery to the second', async () => {
      const res = await request(t.http)
        .get('/api/v1/admin/reports/couriers')
        .query({ ...range, zoneId })
        .set('Cookie', await t.cookieFor('ADMIN'))
        .expect(200);
      const byId = new Map(
        res.body.map((c: { courierId: string }) => [c.courierId, c] as [string, unknown]),
      );
      expect(byId.get(courierId)).toMatchObject({ assigned: 1, delivered: 0, failed: 1 });
      expect(byId.get(courier2Id)).toMatchObject({ assigned: 1, delivered: 1, failed: 0 });
    });
  });

  describe('negative cases', () => {
    const ENDPOINTS = ['deliveries', 'daily-volume', 'couriers'];

    it.each(ENDPOINTS)('GET /admin/reports/%s requires a session (401)', async (path) => {
      await request(t.http).get(`/api/v1/admin/reports/${path}`).expect(401);
    });

    it.each(['MERCHANT', 'COURIER', 'CUSTOMER'] as const)(
      'rejects the %s role (403)',
      async (role) => {
        const cookie = await t.cookieFor(role);
        for (const path of ENDPOINTS) {
          await request(t.http)
            .get(`/api/v1/admin/reports/${path}`)
            .set('Cookie', cookie)
            .expect(403);
        }
      },
    );

    it.each([
      { from: '2026-10-05', to: '2026-10-01' },
      { from: 'not-a-date', to: '2026-10-01' },
    ])('rejects an invalid range %o (400)', async (query) => {
      await request(t.http)
        .get('/api/v1/admin/reports/deliveries')
        .query(query)
        .set('Cookie', await t.cookieFor('ADMIN'))
        .expect(400);
    });
  });
});
