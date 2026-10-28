import { CanActivate, ExecutionContext, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_COOKIES, ERROR_CODES, type Role } from '@swiftdrop/contracts';
import type { Request } from 'express';
import { PrismaService } from '../../infra/prisma';
import { AppError } from '../errors/app-error';
import { IS_PUBLIC_KEY } from './decorators';
import { TokenService } from './token.service';

interface CachedUserStatus {
  isActive: boolean;
  role: Role;
  cachedAt: number;
}

const CACHE_TTL_MS = 60_000;

/**
 * Global guard (registered in app.module). Every route requires a valid access token unless
 * marked @Public(). Token is read from the `sd_access` httpOnly cookie, falling back to an
 * `Authorization: Bearer` header (handy for Swagger and tests).
 *
 * Security hardening: re-checks that the user is still active and keeps role in sync (cached for 60s).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private static readonly statusCache = new Map<string, CachedUserStatus>();

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /** Invalidate the cached status for a user (called when admin updates active flag or role). */
  static invalidateUser(userId: string): void {
    JwtAuthGuard.statusCache.delete(userId);
  }

  /** Clear all cached user statuses (useful for test resets). */
  static clearCache(): void {
    JwtAuthGuard.statusCache.clear();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = extractToken(req);
    if (!token) throw unauthenticated('Authentication required');

    try {
      req.user = await this.tokens.verifyAccessToken(token);
    } catch {
      throw unauthenticated('Invalid or expired session');
    }

    if (this.prisma) {
      const status = await this.getUserStatus(req.user.id);
      if (!status) {
        throw unauthenticated('User not found');
      }
      if (!status.isActive) {
        throw new AppError(
          ERROR_CODES.ACCOUNT_DISABLED,
          'Account has been disabled',
          HttpStatus.FORBIDDEN,
        );
      }
      req.user.role = status.role;
    }

    return true;
  }

  private async getUserStatus(userId: string): Promise<{ isActive: boolean; role: Role } | null> {
    const now = Date.now();
    const cached = JwtAuthGuard.statusCache.get(userId);
    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      return cached;
    }

    const user = await this.prisma!.user.findUnique({
      where: { id: userId },
      select: { isActive: true, role: true },
    });

    if (!user) {
      JwtAuthGuard.statusCache.delete(userId);
      return null;
    }

    const entry: CachedUserStatus = { isActive: user.isActive, role: user.role, cachedAt: now };
    JwtAuthGuard.statusCache.set(userId, entry);
    return entry;
  }
}

function extractToken(req: Request): string | undefined {
  const fromCookie = req.cookies?.[AUTH_COOKIES.ACCESS];
  if (typeof fromCookie === 'string' && fromCookie) return fromCookie;
  const [scheme, value] = (req.headers.authorization ?? '').split(' ');
  return scheme === 'Bearer' && value ? value : undefined;
}

const unauthenticated = (message: string) =>
  new AppError(ERROR_CODES.UNAUTHENTICATED, message, HttpStatus.UNAUTHORIZED);
