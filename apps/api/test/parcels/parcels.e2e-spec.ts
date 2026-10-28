import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Parcel } from '@swiftdrop/db';
import request from 'supertest';
import { ParcelsService } from '../../src/modules/parcels';
import { PricingService } from '../../src/modules/pricing';
import { createTestApp, type TestContext } from '../utils/app';

const SYSTEM = { id: null, role: 'SYSTEM' } as const;

describe('parcels module (integration)', () => {
  let t: TestContext;
  let parcels: ParcelsService;

  beforeAll(async () => {
    t = await createTestApp();
    parcels = t.app.get(ParcelsService);

    // PricingService.estimate is still a stub (M7). Return a fixed fee with real seeded zones.
    const zone = await t.prisma.deliveryZone.findFirstOrThrow();
    jest.spyOn(t.app.get(PricingService), 'estimate').mockResolvedValue({
      feeCents: 52500,
      currency: 'LKR',
      pickupZoneId: zone.id,
      dropoffZoneId: zone.id,
      ruleId: 'test-rule',
      ruleName: 'Test rule',
    });
  });

  afterAll(async () => {
    await t.close();
  });

  function createParcel(): Promise<Parcel> {
    return parcels.create(
      {
        source: 'CUSTOMER',
        senderName: 'Integration Sender',
        senderPhone: '+94770000001',
        pickupAddress: '1 Test Street',
        pickupCity: 'colombo',
        recipientName: 'Integration Recipient',
        recipientPhone: '+94770000002',
        dropoffAddress: '2 Test Road',
        dropoffCity: 'kandy',
        size: 'SMALL',
        weightKg: 1.5,
      },
      'CUSTOMER',
    );
  }

  /** Moves a parcel along the happy path up to (and including) `steps`. */
  async function advance(
    parcel: Parcel,
    steps: ('PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY')[],
  ) {
    for (const to of steps) await parcels.transition(parcel.id, { to, actor: SYSTEM });
  }

  function outboxFor(parcelId: string, eventType: string) {
    return t.prisma.outboxEvent.findMany({
      where: { eventType, payload: { path: ['data', 'parcelId'], equals: parcelId } },
    });
  }

  describe('create', () => {
    it('writes the parcel, a CREATED history row and a parcel.created outbox event', async () => {
      const parcel = await createParcel();

      expect(parcel.trackingNumber).toMatch(/^SD\d{9}$/);
      expect(parcel.status).toBe('CREATED');
      expect(parcel.feeCents).toBe(52500);

      const history = await t.prisma.parcelStatusHistory.findMany({
        where: { parcelId: parcel.id },
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ fromStatus: null, toStatus: 'CREATED' });
      expect(await outboxFor(parcel.id, 'parcel.created')).toHaveLength(1);
    });
  });

  describe('transition', () => {
    it('updates status, history and outbox together', async () => {
      const parcel = await createParcel();
      const updated = await parcels.transition(parcel.id, { to: 'PICKED_UP', actor: SYSTEM });

      expect(updated.status).toBe('PICKED_UP');
      const last = await t.prisma.parcelStatusHistory.findFirstOrThrow({
        where: { parcelId: parcel.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(last).toMatchObject({ fromStatus: 'CREATED', toStatus: 'PICKED_UP' });
      expect(await outboxFor(parcel.id, 'parcel.status_changed')).toHaveLength(1);
    });

    it('rejects an invalid transition with 409 and from/to details, and writes nothing', async () => {
      const parcel = await createParcel();

      await expect(
        parcels.transition(parcel.id, { to: 'DELIVERED', actor: SYSTEM }),
      ).rejects.toMatchObject({
        code: 'INVALID_STATUS_TRANSITION',
        status: 409,
        details: { from: 'CREATED', to: 'DELIVERED' },
      });

      expect(await t.prisma.parcelStatusHistory.count({ where: { parcelId: parcel.id } })).toBe(1);
      expect(await outboxFor(parcel.id, 'parcel.status_changed')).toHaveLength(0);
    });

    it('requires a failure reason for FAILED (422)', async () => {
      const parcel = await createParcel();
      await advance(parcel, ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);

      await expect(
        parcels.transition(parcel.id, { to: 'FAILED', actor: SYSTEM }),
      ).rejects.toMatchObject({ code: 'FAILURE_REASON_REQUIRED', status: 422 });
    });

    it('requires proof of delivery for DELIVERED (422)', async () => {
      const parcel = await createParcel();
      await advance(parcel, ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);

      await expect(
        parcels.transition(parcel.id, { to: 'DELIVERED', actor: SYSTEM }),
      ).rejects.toMatchObject({ code: 'PROOF_REQUIRED', status: 422 });
    });

    it('stops re-attempts after the maximum number of delivery attempts', async () => {
      const parcel = await createParcel();
      await advance(parcel, ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);
      const fail = () =>
        parcels.transition(parcel.id, {
          to: 'FAILED',
          actor: SYSTEM,
          failureReason: 'RECIPIENT_UNAVAILABLE',
        });

      await fail();
      await advance(parcel, ['OUT_FOR_DELIVERY']); // attempt 2
      await fail();
      await advance(parcel, ['OUT_FOR_DELIVERY']); // attempt 3
      await fail();

      await expect(
        parcels.transition(parcel.id, { to: 'OUT_FOR_DELIVERY', actor: SYSTEM }),
      ).rejects.toMatchObject({ code: 'MAX_ATTEMPTS_REACHED', status: 409 });
    });

    it('lets only one of two concurrent identical transitions win', async () => {
      const parcel = await createParcel();

      const results = await Promise.allSettled([
        parcels.transition(parcel.id, { to: 'PICKED_UP', actor: SYSTEM }),
        parcels.transition(parcel.id, { to: 'PICKED_UP', actor: SYSTEM }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await t.prisma.parcelStatusHistory.count({
          where: { parcelId: parcel.id, toStatus: 'PICKED_UP' },
        }),
      ).toBe(1);
    });

    it('only records a failure reason on FAILED transitions', async () => {
      const parcel = await createParcel();
      await parcels.transition(parcel.id, {
        to: 'PICKED_UP',
        actor: SYSTEM,
        failureReason: 'RECIPIENT_UNAVAILABLE',
      });

      const last = await t.prisma.parcelStatusHistory.findFirstOrThrow({
        where: { parcelId: parcel.id, toStatus: 'PICKED_UP' },
      });
      expect(last.reason).toBeNull();
    });
  });

  describe('GET /api/v1/tracking/:trackingNumber (public)', () => {
    it('returns status and history without personal data', async () => {
      const parcel = await createParcel();
      await advance(parcel, ['PICKED_UP']);

      const res = await request(t.http)
        .get(`/api/v1/tracking/${parcel.trackingNumber}`)
        .expect(200);

      expect(res.body).toMatchObject({
        trackingNumber: parcel.trackingNumber,
        status: 'PICKED_UP',
        originCity: 'colombo',
        destinationCity: 'kandy',
      });
      expect(res.body.history.map((h: { status: string }) => h.status)).toEqual([
        'CREATED',
        'PICKED_UP',
      ]);

      const body = JSON.stringify(res.body);
      for (const secret of [
        'Integration Sender',
        'Integration Recipient',
        '+9477000000',
        'Test Street',
        'Test Road',
        parcel.id,
      ]) {
        expect(body).not.toContain(secret);
      }
    });

    it('returns 404 for an unknown tracking number', async () => {
      const res = await request(t.http).get('/api/v1/tracking/SD000000000').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/tracking/:trackingNumber/events (SSE)', () => {
    let baseUrl: string;

    beforeAll(async () => {
      const server = t.app.getHttpServer() as http.Server;
      await new Promise<void>((resolve) => server.listen(0, resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    /** Opens the stream, returns status + content type, and closes it straight away. */
    function openStream(trackingNumber: string) {
      return new Promise<{ status: number; type: string }>((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/v1/tracking/${trackingNumber}/events`, (res) => {
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']) });
          req.destroy();
        });
        req.on('error', (e) => (req.destroyed ? undefined : reject(e)));
      });
    }

    it('opens a text/event-stream for an existing parcel', async () => {
      const res = await openStream('SD100000001');
      expect(res.status).toBe(200);
      expect(res.type).toContain('text/event-stream');
    });

    it('returns 404 for an unknown tracking number', async () => {
      const res = await openStream('SD000000000');
      expect(res.status).toBe(404);
    });
  });
});
