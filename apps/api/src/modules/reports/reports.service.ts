import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@swiftdrop/contracts';
import { Prisma } from '@swiftdrop/db';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../infra/prisma';
import type {
  CourierPerformanceDto,
  DailyVolumeDto,
  DeliverySummaryDto,
  ReportRangeQuery,
} from './dto/report.dto';

export const REPORT_TIME_ZONE = 'Asia/Colombo';
const REPORT_DAYS_LIMIT = 366;
const COLOMBO_OFFSET_MINUTES = 5 * 60 + 30;

export interface ReportRange {
  fromDate: string;
  toDate: string;
  start: Date;
  end: Date;
}

interface DailyVolumeRow {
  date: string;
  created: number | string;
  delivered: number | string;
  failed: number | string;
}

interface CourierPerformanceRow {
  courierId: string;
  name: string;
  assigned: number | string;
  delivered: number | string;
  failed: number | string;
}

export interface ActivityTerminalEvent {
  parcelId: string;
  status: 'DELIVERED' | 'FAILED';
  occurredAt: string | Date;
}

export interface ActivitySummary {
  total: number;
  delivered: number;
  failed: number;
  inProgress: number;
  successRate: number;
}

/** Converts an input instant to the Colombo calendar date used by reports. */
function colomboDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Report dates must be valid ISO-8601 dates');
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function startOfColomboDay(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - COLOMBO_OFFSET_MINUTES * 60_000);
}

export function resolveReportRange(query: ReportRangeQuery, now: Date = new Date()): ReportRange {
  const toDate = query.to ? colomboDate(query.to) : colomboDate(now);
  const fromDate = query.from ? colomboDate(query.from) : addDays(toDate, -29);
  const dayCount =
    Math.floor(
      (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000,
    ) + 1;

  if (dayCount < 1) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Report from date must be on or before the to date',
    );
  }
  if (dayCount > REPORT_DAYS_LIMIT) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `Report date range cannot exceed ${REPORT_DAYS_LIMIT} days`,
      HttpStatus.BAD_REQUEST,
      { maxDays: REPORT_DAYS_LIMIT },
    );
  }

  return {
    fromDate,
    toDate,
    start: startOfColomboDay(fromDate),
    end: startOfColomboDay(addDays(toDate, 1)),
  };
}

export function calculateSuccessRate(delivered: number, failed: number): number {
  const terminalOutcomes = delivered + failed;
  return terminalOutcomes === 0 ? 0 : delivered / terminalOutcomes;
}

/** Classifies each active parcel by its latest terminal event in the selected range. */
export function summarizeActivity(
  createdParcelIds: string[],
  terminalEvents: ActivityTerminalEvent[],
): ActivitySummary {
  const latestByParcel = new Map<string, ActivityTerminalEvent>();
  for (const event of terminalEvents) {
    const previous = latestByParcel.get(event.parcelId);
    if (!previous || new Date(event.occurredAt) >= new Date(previous.occurredAt)) {
      latestByParcel.set(event.parcelId, event);
    }
  }

  const parcelIds = new Set([...createdParcelIds, ...latestByParcel.keys()]);
  let delivered = 0;
  let failed = 0;
  for (const event of latestByParcel.values()) {
    if (event.status === 'DELIVERED') delivered++;
    if (event.status === 'FAILED') failed++;
  }

  return {
    total: parcelIds.size,
    delivered,
    failed,
    inProgress: parcelIds.size - delivered - failed,
    successRate: calculateSuccessRate(delivered, failed),
  };
}

export function fillDailyVolume(range: ReportRange, rows: DailyVolumeRow[]): DailyVolumeDto[] {
  const byDate = new Map(
    rows.map((row) => [
      row.date,
      {
        date: row.date,
        created: Number(row.created),
        delivered: Number(row.delivered),
        failed: Number(row.failed),
      },
    ]),
  );
  const result: DailyVolumeDto[] = [];
  for (let date = range.fromDate; date <= range.toDate; date = addDays(date, 1)) {
    result.push(byDate.get(date) ?? { date, created: 0, delivered: 0, failed: 0 });
  }
  return result;
}

/** Read-only aggregate queries. Default range = last 30 days. No PII in report rows. Owner: M9. */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async deliverySummary(q: ReportRangeQuery): Promise<DeliverySummaryDto> {
    const range = resolveReportRange(q);
    const zoneFilter = q.zoneId
      ? Prisma.sql`AND (p."pickupZoneId" = ${q.zoneId} OR p."dropoffZoneId" = ${q.zoneId})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      [{ total: number | string; delivered: number | string; failed: number | string }]
    >(Prisma.sql`
      WITH created_events AS (
        SELECT p.id
        FROM "parcels" p
        WHERE p."createdAt" >= ${range.start}
          AND p."createdAt" < ${range.end}
          ${zoneFilter}
      ),
      terminal_events AS (
        SELECT
          h."parcelId",
          h."toStatus"::text AS status,
          ROW_NUMBER() OVER (
            PARTITION BY h."parcelId"
            ORDER BY h."createdAt" DESC, h.id DESC
          ) AS row_number
        FROM "parcel_status_history" h
        INNER JOIN "parcels" p ON p.id = h."parcelId"
        WHERE h."createdAt" >= ${range.start}
          AND h."createdAt" < ${range.end}
          AND h."toStatus"::text IN ('DELIVERED', 'FAILED')
          ${zoneFilter}
      ),
      activity AS (
        SELECT id AS "parcelId" FROM created_events
        UNION
        SELECT "parcelId" FROM terminal_events
      ),
      latest_outcomes AS (
        SELECT "parcelId", status
        FROM terminal_events
        WHERE row_number = 1
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE latest_outcomes.status = 'DELIVERED')::int AS delivered,
        COUNT(*) FILTER (WHERE latest_outcomes.status = 'FAILED')::int AS failed
      FROM activity
      LEFT JOIN latest_outcomes ON latest_outcomes."parcelId" = activity."parcelId"
    `);
    const total = Number(rows[0]?.total ?? 0);
    const delivered = Number(rows[0]?.delivered ?? 0);
    const failed = Number(rows[0]?.failed ?? 0);
    return {
      total,
      delivered,
      failed,
      inProgress: total - delivered - failed,
      successRate: calculateSuccessRate(delivered, failed),
    };
  }

  async dailyVolume(q: ReportRangeQuery): Promise<DailyVolumeDto[]> {
    const range = resolveReportRange(q);
    const zoneFilter = q.zoneId
      ? Prisma.sql`AND (p."pickupZoneId" = ${q.zoneId} OR p."dropoffZoneId" = ${q.zoneId})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<DailyVolumeRow[]>(Prisma.sql`
      WITH days AS (
        SELECT generate_series(
          CAST(${range.fromDate} AS date),
          CAST(${range.toDate} AS date),
          interval '1 day'
        )::date AS day
      ),
      created AS (
        SELECT
          (p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${REPORT_TIME_ZONE})::date AS day,
          COUNT(*)::int AS created
        FROM "parcels" p
        WHERE p."createdAt" >= ${range.start}
          AND p."createdAt" < ${range.end}
          ${zoneFilter}
        GROUP BY 1
      ),
      outcomes AS (
        SELECT
          (h."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${REPORT_TIME_ZONE})::date AS day,
          COUNT(*) FILTER (WHERE h."toStatus"::text = 'DELIVERED')::int AS delivered,
          COUNT(*) FILTER (WHERE h."toStatus"::text = 'FAILED')::int AS failed
        FROM "parcel_status_history" h
        INNER JOIN "parcels" p ON p.id = h."parcelId"
        WHERE h."createdAt" >= ${range.start}
          AND h."createdAt" < ${range.end}
          AND h."toStatus"::text IN ('DELIVERED', 'FAILED')
          AND NOT EXISTS (
            SELECT 1
            FROM "parcel_status_history" newer
            WHERE newer."parcelId" = h."parcelId"
              AND newer."createdAt" >= ${range.start}
              AND newer."createdAt" < ${range.end}
              AND newer."toStatus"::text IN ('DELIVERED', 'FAILED')
              AND (
                newer."createdAt" > h."createdAt"
                OR (newer."createdAt" = h."createdAt" AND newer.id > h.id)
              )
          )
          ${zoneFilter}
        GROUP BY 1
      )
      SELECT
        to_char(days.day, 'YYYY-MM-DD') AS date,
        COALESCE(created.created, 0)::int AS created,
        COALESCE(outcomes.delivered, 0)::int AS delivered,
        COALESCE(outcomes.failed, 0)::int AS failed
      FROM days
      LEFT JOIN created ON created.day = days.day
      LEFT JOIN outcomes ON outcomes.day = days.day
      ORDER BY days.day
    `);
    return fillDailyVolume(range, rows);
  }

  async courierPerformance(q: ReportRangeQuery): Promise<CourierPerformanceDto[]> {
    const range = resolveReportRange(q);
    const zoneFilter = q.zoneId
      ? Prisma.sql`AND (p."pickupZoneId" = ${q.zoneId} OR p."dropoffZoneId" = ${q.zoneId})`
      : Prisma.empty;
    // Credit each outcome to the courier whose assignment was current when it happened: the
    // parcel's latest DELIVERED/FAILED event after this assignment and before the parcel's next
    // assignment. (Joining on the parcel alone gave a re-assigned parcel's delivery to every
    // courier who ever held it, and hid the first courier's failure.)
    const rows = await this.prisma.$queryRaw<CourierPerformanceRow[]>(Prisma.sql`
      SELECT
        u.id AS "courierId",
        u.name,
        COUNT(DISTINCT ca.id)::int AS assigned,
        COUNT(DISTINCT ca."parcelId") FILTER (WHERE outcome.status = 'DELIVERED')::int AS delivered,
        COUNT(DISTINCT ca."parcelId") FILTER (WHERE outcome.status = 'FAILED')::int AS failed
      FROM "courier_assignments" ca
      INNER JOIN "parcels" p ON p.id = ca."parcelId"
      INNER JOIN "users" u ON u.id = ca."courierId"
      LEFT JOIN LATERAL (
        SELECT h."toStatus"::text AS status
        FROM "parcel_status_history" h
        WHERE h."parcelId" = ca."parcelId"
          AND h."toStatus"::text IN ('DELIVERED', 'FAILED')
          AND h."createdAt" >= ca."assignedAt"
          AND h."createdAt" >= ${range.start}
          AND h."createdAt" < ${range.end}
          AND NOT EXISTS (
            SELECT 1
            FROM "courier_assignments" later
            WHERE later."parcelId" = ca."parcelId"
              AND later."assignedAt" > ca."assignedAt"
              AND later."assignedAt" <= h."createdAt"
          )
        ORDER BY h."createdAt" DESC, h.id DESC
        LIMIT 1
      ) outcome ON true
      WHERE ca."assignedAt" >= ${range.start}
        AND ca."assignedAt" < ${range.end}
        ${zoneFilter}
      GROUP BY u.id, u.name
      ORDER BY u.name, u.id
    `);
    return rows.map((row) => ({
      courierId: row.courierId,
      name: row.name,
      assigned: Number(row.assigned),
      delivered: Number(row.delivered),
      failed: Number(row.failed),
    }));
  }
}
