import { ERROR_CODES } from '@swiftdrop/contracts';
import {
  calculateSuccessRate,
  fillDailyVolume,
  resolveReportRange,
  summarizeActivity,
} from './reports.service';

describe('report calculations', () => {
  it('calculates success rate and handles no terminal outcomes', () => {
    expect(calculateSuccessRate(8, 2)).toBe(0.8);
    expect(calculateSuccessRate(0, 0)).toBe(0);
  });

  it('defaults to the last 30 Colombo calendar days', () => {
    const range = resolveReportRange({}, new Date('2026-11-02T18:00:00.000Z'));

    expect(range.fromDate).toBe('2026-10-04');
    expect(range.toDate).toBe('2026-11-02');
    expect(range.start).toEqual(new Date('2026-10-03T18:30:00.000Z'));
    expect(range.end).toEqual(new Date('2026-11-02T18:30:00.000Z'));
  });

  it('rejects ranges longer than 366 days', () => {
    expect(() => resolveReportRange({ from: '2024-12-31', to: '2026-01-01' })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.VALIDATION_FAILED }),
    );
  });

  it('rejects a reversed range', () => {
    expect(() => resolveReportRange({ from: '2026-11-02', to: '2026-11-01' })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.VALIDATION_FAILED }),
    );
  });

  it('fills missing daily volume rows with zeroes', () => {
    const range = resolveReportRange({ from: '2026-11-01', to: '2026-11-03' });

    expect(
      fillDailyVolume(range, [{ date: '2026-11-02', created: '2', delivered: 1, failed: '0' }]),
    ).toEqual([
      { date: '2026-11-01', created: 0, delivered: 0, failed: 0 },
      { date: '2026-11-02', created: 2, delivered: 1, failed: 0 },
      { date: '2026-11-03', created: 0, delivered: 0, failed: 0 },
    ]);
  });

  it('summarizes parcels created and completed within the period', () => {
    expect(
      summarizeActivity(
        ['created-delivered', 'created-failed', 'created-progress'],
        [
          {
            parcelId: 'created-delivered',
            status: 'DELIVERED',
            occurredAt: '2026-11-02T10:00:00Z',
          },
          { parcelId: 'created-failed', status: 'FAILED', occurredAt: '2026-11-02T11:00:00Z' },
        ],
      ),
    ).toEqual({
      total: 3,
      delivered: 1,
      failed: 1,
      inProgress: 1,
      successRate: 0.5,
    });
  });

  it('includes a parcel created before the period when it completes during the period', () => {
    expect(
      summarizeActivity(
        [],
        [{ parcelId: 'older-delivery', status: 'DELIVERED', occurredAt: '2026-11-02T10:00:00Z' }],
      ),
    ).toEqual({
      total: 1,
      delivered: 1,
      failed: 0,
      inProgress: 0,
      successRate: 1,
    });
  });

  it('keeps a parcel created during the period in progress when it completes afterward', () => {
    expect(summarizeActivity(['created-later-delivery'], [])).toEqual({
      total: 1,
      delivered: 0,
      failed: 0,
      inProgress: 1,
      successRate: 0,
    });
  });

  it('counts only the latest terminal event for repeated transitions', () => {
    expect(
      summarizeActivity(
        ['retried-parcel'],
        [
          { parcelId: 'retried-parcel', status: 'FAILED', occurredAt: '2026-11-01T10:00:00Z' },
          { parcelId: 'retried-parcel', status: 'DELIVERED', occurredAt: '2026-11-03T10:00:00Z' },
        ],
      ),
    ).toEqual({
      total: 1,
      delivered: 1,
      failed: 0,
      inProgress: 0,
      successRate: 1,
    });
  });

  it('classifies a delivered parcel as failed when failed is its latest terminal event', () => {
    expect(
      summarizeActivity(
        ['reversed-parcel'],
        [
          { parcelId: 'reversed-parcel', status: 'DELIVERED', occurredAt: '2026-11-01T10:00:00Z' },
          { parcelId: 'reversed-parcel', status: 'FAILED', occurredAt: '2026-11-03T10:00:00Z' },
        ],
      ),
    ).toEqual({
      total: 1,
      delivered: 0,
      failed: 1,
      inProgress: 0,
      successRate: 0,
    });
  });

  it('keeps outcome attribution independent for parcels with separate assignments', () => {
    expect(
      summarizeActivity(
        ['reassigned-parcel'],
        [
          {
            parcelId: 'reassigned-parcel',
            status: 'DELIVERED',
            occurredAt: '2026-11-03T10:00:00Z',
          },
        ],
      ),
    ).toEqual({
      total: 1,
      delivered: 1,
      failed: 0,
      inProgress: 0,
      successRate: 1,
    });
  });

  it('uses the selected Colombo calendar range and supports an empty period', () => {
    const range = resolveReportRange({ from: '2026-11-01', to: '2026-11-03' });
    expect(range.start).toEqual(new Date('2026-10-31T18:30:00.000Z'));
    expect(range.end).toEqual(new Date('2026-11-03T18:30:00.000Z'));
    expect(fillDailyVolume(range, [])).toEqual([
      { date: '2026-11-01', created: 0, delivered: 0, failed: 0 },
      { date: '2026-11-02', created: 0, delivered: 0, failed: 0 },
      { date: '2026-11-03', created: 0, delivered: 0, failed: 0 },
    ]);
  });
});
