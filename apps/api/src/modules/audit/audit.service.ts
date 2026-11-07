import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@swiftdrop/contracts';
import type { Paginated } from '@swiftdrop/contracts';
import type { Prisma } from '@swiftdrop/db';
import type { AuthUser } from '../../common/auth';
import { paginated, type PaginationQuery } from '../../common/pagination/pagination';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma';
import type { ListAuditLogsQuery, ListAuditUsersQuery } from './audit.controller';

export interface AuditEntry {
  actor: Pick<AuthUser, 'id' | 'role'> | null; // null = SYSTEM
  /** dot.case, e.g. "merchant.approved", "pricing_rule.updated", "user.role_changed" */
  action: string;
  entityType: string;
  entityId: string;
  /** Small, non-sensitive context (before/after ids or flags). NO secrets, NO addresses/phones. */
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}

export interface AuditLogDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: {
    id: string;
    name: string;
    email: string;
    role: string;
  } | null;
  actorRole: string | null;
  affectedPerson: {
    id: string;
    name: string;
    email: string;
  } | null;
  timestamp: Date;
  metadata: Prisma.JsonValue | null;
}

export interface AuditUserLookupDto {
  id: string;
  name: string;
  email: string;
}

const SENSITIVE_METADATA_KEY = /(password|token|secret|api[_-]?key|authorization|cookie)/i;

function safeMetadata(value: Prisma.JsonValue | null | undefined): Prisma.JsonValue | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => safeMetadata(item));
  }
  if (typeof value !== 'object') return value;

  const result: Record<string, Prisma.JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_METADATA_KEY.test(key)) continue;
    // Keep nulls: `previousRole: null` is meaningful and must not vanish.
    result[key] = safeMetadata(item);
  }
  return result;
}

const AUDIT_TIME_ZONE_OFFSET_MINUTES = 5 * 60 + 30;

function parseAuditDate(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  let parsed: Date;
  if (dateOnly) {
    const [year, month, day] = value.split('-').map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (
      calendarDate.getUTCFullYear() !== year ||
      calendarDate.getUTCMonth() !== month - 1 ||
      calendarDate.getUTCDate() !== day
    ) {
      return undefined;
    }
    const utcMillis = Date.UTC(
      year,
      month - 1,
      day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    );
    parsed = new Date(utcMillis - AUDIT_TIME_ZONE_OFFSET_MINUTES * 60_000);
  } else {
    parsed = new Date(value);
  }
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * PUBLIC SERVICE — every module calls `audit.record(...)` for sensitive admin actions.
 * Pass `tx` to write inside your own transaction. Owner: M9.
 * The basic insert works from day 1 so other members can integrate early.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        actorId: entry.actor?.id ?? null,
        actorRole: entry.actor?.role ?? 'SYSTEM',
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata,
        ip: entry.ip,
      },
    });
  }

  async list(q: ListAuditLogsQuery): Promise<Paginated<AuditLogDto>> {
    const from = parseAuditDate(q.from, false);
    const to = parseAuditDate(q.to, true);
    if ((q.from && !from) || (q.to && !to)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'Audit dates must be valid ISO-8601 dates',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (from && to && from > to) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'Audit end date must not be earlier than the start date',
        HttpStatus.BAD_REQUEST,
      );
    }

    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: q.action } : {}),
      // Modules record entity types in mixed case ('parcel', 'User', 'ApiKey').
      ...(q.entityType ? { entityType: { equals: q.entityType, mode: 'insensitive' } } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.take,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          actorRole: true,
          metadata: true,
          createdAt: true,
          actor: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    const affectedIds = [
      ...new Set(
        rows.filter((row) => row.entityType.toLowerCase() === 'user').map((row) => row.entityId),
      ),
    ];
    const affectedPeople =
      affectedIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: affectedIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
    const affectedPeopleById = new Map(affectedPeople.map((person) => [person.id, person]));

    return paginated(
      rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actor: row.actor,
        actorRole: row.actorRole,
        affectedPerson: affectedPeopleById.get(row.entityId) ?? null,
        timestamp: row.createdAt,
        metadata: safeMetadata(row.metadata),
      })),
      total,
      q as PaginationQuery,
    );
  }

  async listUsers(q: ListAuditUsersQuery): Promise<Paginated<AuditUserLookupDto>> {
    const where: Prisma.UserWhereInput = {
      name: { contains: q.search.trim(), mode: 'insensitive' },
    };
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip: q.skip,
        take: q.take,
        orderBy: [{ name: 'asc' }, { email: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, email: true },
      }),
    ]);

    return paginated(users, total, q);
  }
}
