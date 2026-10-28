import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_COOKIES, ERROR_CODES } from '@swiftdrop/contracts';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

describe('JwtAuthGuard (unit)', () => {
  let guard: JwtAuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let tokenService: jest.Mocked<TokenService>;
  let mockPrisma: any;

  beforeEach(() => {
    JwtAuthGuard.clearCache();

    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    tokenService = {
      verifyAccessToken: jest.fn(),
    } as unknown as jest.Mocked<TokenService>;

    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
    };

    guard = new JwtAuthGuard(reflector, tokenService, mockPrisma);
  });

  function createMockContext(
    headers: Record<string, string> = {},
    cookies: Record<string, string> = {},
  ) {
    const req: any = {
      headers,
      cookies,
      user: undefined,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
      req,
    } as unknown as ExecutionContext & { req: any };
  }

  it('allows access to routes marked with @Public() without any token', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = createMockContext();

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(tokenService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('throws UNAUTHENTICATED (401) when access token is missing', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const ctx = createMockContext();

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHENTICATED,
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it('throws UNAUTHENTICATED (401) when access token fails verification', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccessToken.mockRejectedValue(new Error('jwt expired'));
    const ctx = createMockContext({}, { [AUTH_COOKIES.ACCESS]: 'expired-token' });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.UNAUTHENTICATED,
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it('allows access and attaches user when token is valid and user is active', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccessToken.mockResolvedValue({
      id: 'u-123',
      email: 'customer@swiftdrop.test',
      role: 'CUSTOMER',
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-123',
      isActive: true,
      role: 'CUSTOMER',
    });

    const ctx = createMockContext({ authorization: 'Bearer valid.jwt.token' });
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(ctx.req.user).toEqual({
      id: 'u-123',
      email: 'customer@swiftdrop.test',
      role: 'CUSTOMER',
    });
  });

  it('throws ACCOUNT_DISABLED (403) when user has been deactivated in the database', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccessToken.mockResolvedValue({
      id: 'u-deactivated',
      email: 'bad@swiftdrop.test',
      role: 'CUSTOMER',
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-deactivated',
      isActive: false, // deactivated!
      role: 'CUSTOMER',
    });

    const ctx = createMockContext(
      {},
      { [AUTH_COOKIES.ACCESS]: 'valid.token.for.deactivated.user' },
    );

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.ACCOUNT_DISABLED,
      status: HttpStatus.FORBIDDEN,
    });
  });

  it('caches active user status to prevent database hits on every request, and invalidates on invalidateUser', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccessToken.mockResolvedValue({
      id: 'u-cached',
      email: 'cached@swiftdrop.test',
      role: 'COURIER',
    });
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u-cached',
      isActive: true,
      role: 'COURIER',
    });

    const ctx = createMockContext({ authorization: 'Bearer token' });

    // Request 1: hits DB
    await guard.canActivate(ctx);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);

    // Request 2: hits cache (no second DB query)
    await guard.canActivate(ctx);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);

    // Invalidate user cache
    JwtAuthGuard.invalidateUser('u-cached');

    // Request 3: queries DB again
    await guard.canActivate(ctx);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
