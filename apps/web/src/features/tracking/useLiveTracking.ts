'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParcelStatus, TrackingSseMessage } from '@swiftdrop/contracts';
import { api } from '@/lib/api/client';

export interface TrackingHistoryItem {
  status: ParcelStatus;
  at: string;
  reason?: string | null;
}

export interface UseLiveTrackingOptions {
  trackingNumber: string;
  initialStatus: ParcelStatus;
  initialHistory: TrackingHistoryItem[];
  initialUpdatedAt: string;
}

export function useLiveTracking({
  trackingNumber,
  initialStatus,
  initialHistory,
  initialUpdatedAt,
}: UseLiveTrackingOptions) {
  const [status, setStatus] = useState<ParcelStatus>(initialStatus);
  const [history, setHistory] = useState<TrackingHistoryItem[]>(initialHistory);
  const [updatedAt, setUpdatedAt] = useState<string>(initialUpdatedAt);
  const [connectionState, setConnectionState] = useState<
    'connecting' | 'live' | 'polling' | 'error'
  >('connecting');

  const errorCountRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSnapshot = useCallback(async () => {
    try {
      const { data, error } = await api.GET('/api/v1/tracking/{trackingNumber}', {
        params: { path: { trackingNumber } },
      });
      if (data && !error) {
        setStatus(data.status as ParcelStatus);
        setUpdatedAt(new Date(data.updatedAt).toISOString());
        setHistory(
          data.history.map((h) => ({
            status: h.status as ParcelStatus,
            at: new Date(h.at).toISOString(),
            reason: (h.reason as string | null) ?? null,
          })),
        );
      }
    } catch {
      // Ignore network hiccup during background poll
    }
  }, [trackingNumber]);

  useEffect(() => {
    let isCancelled = false;

    function startPollingFallback() {
      if (isCancelled) return;
      setConnectionState('polling');
      if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = setInterval(() => {
        void fetchSnapshot();
      }, 15_000);
    }

    function connectSse() {
      if (isCancelled) return;
      setConnectionState('connecting');

      const es = new EventSource(`/api/v1/tracking/${encodeURIComponent(trackingNumber)}/events`);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (isCancelled) return;
        errorCountRef.current = 0;
        setConnectionState('live');
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
        // Catch up on anything that changed between the server render (or a reconnect) and now.
        void fetchSnapshot();
      };

      es.addEventListener('status', (event: MessageEvent) => {
        if (isCancelled) return;
        try {
          const payload = JSON.parse(event.data) as TrackingSseMessage;
          if (payload.trackingNumber === trackingNumber) {
            // Show the new status at once, then reload the snapshot for the authoritative
            // history (it carries the failure reason and avoids duplicate timeline entries).
            setStatus(payload.status);
            setUpdatedAt(payload.occurredAt);
            void fetchSnapshot();
          }
        } catch {
          // Ignore invalid parse
        }
      });

      es.onerror = () => {
        if (isCancelled) return;
        es.close();
        eventSourceRef.current = null;
        errorCountRef.current += 1;

        if (errorCountRef.current >= 3) {
          startPollingFallback();
        } else {
          const backoffMs = Math.min(1000 * Math.pow(2, errorCountRef.current), 8000);
          reconnectTimeoutRef.current = setTimeout(() => {
            connectSse();
          }, backoffMs);
        }
      };
    }

    connectSse();

    return () => {
      isCancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [trackingNumber, fetchSnapshot]);

  return {
    status,
    history,
    updatedAt,
    isLive: connectionState === 'live',
    connectionState,
    refresh: fetchSnapshot,
  };
}
