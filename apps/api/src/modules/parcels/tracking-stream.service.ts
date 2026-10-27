import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { parcelStatusChangedV1, QUEUES, type TrackingSseMessage } from '@swiftdrop/contracts';
import { filter, Observable, Subject } from 'rxjs';
import { RabbitMqService } from '../../infra/events';

/**
 * SSE fan-out (ADR-0004): each API instance binds its own exclusive queue `api.sse.<instanceId>`
 * to `parcel.status_changed.*` and pushes privacy-safe updates to connected browsers.
 * Owner: M4.
 */
@Injectable()
export class TrackingStreamService implements OnModuleInit {
  private readonly logger = new Logger(TrackingStreamService.name);
  private readonly updates = new Subject<TrackingSseMessage>();

  constructor(private readonly rabbit: RabbitMqService) {}

  async onModuleInit() {
    try {
      await this.rabbit.subscribeExclusive(
        `${QUEUES.SSE_PREFIX}${randomUUID()}`,
        ['parcel.status_changed.*'],
        (payload) => {
          const parsed = parcelStatusChangedV1.safeParse(payload);
          if (!parsed.success) {
            this.logger.warn(`Invalid parcel.status_changed event: ${parsed.error.message}`);
            return;
          }
          this.updates.next({
            trackingNumber: parsed.data.data.trackingNumber,
            status: parsed.data.data.newStatus,
            occurredAt: parsed.data.occurredAt,
          });
        },
      );
    } catch (err) {
      this.logger.error(`Failed to subscribe SSE fan-out queue: ${(err as Error).message}`);
    }
  }

  /** Stream of updates for one tracking number. */
  streamFor(trackingNumber: string): Observable<TrackingSseMessage> {
    return this.updates.pipe(filter((m) => m.trackingNumber === trackingNumber));
  }
}
