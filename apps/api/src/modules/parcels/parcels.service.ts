import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  canTransition,
  ERROR_CODES,
  type FailureReason,
  MAX_DELIVERY_ATTEMPTS,
  type ParcelStatus,
  type Role,
} from '@swiftdrop/contracts';
import { type Parcel, Prisma } from '@swiftdrop/db';
import type { AuthUser } from '../../common/auth';
import { AppError, notFound } from '../../common/errors/app-error';
import { OutboxService } from '../../infra/events';
import { PrismaService } from '../../infra/prisma';
import { PricingService } from '../pricing';
import type { ParcelDetailsDto, PublicTrackingDto } from './dto/parcel.dto';

export interface CreateParcelInput extends ParcelDetailsDto {
  source: 'CUSTOMER' | 'MERCHANT_API';
  customerId?: string;
  merchantId?: string;
  merchantReference?: string;
}

export interface TransitionInput {
  to: ParcelStatus;
  actor: Pick<AuthUser, 'id' | 'role'> | { id: null; role: 'SYSTEM' };
  failureReason?: FailureReason;
  note?: string;
  /** Run inside a caller's transaction (e.g. courier proof upload + DELIVERED in one tx). */
  tx?: Prisma.TransactionClient;
}

/**
 * PUBLIC SERVICE — the ONLY place that creates parcels or changes their status (ADR-0001).
 * Every status change: validate graph (contracts.canTransition) → update parcel → insert
 * ParcelStatusHistory → OutboxService.enqueue('parcel.status_changed') — all in ONE transaction.
 * Callers (bookings M3, merchant-api M5, courier M6, dispatch M7) do their own authorization
 * BEFORE calling. Owner: M4.
 */
@Injectable()
export class ParcelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly pricing: PricingService,
  ) {}

  /** Generates a tracking number in format SD followed by 9 digits, e.g. SD123456789. */
  private generateTrackingNumber(): string {
    const digits = randomInt(100_000_000, 1_000_000_000);
    return `SD${digits}`;
  }

  /** Computes the fee via PricingService, generates a unique tracking number, writes CREATED history + parcel.created event. */
  async create(input: CreateParcelInput, actorRole: Role): Promise<Parcel> {
    if (input.source === 'MERCHANT_API' && input.merchantId && input.merchantReference) {
      const existing = await this.prisma.parcel.findUnique({
        where: {
          merchantId_merchantReference: {
            merchantId: input.merchantId,
            merchantReference: input.merchantReference,
          },
        },
      });
      if (existing) {
        return existing;
      }
    }

    const estimate = await this.pricing.estimate({
      pickupCity: input.pickupCity,
      dropoffCity: input.dropoffCity,
      size: input.size,
      weightKg: input.weightKg,
    });

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const trackingNumber = this.generateTrackingNumber();

      try {
        return await this.prisma.$transaction(async (tx) => {
          const parcel = await tx.parcel.create({
            data: {
              trackingNumber,
              status: 'CREATED',
              source: input.source,
              customerId: input.customerId ?? null,
              merchantId: input.merchantId ?? null,
              merchantReference: input.merchantReference ?? null,
              senderName: input.senderName,
              senderPhone: input.senderPhone,
              pickupAddress: input.pickupAddress,
              pickupCity: input.pickupCity,
              pickupZoneId: estimate.pickupZoneId,
              recipientName: input.recipientName,
              recipientPhone: input.recipientPhone,
              recipientEmail: input.recipientEmail ?? null,
              dropoffAddress: input.dropoffAddress,
              dropoffCity: input.dropoffCity,
              dropoffZoneId: estimate.dropoffZoneId,
              size: input.size,
              weightKg: new Prisma.Decimal(input.weightKg),
              description: input.description ?? null,
              feeCents: estimate.feeCents,
              currency: estimate.currency ?? 'LKR',
            },
          });

          await tx.parcelStatusHistory.create({
            data: {
              parcelId: parcel.id,
              fromStatus: null,
              toStatus: 'CREATED',
              actorId: input.customerId ?? null,
              actorRole,
              note: 'Parcel created',
            },
          });

          await this.outbox.enqueue(tx, 'parcel.created', {
            parcelId: parcel.id,
            trackingNumber: parcel.trackingNumber,
            merchantId: parcel.merchantId,
            customerId: parcel.customerId,
          });

          return parcel;
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // If merchant order duplicate collided concurrently, return existing
          if (input.source === 'MERCHANT_API' && input.merchantId && input.merchantReference) {
            const existing = await this.prisma.parcel.findUnique({
              where: {
                merchantId_merchantReference: {
                  merchantId: input.merchantId,
                  merchantReference: input.merchantReference,
                },
              },
            });
            if (existing) {
              return existing;
            }
          }
          // If trackingNumber collision, retry
          if (attempt < maxAttempts - 1) {
            continue;
          }
        }
        throw err;
      }
    }

    throw new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      'Failed to generate unique tracking number after multiple attempts',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /** Throws INVALID_STATUS_TRANSITION / FAILURE_REASON_REQUIRED / PROOF_REQUIRED / MAX_ATTEMPTS_REACHED. */
  async transition(parcelId: string, input: TransitionInput): Promise<Parcel> {
    const executeInTx = async (tx: Prisma.TransactionClient): Promise<Parcel> => {
      const parcel = await tx.parcel.findUnique({
        where: { id: parcelId },
      });
      if (!parcel) {
        throw notFound('Parcel');
      }

      if (!canTransition(parcel.status, input.to)) {
        throw new AppError(
          ERROR_CODES.INVALID_STATUS_TRANSITION,
          `Cannot transition parcel from ${parcel.status} to ${input.to}`,
          HttpStatus.CONFLICT,
          { from: parcel.status, to: input.to },
        );
      }

      if (input.to === 'FAILED' && !input.failureReason) {
        throw new AppError(
          ERROR_CODES.FAILURE_REASON_REQUIRED,
          'failureReason is required when parcel transitions to FAILED',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      if (input.to === 'DELIVERED') {
        const proof = await tx.proofOfDelivery.findUnique({
          where: { parcelId },
        });
        if (!proof) {
          throw new AppError(
            ERROR_CODES.PROOF_REQUIRED,
            'Proof of delivery is required when parcel transitions to DELIVERED',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
      }

      if (parcel.status === 'FAILED' && input.to === 'OUT_FOR_DELIVERY') {
        if (parcel.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
          throw new AppError(
            ERROR_CODES.MAX_ATTEMPTS_REACHED,
            `Maximum delivery attempts (${MAX_DELIVERY_ATTEMPTS}) reached for parcel ${parcel.trackingNumber}`,
            HttpStatus.CONFLICT,
            { deliveryAttempts: parcel.deliveryAttempts, maxAttempts: MAX_DELIVERY_ATTEMPTS },
          );
        }
      }

      const updateData: Prisma.ParcelUpdateInput = {
        status: input.to,
      };

      if (input.to === 'OUT_FOR_DELIVERY') {
        updateData.deliveryAttempts = { increment: 1 };
      }

      if (input.to === 'DELIVERED') {
        updateData.deliveredAt = new Date();
      }

      const updateResult = await tx.parcel.updateMany({
        where: {
          id: parcelId,
          status: parcel.status,
        },
        data: updateData,
      });

      if (updateResult.count === 0) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'The parcel was updated by someone else. Reload and try again.',
          HttpStatus.CONFLICT,
        );
      }

      // A failure reason only belongs to a FAILED transition.
      const failureReason = input.to === 'FAILED' ? (input.failureReason ?? null) : null;

      await tx.parcelStatusHistory.create({
        data: {
          parcelId,
          fromStatus: parcel.status,
          toStatus: input.to,
          actorId: input.actor.id ?? null,
          actorRole: input.actor.role,
          reason: failureReason,
          note: input.note ?? null,
        },
      });

      await this.outbox.enqueue(tx, 'parcel.status_changed', {
        parcelId,
        trackingNumber: parcel.trackingNumber,
        merchantId: parcel.merchantId,
        customerId: parcel.customerId,
        previousStatus: parcel.status,
        newStatus: input.to,
        actorRole: input.actor.role,
        failureReason,
      });

      return tx.parcel.findUniqueOrThrow({ where: { id: parcelId } });
    };

    if (input.tx) {
      return executeInTx(input.tx);
    }

    return this.prisma.$transaction(async (tx) => executeInTx(tx));
  }

  findById(id: string): Promise<Parcel | null> {
    return this.prisma.parcel.findUnique({ where: { id } });
  }

  findByTrackingNumber(trackingNumber: string): Promise<Parcel | null> {
    return this.prisma.parcel.findUnique({ where: { trackingNumber } });
  }

  async getHistory(parcelId: string) {
    return this.prisma.parcelStatusHistory.findMany({
      where: { parcelId },
      orderBy: { createdAt: 'asc' },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });
  }

  /** Public tracking projection — privacy-safe (see PublicTrackingDto). */
  async getPublicTracking(trackingNumber: string): Promise<PublicTrackingDto> {
    const parcel = await this.prisma.parcel.findUnique({
      where: { trackingNumber },
      include: {
        statusHistory: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!parcel) {
      throw notFound('Parcel');
    }

    return {
      trackingNumber: parcel.trackingNumber,
      status: parcel.status,
      originCity: parcel.pickupCity,
      destinationCity: parcel.dropoffCity,
      updatedAt: parcel.updatedAt,
      history: parcel.statusHistory.map((h) => ({
        status: h.toStatus,
        at: h.createdAt,
        reason: h.reason,
      })),
    };
  }
}
