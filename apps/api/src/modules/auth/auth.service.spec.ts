import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@swiftdrop/contracts';
import type { User } from '@swiftdrop/db';
import * as crypto from 'node:crypto';
import type { Env } from '../../config/env';
import { AuthService } from './auth.service';

describe('AuthService (unit)', () => {
  let authService: AuthService;
  let mockPrisma: any;
  let mockTokens: any;
  let mockUsers: any;
  let mockConfig: Env;

  const fakeUser: User = {
    id: 'user-uuid-1',
    email: 'test@swiftdrop.test',
    name: 'Test Customer',
    role: 'CUSTOMER',
    phone: null,
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fakehash',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      refreshSession: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      oAuthAccount: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => cb(mockPrisma)),
    };

    mockTokens = {
      signAccessToken: jest.fn().mockResolvedValue('fake.jwt.token'),
    };

    mockUsers = {
      findByEmail: jest.fn(),
    };

    mockConfig = {
      JWT_ACCESS_SECRET: 'test-secret-at-least-32-chars-long!',
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_DAYS: 30,
      JWT_ISSUER: 'swiftdrop-api',
      JWT_AUDIENCE: 'swiftdrop-clients',
      COOKIE_SECURE: false,
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:8080/api/v1/auth/google/callback',
    } as unknown as Env;

    authService = new AuthService(mockPrisma, mockUsers, mockTokens, mockConfig);
  });

  describe('Refresh Token Rotation & Breach Detection', () => {
    it('throws UNAUTHENTICATED if refresh token is missing', async () => {
      await expect(authService.refresh(undefined, { ip: '127.0.0.1' })).rejects.toMatchObject({
        code: ERROR_CODES.UNAUTHENTICATED,
        status: HttpStatus.UNAUTHORIZED,
      });
    });

    it('throws UNAUTHENTICATED if session does not exist', async () => {
      mockPrisma.refreshSession.findUnique.mockResolvedValue(null);

      await expect(
        authService.refresh('non-existent-token', { ip: '127.0.0.1' }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: 'Invalid refresh session',
      });
    });

    it('detects token reuse, revokes whole chain, and throws UNAUTHENTICATED', async () => {
      const alreadyRevokedSession = {
        id: 'session-old',
        userId: fakeUser.id,
        user: fakeUser,
        revokedAt: new Date(Date.now() - 60_000), // already rotated/revoked!
        expiresAt: new Date(Date.now() + 86_400_000),
      };

      mockPrisma.refreshSession.findUnique.mockResolvedValue(alreadyRevokedSession);

      await expect(authService.refresh('reused-token', { ip: '127.0.0.1' })).rejects.toMatchObject({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: expect.stringContaining('Session compromised'),
      });

      // Verify all active sessions for this user were revoked
      expect(mockPrisma.refreshSession.updateMany).toHaveBeenCalledWith({
        where: { userId: fakeUser.id, revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
    });

    it('throws UNAUTHENTICATED if refresh token is expired', async () => {
      const expiredSession = {
        id: 'session-expired',
        userId: fakeUser.id,
        user: fakeUser,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000), // expired!
      };

      mockPrisma.refreshSession.findUnique.mockResolvedValue(expiredSession);

      await expect(authService.refresh('expired-token', { ip: '127.0.0.1' })).rejects.toMatchObject(
        {
          code: ERROR_CODES.UNAUTHENTICATED,
          message: 'Refresh session expired',
        },
      );
    });

    it('throws ACCOUNT_DISABLED if user account was deactivated', async () => {
      const disabledUserSession = {
        id: 'session-valid',
        userId: fakeUser.id,
        user: { ...fakeUser, isActive: false },
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      };

      mockPrisma.refreshSession.findUnique.mockResolvedValue(disabledUserSession);

      await expect(authService.refresh('valid-token', { ip: '127.0.0.1' })).rejects.toMatchObject({
        code: ERROR_CODES.ACCOUNT_DISABLED,
        status: HttpStatus.FORBIDDEN,
      });
    });

    it('successfully rotates refresh token, creates next session, and links replacedById', async () => {
      const validSession = {
        id: 'session-to-rotate',
        userId: fakeUser.id,
        user: fakeUser,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      };

      mockPrisma.refreshSession.findUnique.mockResolvedValue(validSession);
      mockPrisma.refreshSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.refreshSession.create.mockResolvedValue({ id: 'session-new' });

      const result = await authService.refresh('valid-refresh-token', {
        userAgent: 'JestTestRunner',
        ip: '127.0.0.1',
      });

      expect(result.accessToken).toBe('fake.jwt.token');
      expect(result.refreshToken).toBeDefined();
      expect(result.user.email).toBe(fakeUser.email);
      expect(result.home).toBe('/customer');

      // Old session is claimed atomically (only while still unrevoked), then linked to the new one
      expect(mockPrisma.refreshSession.updateMany).toHaveBeenCalledWith({
        where: { id: validSession.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockPrisma.refreshSession.update).toHaveBeenCalledWith({
        where: { id: validSession.id },
        data: { replacedById: 'session-new' },
      });
    });

    it('treats a lost rotation race as token reuse and revokes all sessions', async () => {
      mockPrisma.refreshSession.findUnique.mockResolvedValue({
        id: 'session-raced',
        userId: fakeUser.id,
        user: fakeUser,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      // The claim finds the row already revoked by the concurrent request.
      mockPrisma.refreshSession.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        authService.refresh('raced-token', { userAgent: 'JestTestRunner', ip: '127.0.0.1' }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      expect(mockPrisma.refreshSession.create).not.toHaveBeenCalled();
      expect(mockPrisma.refreshSession.updateMany).toHaveBeenLastCalledWith({
        where: { userId: fakeUser.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('Logout', () => {
    it('revokes the specific refresh session by token hash', async () => {
      const rawToken = 'my-refresh-token';
      const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      await authService.logout(rawToken);

      expect(mockPrisma.refreshSession.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: expectedHash, revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
    });

    it('is a no-op if refreshToken is undefined', async () => {
      await authService.logout(undefined);
      expect(mockPrisma.refreshSession.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('Google OAuth Profile Linking', () => {
    it('throws NOT_IMPLEMENTED when Google credentials are not configured', async () => {
      const unconfiguredService = new AuthService(mockPrisma, mockUsers, mockTokens, {
        ...mockConfig,
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      } as any);

      await expect(unconfiguredService.googleAuthUrl()).rejects.toMatchObject({
        code: ERROR_CODES.NOT_IMPLEMENTED,
      });
    });

    it('throws UNAUTHENTICATED if OAuth state does not match or code verifier is missing', async () => {
      await expect(
        authService.googleCallback(
          'code',
          'state-abc',
          'state-xyz', // mismatch!
          'verifier',
          { ip: '127.0.0.1' },
        ),
      ).rejects.toMatchObject({
        code: ERROR_CODES.UNAUTHENTICATED,
        message: expect.stringContaining('Invalid OAuth state'),
      });
    });
  });
});
