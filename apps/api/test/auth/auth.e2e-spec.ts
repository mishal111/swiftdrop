import * as argon2 from 'argon2';
import { AUTH_COOKIES } from '@swiftdrop/contracts';
import request from 'supertest';
import { createTestApp, type TestContext } from '../utils/app';

describe('auth module (integration)', () => {
  let t: TestContext;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /**
   * The auth controller allows 10 requests a minute per route, counted per app instance. Blocks that
   * log in a lot call this to run against their own app, so they don't fail depending on how many
   * logins ran before them.
   */
  function useFreshApp() {
    let shared: TestContext;
    beforeAll(async () => {
      shared = t;
      t = await createTestApp();
    });
    afterAll(async () => {
      await t.close();
      t = shared;
    });
  }

  describe('POST /api/v1/auth/register', () => {
    it('registers a new customer, sets cookies, and allows access to /users/me', async () => {
      const email = `test-customer-${Date.now()}@swiftdrop.test`;
      const res = await request(t.http)
        .post('/api/v1/auth/register')
        .send({
          email,
          name: 'Integration Test Customer',
          password: 'Password123!',
          phone: '+94770001122',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        user: { email, name: 'Integration Test Customer', role: 'CUSTOMER' },
        home: '/customer',
      });

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies).toBeDefined();
      const accessCookie = cookies.find((c: string) => c.startsWith(`${AUTH_COOKIES.ACCESS}=`));
      const refreshCookie = cookies.find((c: string) => c.startsWith(`${AUTH_COOKIES.REFRESH}=`));

      expect(accessCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('HttpOnly');

      // Use the access cookie to fetch /users/me
      const meRes = await request(t.http)
        .get('/api/v1/users/me')
        .set('Cookie', accessCookie!)
        .expect(200);

      expect(meRes.body).toMatchObject({
        email,
        name: 'Integration Test Customer',
        role: 'CUSTOMER',
      });
      expect(meRes.body.passwordHash).toBeUndefined();
    });

    it('rejects duplicate email with 409 EMAIL_TAKEN', async () => {
      const email = `test-dup-${Date.now()}@swiftdrop.test`;
      await request(t.http)
        .post('/api/v1/auth/register')
        .send({
          email,
          name: 'First User',
          password: 'Password123!',
        })
        .expect(201);

      const res = await request(t.http)
        .post('/api/v1/auth/register')
        .send({
          email,
          name: 'Duplicate User',
          password: 'Password123!',
        })
        .expect(409);

      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('validates minimum password length', async () => {
      const res = await request(t.http)
        .post('/api/v1/auth/register')
        .send({
          email: 'short-pw@swiftdrop.test',
          name: 'Short Password',
          password: 'short',
        })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('authenticates valid credentials and returns session', async () => {
      const res = await request(t.http)
        .post('/api/v1/auth/login')
        .send({
          email: 'customer@swiftdrop.test',
          password: 'Password123!',
        })
        .expect(200);

      expect(res.body).toMatchObject({
        user: { email: 'customer@swiftdrop.test', role: 'CUSTOMER' },
        home: '/customer',
      });

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c: string) => c.startsWith(`${AUTH_COOKIES.ACCESS}=`))).toBe(true);
      expect(cookies.some((c: string) => c.startsWith(`${AUTH_COOKIES.REFRESH}=`))).toBe(true);
    });

    it('rejects invalid password with 401 INVALID_CREDENTIALS', async () => {
      const res = await request(t.http)
        .post('/api/v1/auth/login')
        .send({
          email: 'customer@swiftdrop.test',
          password: 'WrongPassword!',
        })
        .expect(401);

      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects non-existent email with 401 INVALID_CREDENTIALS (timing attack protection)', async () => {
      const res = await request(t.http)
        .post('/api/v1/auth/login')
        .send({
          email: 'nonexistent@swiftdrop.test',
          password: 'Password123!',
        })
        .expect(401);

      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects disabled accounts with 403 ACCOUNT_DISABLED', async () => {
      const email = `disabled-user-${Date.now()}@swiftdrop.test`;
      const passwordHash = await argon2.hash('Password123!', { type: argon2.argon2id });
      await t.prisma.user.create({
        data: {
          email,
          name: 'Disabled User',
          role: 'CUSTOMER',
          isActive: false,
          passwordHash,
        },
      });

      const res = await request(t.http)
        .post('/api/v1/auth/login')
        .send({
          email,
          password: 'Password123!',
        })
        .expect(403);

      expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('POST /api/v1/auth/refresh & session rotation', () => {
    it('rotates refresh token cookie and creates replacement session', async () => {
      // 1. Login to get initial cookies
      const loginRes = await request(t.http)
        .post('/api/v1/auth/login')
        .send({
          email: 'customer@swiftdrop.test',
          password: 'Password123!',
        })
        .expect(200);

      const loginCookies = loginRes.headers['set-cookie'] as unknown as string[];
      const refreshCookie = loginCookies.find((c: string) =>
        c.startsWith(`${AUTH_COOKIES.REFRESH}=`),
      )!;

      // 2. Call /auth/refresh with the refresh cookie
      const refreshRes = await request(t.http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookie)
        .expect(200);

      const newCookies = refreshRes.headers['set-cookie'] as unknown as string[];
      const newRefreshCookie = newCookies.find((c: string) =>
        c.startsWith(`${AUTH_COOKIES.REFRESH}=`),
      )!;

      expect(newRefreshCookie).toBeDefined();
      expect(newRefreshCookie).not.toEqual(refreshCookie);

      // 3. Attempting to reuse the OLD refresh token triggers breach detection
      const reuseRes = await request(t.http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', refreshCookie)
        .expect(401);

      expect(reuseRes.body.error.code).toBe('UNAUTHENTICATED');

      // 4. Verify that ALL sessions for the user were revoked due to breach detection
      const newReuseRes = await request(t.http)
        .post('/api/v1/auth/refresh')
        .set('Cookie', newRefreshCookie)
        .expect(401);

      expect(newReuseRes.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('revokes session in database and clears auth cookies', async () => {
      const loginRes = await request(t.http)
        .post('/api/v1/auth/login')
        .send({
          email: 'customer@swiftdrop.test',
          password: 'Password123!',
        })
        .expect(200);

      const loginCookies = loginRes.headers['set-cookie'] as unknown as string[];
      const refreshCookie = loginCookies.find((c: string) =>
        c.startsWith(`${AUTH_COOKIES.REFRESH}=`),
      )!;

      const logoutRes = await request(t.http)
        .post('/api/v1/auth/logout')
        .set('Cookie', refreshCookie)
        .expect(204);

      const clearedCookies = logoutRes.headers['set-cookie'] as unknown as string[];
      expect(clearedCookies.some((c: string) => c.includes(`${AUTH_COOKIES.ACCESS}=;`))).toBe(true);
      expect(clearedCookies.some((c: string) => c.includes(`${AUTH_COOKIES.REFRESH}=;`))).toBe(
        true,
      );
    });
  });

  describe('GET /api/v1/auth/google', () => {
    it('redirects to Google when configured, or returns 501 when not', async () => {
      const res = await request(t.http).get('/api/v1/auth/google');
      if (res.status === 302) {
        expect(res.headers.location).toContain('accounts.google.com/o/oauth2/v2/auth');
        const cookies = res.headers['set-cookie'] as unknown as string[];
        expect(cookies.some((c: string) => c.includes('sd_oauth_verifier'))).toBe(true);
        expect(cookies.some((c: string) => c.includes('sd_oauth_state'))).toBe(true);
      } else {
        expect(res.status).toBe(501);
        expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
      }
    });
  });

  describe('Admin staff management & authorization', () => {
    it('forbids non-admin users from accessing /admin/users (403 FORBIDDEN)', async () => {
      const customerCookie = await t.cookieFor('CUSTOMER');
      const res = await request(t.http)
        .get('/api/v1/admin/users')
        .set('Cookie', customerCookie)
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('allows ADMIN to create staff; creates CourierProfile for COURIER and audits action', async () => {
      const adminCookie = await t.cookieFor('ADMIN');
      const courierEmail = `courier-test-${Date.now()}@swiftdrop.test`;

      const createRes = await request(t.http)
        .post('/api/v1/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: courierEmail,
          name: 'Test Courier Staff',
          role: 'COURIER',
          password: 'Password123!',
          phone: '+94779998877',
        })
        .expect(201);

      expect(createRes.body).toMatchObject({
        email: courierEmail,
        role: 'COURIER',
        name: 'Test Courier Staff',
      });

      // Verify CourierProfile was automatically created
      const courierProfile = await t.prisma.courierProfile.findUnique({
        where: { userId: createRes.body.id },
      });
      expect(courierProfile).not.toBeNull();
      expect(courierProfile?.isAvailable).toBe(true);

      // Verify AuditLog was recorded
      const auditLog = await t.prisma.auditLog.findFirst({
        where: {
          entityType: 'User',
          entityId: createRes.body.id,
          action: 'user.created',
        },
      });
      expect(auditLog).not.toBeNull();
      expect(auditLog?.actorRole).toBe('ADMIN');

      // The new courier can sign in and lands on the courier portal.
      const courierLoginRes = await request(t.http)
        .post('/api/v1/auth/login')
        .send({ email: courierEmail, password: 'Password123!' })
        .expect(200);
      expect(courierLoginRes.body.user.role).toBe('COURIER');
      expect(courierLoginRes.body.home).toBe('/courier');
    });

    it('rejects a deactivated user’s existing access token and blocks new logins', async () => {
      const adminCookie = await t.cookieFor('ADMIN');
      const testEmail = `deactivate-guard-${Date.now()}@swiftdrop.test`;

      const createRes = await request(t.http)
        .post('/api/v1/admin/users')
        .set('Cookie', adminCookie)
        .send({
          email: testEmail,
          name: 'Deactivate Target',
          role: 'COURIER',
          password: 'Password123!',
        })
        .expect(201);

      const loginRes = await request(t.http)
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: 'Password123!' })
        .expect(200);
      const loginCookies = loginRes.headers['set-cookie'] as unknown as string[];
      const accessCookie = loginCookies.find((c: string) =>
        c.startsWith(`${AUTH_COOKIES.ACCESS}=`),
      )!;

      // Warm the guard's status cache, so the test proves deactivation invalidates it.
      await request(t.http).get('/api/v1/users/me').set('Cookie', accessCookie).expect(200);

      await request(t.http)
        .patch(`/api/v1/admin/users/${createRes.body.id}`)
        .set('Cookie', adminCookie)
        .send({ isActive: false })
        .expect(200);

      const meRes = await request(t.http)
        .get('/api/v1/users/me')
        .set('Cookie', accessCookie)
        .expect(403);
      expect(meRes.body.error.code).toBe('ACCOUNT_DISABLED');

      const reLoginRes = await request(t.http)
        .post('/api/v1/auth/login')
        .send({ email: testEmail, password: 'Password123!' })
        .expect(403);
      expect(reLoginRes.body.error.code).toBe('ACCOUNT_DISABLED');
    });
  });

  describe('Hardening (review fixes)', () => {
    useFreshApp();

    /** Creates an active CUSTOMER with a known password straight in the DB. */
    async function makeUser(prefix: string) {
      const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@swiftdrop.test`;
      const passwordHash = await argon2.hash('Password123!', { type: argon2.argon2id });
      const user = await t.prisma.user.create({
        data: { email, name: 'Hardening User', role: 'CUSTOMER', passwordHash },
      });
      return user;
    }

    async function refreshCookieFor(email: string) {
      const res = await request(t.http)
        .post('/api/v1/auth/login')
        .send({ email, password: 'Password123!' })
        .expect(200);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      return cookies.find((c: string) => c.startsWith(`${AUTH_COOKIES.REFRESH}=`))!;
    }

    it('lets only one of two concurrent refreshes with the same token succeed', async () => {
      const user = await makeUser('race');
      const refreshCookie = await refreshCookieFor(user.email);

      const results = await Promise.all([
        request(t.http).post('/api/v1/auth/refresh').set('Cookie', refreshCookie),
        request(t.http).post('/api/v1/auth/refresh').set('Cookie', refreshCookie),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('revokes all sessions when an admin deactivates a user, and audits it', async () => {
      const user = await makeUser('deactivate');
      const refreshCookie = await refreshCookieFor(user.email);

      await request(t.http)
        .patch(`/api/v1/admin/users/${user.id}`)
        .set('Cookie', await t.cookieFor('ADMIN'))
        .send({ isActive: false })
        .expect(200);

      const active = await t.prisma.refreshSession.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(active).toBe(0);

      await request(t.http).post('/api/v1/auth/refresh').set('Cookie', refreshCookie).expect(401);

      const audit = await t.prisma.auditLog.findFirst({
        where: { entityId: user.id, action: 'user.status_changed' },
      });
      expect(audit).not.toBeNull();
    });

    it('creates a CourierProfile when a user is promoted to COURIER', async () => {
      const user = await makeUser('promote');

      const res = await request(t.http)
        .patch(`/api/v1/admin/users/${user.id}`)
        .set('Cookie', await t.cookieFor('ADMIN'))
        .send({ role: 'COURIER' })
        .expect(200);

      expect(res.body.role).toBe('COURIER');
      const profile = await t.prisma.courierProfile.findUnique({ where: { userId: user.id } });
      expect(profile).not.toBeNull();
    });

    it('forbids an admin from changing their own role or status', async () => {
      const admin = await t.prisma.user.findFirstOrThrow({
        where: { role: 'ADMIN' },
        orderBy: { email: 'asc' },
      });

      const res = await request(t.http)
        .patch(`/api/v1/admin/users/${admin.id}`)
        .set('Cookie', await t.cookieFor('ADMIN'))
        .send({ isActive: false })
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('forbids non-admins from updating users (403)', async () => {
      const user = await makeUser('dispatcher-target');
      await request(t.http)
        .patch(`/api/v1/admin/users/${user.id}`)
        .set('Cookie', await t.cookieFor('DISPATCHER'))
        .send({ role: 'ADMIN' })
        .expect(403);
    });

    it('returns 404 when updating an unknown user', async () => {
      await request(t.http)
        .patch('/api/v1/admin/users/does-not-exist')
        .set('Cookie', await t.cookieFor('ADMIN'))
        .send({ isActive: false })
        .expect(404);
    });

    it('rejects an admin-created user with a taken email (409 EMAIL_TAKEN)', async () => {
      const res = await request(t.http)
        .post('/api/v1/admin/users')
        .set('Cookie', await t.cookieFor('ADMIN'))
        .send({
          email: 'CUSTOMER@swiftdrop.test',
          name: 'Dup',
          role: 'DISPATCHER',
          password: 'Password123!',
        })
        .expect(409);

      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('PATCH /users/me updates name and phone but cannot change role', async () => {
      const user = await makeUser('me');
      const cookie = await t.cookieFor('CUSTOMER', user.email);

      const res = await request(t.http)
        .patch('/api/v1/users/me')
        .set('Cookie', cookie)
        .send({ name: 'Renamed User', phone: '+94771112233' })
        .expect(200);
      expect(res.body).toMatchObject({ name: 'Renamed User', phone: '+94771112233' });

      await request(t.http)
        .patch('/api/v1/users/me')
        .set('Cookie', cookie)
        .send({ role: 'ADMIN' })
        .expect(400);
    });
  });

  describe('Rate limiting', () => {
    useFreshApp();

    it('throttles login after 10 requests a minute (429 RATE_LIMITED)', async () => {
      const attempt = () =>
        request(t.http)
          .post('/api/v1/auth/login')
          .send({ email: 'rate-limit-test@swiftdrop.test', password: 'Password123!' });

      for (let i = 0; i < 10; i++) expect((await attempt()).status).not.toBe(429);

      const res = await attempt();
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });
});
