'use client';

import type { ParcelStatus } from '@swiftdrop/contracts';
import { StatusBadge } from '@/components/ui';
import { TrackingTimeline } from './TrackingTimeline';
import { useLiveTracking, type TrackingHistoryItem } from './useLiveTracking';

export interface TrackingViewProps {
  trackingNumber: string;
  initialStatus: ParcelStatus;
  initialHistory: TrackingHistoryItem[];
  initialUpdatedAt: string;
  originCity: string;
  destinationCity: string;
}

export function TrackingView({
  trackingNumber,
  initialStatus,
  initialHistory,
  initialUpdatedAt,
  originCity,
  destinationCity,
}: TrackingViewProps) {
  const { status, history, updatedAt, connectionState } = useLiveTracking({
    trackingNumber,
    initialStatus,
    initialHistory,
    initialUpdatedAt,
  });

  return (
    <div className="space-y-6">
      {/* Live tracking banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <StatusBadge status={status} />
          <span className="text-sm font-semibold tracking-wide text-ink">{trackingNumber}</span>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted">
          {connectionState === 'live' && (
            <span className="inline-flex items-center gap-1.5 font-medium text-success">
              <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
              Live Updates Active
            </span>
          )}
          {connectionState === 'polling' && (
            <span className="inline-flex items-center gap-1.5 text-warning">
              <span className="h-2 w-2 rounded-full bg-warning" />
              Auto-refreshing (Polling)
            </span>
          )}
          {connectionState === 'connecting' && (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <span className="h-2 w-2 animate-ping rounded-full bg-muted" />
              Connecting...
            </span>
          )}
          <span>•</span>
          <span>Updated {new Date(updatedAt).toLocaleTimeString()}</span>
        </div>
      </div>

      <TrackingTimeline
        currentStatus={status}
        history={history}
        originCity={originCity}
        destinationCity={destinationCity}
      />
    </div>
  );
}
