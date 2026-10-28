/**
 * Role-level authorization smoke tests for the whole API surface.
 * Every module owner ADDS object-level negative tests in test/<module>/ (see docs/conventions/testing.md).
 * Coordinated by M2. Reference: docs/contracts/authorization-matrix.md
 */
import { ROLES, type Role } from '@swiftdrop/contracts';
import request from 'supertest';
import { createTestApp, type TestContext } from '../utils/app';

describe('authorization matrix (role level)', () => {
  let t: TestContext;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  describe('Unauthenticated requests (401 UNAUTHENTICATED)', () => {
    it.each([
      ['get', '/api/v1/users/me'],
      ['patch', '/api/v1/users/me'],
      ['get', '/api/v1/admin/users'],
      ['get', '/api/v1/admin/merchants'],
      ['get', '/api/v1/admin/reports/deliveries'],
      ['get', '/api/v1/admin/audit-logs'],
      ['get', '/api/v1/admin/ops/outbox'],
      ['get', '/api/v1/admin/zones'],
      ['get', '/api/v1/admin/pricing-rules'],
      ['get', '/api/v1/dispatch/unassigned'],
      ['get', '/api/v1/dispatch/couriers/workload'],
      ['get', '/api/v1/courier/parcels'],
      ['get', '/api/v1/merchants/me'],
      ['get', '/api/v1/merchants/me/api-keys'],
      ['get', '/api/v1/merchants/me/webhooks'],
      ['get', '/api/v1/parcels/mine'],
    ] as const)(
      'rejects unauthenticated %s %s with 401 and error envelope',
      async (method, path) => {
        const res = await request(t.http)[method](path).expect(401);
        expect(res.body).toEqual({
          error: expect.objectContaining({
            code: 'UNAUTHENTICATED',
            requestId: expect.any(String),
          }),
        });
      },
    );
  });

  describe('Public endpoints (@Public)', () => {
    it('allows unauthenticated access to health check', async () => {
      // 200 or 503 depending on whether RabbitMQ has connected yet; either way it is not a 401.
      const res = await request(t.http).get('/api/v1/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body.checks.db).toBe(true);
    });

    it('allows unauthenticated access to pricing estimate', async () => {
      const res = await request(t.http).post('/api/v1/pricing/estimate').send({
        pickupCity: 'colombo',
        dropoffCity: 'kandy',
        weightKg: 2,
        size: 'SMALL',
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect([200, 501]).toContain(res.status);
    });

    it('allows unauthenticated access to public parcel tracking (passes auth)', async () => {
      const res = await request(t.http).get('/api/v1/tracking/SD100000001');
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect([200, 501]).toContain(res.status);
    });
  });

  describe('Universal authenticated user access (/users/me)', () => {
    it.each(ROLES)(
      'allows %s to access /users/me and never leaks passwordHash',
      async (role: Role) => {
        const res = await request(t.http)
          .get('/api/v1/users/me')
          .set('Cookie', await t.cookieFor(role))
          .expect(200);
        expect(res.body).toMatchObject({ role });
        expect(res.body.passwordHash).toBeUndefined();
      },
    );

    it('allows any signed-in user to PATCH /users/me', async () => {
      const res = await request(t.http)
        .patch('/api/v1/users/me')
        .set('Cookie', await t.cookieFor('CUSTOMER'))
        .send({ name: 'Updated Matrix Customer' })
        .expect(200);
      expect(res.body.name).toBe('Updated Matrix Customer');
    });
  });

  describe('Role-Based Access Control Boundaries (403 FORBIDDEN)', () => {
    it.each([
      // CUSTOMER cannot access staff/merchant/admin areas
      ['CUSTOMER', 'get', '/api/v1/dispatch/unassigned'],
      ['CUSTOMER', 'get', '/api/v1/dispatch/couriers/workload'],
      ['CUSTOMER', 'get', '/api/v1/courier/parcels'],
      ['CUSTOMER', 'get', '/api/v1/merchants/me'],
      ['CUSTOMER', 'get', '/api/v1/merchants/me/api-keys'],
      ['CUSTOMER', 'get', '/api/v1/admin/users'],
      ['CUSTOMER', 'get', '/api/v1/admin/merchants'],
      ['CUSTOMER', 'get', '/api/v1/admin/reports/deliveries'],
      ['CUSTOMER', 'get', '/api/v1/admin/audit-logs'],
      ['CUSTOMER', 'get', '/api/v1/admin/ops/outbox'],
      ['CUSTOMER', 'get', '/api/v1/admin/zones'],
      ['CUSTOMER', 'get', '/api/v1/admin/pricing-rules'],

      // COURIER cannot access booking, dispatch, merchant, or admin areas
      ['COURIER', 'post', '/api/v1/parcels'],
      ['COURIER', 'get', '/api/v1/parcels/mine'],
      ['COURIER', 'get', '/api/v1/dispatch/unassigned'],
      ['COURIER', 'get', '/api/v1/dispatch/couriers/workload'],
      ['COURIER', 'get', '/api/v1/merchants/me'],
      ['COURIER', 'get', '/api/v1/admin/users'],
      ['COURIER', 'get', '/api/v1/admin/merchants'],
      ['COURIER', 'get', '/api/v1/admin/reports/deliveries'],
      ['COURIER', 'get', '/api/v1/admin/audit-logs'],
      ['COURIER', 'get', '/api/v1/admin/ops/outbox'],
      ['COURIER', 'get', '/api/v1/admin/zones'],
      ['COURIER', 'get', '/api/v1/admin/pricing-rules'],

      // MERCHANT cannot access courier, dispatch, customer bookings, or admin areas
      ['MERCHANT', 'get', '/api/v1/courier/parcels'],
      ['MERCHANT', 'get', '/api/v1/dispatch/unassigned'],
      ['MERCHANT', 'get', '/api/v1/dispatch/couriers/workload'],
      ['MERCHANT', 'post', '/api/v1/parcels'],
      ['MERCHANT', 'get', '/api/v1/parcels/mine'],
      ['MERCHANT', 'get', '/api/v1/admin/users'],
      ['MERCHANT', 'get', '/api/v1/admin/merchants'],
      ['MERCHANT', 'get', '/api/v1/admin/reports/deliveries'],
      ['MERCHANT', 'get', '/api/v1/admin/audit-logs'],
      ['MERCHANT', 'get', '/api/v1/admin/ops/outbox'],
      ['MERCHANT', 'get', '/api/v1/admin/zones'],
      ['MERCHANT', 'get', '/api/v1/admin/pricing-rules'],
      ['MERCHANT', 'get', '/api/v1/parcels/dummy-parcel-id/proof/photo'],

      // DISPATCHER cannot access admin-only areas, merchant portal, courier workflow, or customer booking
      ['DISPATCHER', 'get', '/api/v1/admin/users'],
      ['DISPATCHER', 'post', '/api/v1/admin/users'],
      ['DISPATCHER', 'get', '/api/v1/admin/merchants'],
      ['DISPATCHER', 'get', '/api/v1/admin/audit-logs'],
      ['DISPATCHER', 'get', '/api/v1/admin/ops/outbox'],
      ['DISPATCHER', 'get', '/api/v1/merchants/me'],
      ['DISPATCHER', 'get', '/api/v1/courier/parcels'],
      ['DISPATCHER', 'post', '/api/v1/parcels'],
      ['DISPATCHER', 'get', '/api/v1/parcels/mine'],
    ] as const)('%s cannot %s %s (403 FORBIDDEN)', async (role: Role, method, path) => {
      const res = await request(t.http)
        [method](path)
        .set('Cookie', await t.cookieFor(role));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Positive Authorization for Legitimate Roles', () => {
    it('allows DISPATCHER to view dispatch and operational report endpoints', async () => {
      const cookie = await t.cookieFor('DISPATCHER');

      for (const endpoint of [
        '/api/v1/dispatch/unassigned',
        '/api/v1/dispatch/couriers/workload',
        '/api/v1/admin/reports/deliveries',
        '/api/v1/admin/zones',
        '/api/v1/admin/pricing-rules',
      ]) {
        const res = await request(t.http).get(endpoint).set('Cookie', cookie);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect([200, 501]).toContain(res.status);
      }
    });

    it('allows ADMIN to access all administrative management surfaces', async () => {
      const cookie = await t.cookieFor('ADMIN');

      // Fully implemented administrative endpoints return 200
      await request(t.http).get('/api/v1/admin/users').set('Cookie', cookie).expect(200);
      await request(t.http).get('/api/v1/admin/ops/outbox').set('Cookie', cookie).expect(200);

      // Other module endpoints pass role auth (reach handler returning 200 or 501 stub)
      for (const endpoint of [
        '/api/v1/admin/reports/deliveries',
        '/api/v1/admin/zones',
        '/api/v1/admin/pricing-rules',
        '/api/v1/admin/merchants',
        '/api/v1/admin/audit-logs',
        '/api/v1/dispatch/unassigned',
      ]) {
        const res = await request(t.http).get(endpoint).set('Cookie', cookie);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expect([200, 501]).toContain(res.status);
      }
    });

    it('allows COURIER to pass authorization for courier endpoints', async () => {
      const cookie = await t.cookieFor('COURIER');
      const res = await request(t.http).get('/api/v1/courier/parcels').set('Cookie', cookie);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect([200, 501]).toContain(res.status);

      const historyRes = await request(t.http).get('/api/v1/courier/history').set('Cookie', cookie);
      expect(historyRes.status).not.toBe(401);
      expect(historyRes.status).not.toBe(403);
      expect([200, 501]).toContain(historyRes.status);
    });

    it('allows MERCHANT to pass authorization for merchant portal endpoints', async () => {
      const cookie = await t.cookieFor('MERCHANT');
      const meRes = await request(t.http).get('/api/v1/merchants/me').set('Cookie', cookie);
      expect(meRes.status).not.toBe(401);
      expect(meRes.status).not.toBe(403);
      expect([200, 501]).toContain(meRes.status);

      const keysRes = await request(t.http)
        .get('/api/v1/merchants/me/api-keys')
        .set('Cookie', cookie);
      expect(keysRes.status).not.toBe(401);
      expect(keysRes.status).not.toBe(403);
      expect([200, 501]).toContain(keysRes.status);

      const webhooksRes = await request(t.http)
        .get('/api/v1/merchants/me/webhooks')
        .set('Cookie', cookie);
      expect(webhooksRes.status).not.toBe(401);
      expect(webhooksRes.status).not.toBe(403);
      expect([200, 501]).toContain(webhooksRes.status);
    });

    it('allows CUSTOMER to pass authorization for customer bookings', async () => {
      const cookie = await t.cookieFor('CUSTOMER');
      const res = await request(t.http).get('/api/v1/parcels/mine').set('Cookie', cookie);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect([200, 501]).toContain(res.status);
    });
  });

  describe('Merchant Partner API Authentication (X-Api-Key)', () => {
    it('rejects merchant API calls without an API key (401 INVALID_API_KEY)', async () => {
      const res = await request(t.http).get('/api/v1/merchant/parcels').expect(401);
      expect(res.body.error.code).toBe('INVALID_API_KEY');
    });

    it('does not accept user session cookies in place of an X-Api-Key (401 INVALID_API_KEY)', async () => {
      const merchantCookie = await t.cookieFor('MERCHANT');
      const res = await request(t.http)
        .get('/api/v1/merchant/parcels')
        .set('Cookie', merchantCookie)
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_API_KEY');
    });
  });

  describe('Request validation and error handling', () => {
    it('validates request bodies (400 VALIDATION_FAILED)', async () => {
      const res = await request(t.http)
        .post('/api/v1/pricing/estimate')
        .send({ pickupCity: 'colombo', size: 'HUGE' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
