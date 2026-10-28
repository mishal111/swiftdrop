'use client';

import type { ParcelStatus } from '@swiftdrop/contracts';
import { StatusBadge, STATUS_LABEL } from '@/components/ui';
import type { TrackingHistoryItem } from './useLiveTracking';

export interface TrackingTimelineProps {
  currentStatus: ParcelStatus;
  history: TrackingHistoryItem[];
  originCity: string;
  destinationCity: string;
}

const ORDERED_STEPS: ParcelStatus[] = [
  'CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
];

export function TrackingTimeline({
  currentStatus,
  history,
  originCity,
  destinationCity,
}: TrackingTimelineProps) {
  // Sort history newest first for the activity log
  const sortedHistory = [...history].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );

  const isFailed = currentStatus === 'FAILED';
  // A FAILED parcel keeps the progress it made: show the furthest step it reached before failing.
  const currentIndex = isFailed
    ? Math.max(0, ...history.map((h) => ORDERED_STEPS.indexOf(h.status)))
    : ORDERED_STEPS.indexOf(currentStatus);

  return (
    <div className="space-y-6">
      {/* Route header */}
      <div className="flex items-center justify-between rounded-lg border border-line bg-surface p-4">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">Origin</span>
          <p className="text-base font-medium capitalize text-ink">{originCity}</p>
        </div>
        <div className="flex items-center text-muted">
          <span className="mx-2 text-sm">→</span>
        </div>
        <div className="text-right">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Destination
          </span>
          <p className="text-base font-medium capitalize text-ink">{destinationCity}</p>
        </div>
      </div>

      {/* Stepper Progress */}
      <div className="rounded-lg border border-line bg-surface p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">Delivery Progress</h3>
        <div className="relative flex items-center justify-between">
          <div className="absolute left-0 top-1/2 -z-0 h-0.5 w-full -translate-y-1/2 bg-line" />
          {ORDERED_STEPS.map((step, idx) => {
            const isCompleted = currentIndex >= idx;
            const isCurrent = !isFailed && currentStatus === step;

            return (
              <div key={step} className="relative z-10 flex flex-col items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                    isCurrent
                      ? 'bg-brand text-white ring-4 ring-brand-soft'
                      : isCompleted
                        ? 'bg-brand text-white'
                        : 'border-2 border-line bg-surface text-muted'
                  }`}
                >
                  {isCompleted && !isCurrent ? '✓' : idx + 1}
                </div>
                <span
                  className={`mt-2 hidden text-xs font-medium sm:block ${
                    isCurrent ? 'font-semibold text-brand' : 'text-muted'
                  }`}
                >
                  {STATUS_LABEL[step]}
                </span>
              </div>
            );
          })}
        </div>

        {isFailed && (
          <div className="mt-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
            <span className="font-semibold">Delivery Exception: </span>
            {sortedHistory[0]?.reason ? (
              <span>Reason: {sortedHistory[0].reason.replace(/_/g, ' ')}</span>
            ) : (
              <span>Attempt failed. Parcel will be re-attempted or held for pickup.</span>
            )}
          </div>
        )}
      </div>

      {/* Activity Timeline List */}
      <div className="rounded-lg border border-line bg-surface p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">Status History</h3>
        {sortedHistory.length === 0 ? (
          <p className="text-sm text-muted">No activity recorded yet.</p>
        ) : (
          <ol className="relative border-l border-line ml-3 space-y-6">
            {sortedHistory.map((item, index) => {
              const dateStr = new Date(item.at).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              });

              return (
                <li key={`${item.status}-${item.at}-${index}`} className="ml-6">
                  <span className="absolute -left-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface ring-4 ring-canvas">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        index === 0 ? 'bg-brand' : 'bg-muted'
                      }`}
                    />
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={item.status} />
                    <time className="text-xs text-muted">{dateStr}</time>
                  </div>
                  {item.reason && (
                    <p className="mt-1 text-xs font-medium text-danger">
                      Reason: {item.reason.replace(/_/g, ' ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
