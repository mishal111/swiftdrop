import { HttpStatus } from '@nestjs/common';
import {
  ERROR_CODES,
  MAX_DELIVERY_ATTEMPTS,
  PARCEL_STATUSES,
  PARCEL_TRANSITIONS,
} from '@swiftdrop/contracts';
import { Prisma } from '@swiftdrop/db';
import { ParcelsService } from './parcels.service';

describe('ParcelsService (Unit)', () => {
  let service: ParcelsService;
  let prismaMock: any;
  let outboxMock: any;
  let pricingMock: any;

  beforeEach(() => {
    prismaMock = {
      parcel: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      parcelStatusHistory: {
        findMany: jest.fn(),
        create: jest.fn(),
      },
      proofOfDelivery: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
    };

    outboxMock = {
      enqueue: jest.fn().mockResolvedValue({}),
    };

    pricingMock = {
      estimate: jest.fn().mockResolvedValue({
        feeCents: 52500,
        currency: 'LKR',
        pickupZoneId: 'zone-cmb',
        dropoffZoneId: 'zone-kdy',
        ruleId: 'rule-default',
        ruleName: 'Default Rule',
      }),
    };

    service = new ParcelsService(prismaMock, outboxMock, pricingMock);
  });

  describe('Tracking number format and creation', () => {
    it('generates tracking number matching SD + 9 digits and enqueues parcel.created event', async () => {
      const createdParcel = {
        id: 'p-1',
        trackingNumber: 'SD123456789',
        status: 'CREATED',
        source: 'CUSTOMER',
        customerId: 'cust-1',
        merchantId: null,
        merchantReference: null,
      };

      prismaMock.parcel.create.mockResolvedValue(createdParcel);
      prismaMock.parcelStatusHistory.create.mockResolvedValue({});

      const result = await service.create(
        {
          source: 'CUSTOMER',
          customerId: 'cust-1',
          senderName: 'Sender',
          senderPhone: '+94770000001',
          pickupAddress: 'Pickup Address 123',
          pickupCity: 'Colombo',
          recipientName: 'Recipient',
          recipientPhone: '+94770000002',
          dropoffAddress: 'Dropoff Address 456',
          dropoffCity: 'Kandy',
          size: 'SMALL',
          weightKg: 2,
        },
        'CUSTOMER',
      );

      expect(result).toBe(createdParcel);
      expect(pricingMock.estimate).toHaveBeenCalledWith({
        pickupCity: 'Colombo',
        dropoffCity: 'Kandy',
        size: 'SMALL',
        weightKg: 2,
      });

      const createCall = prismaMock.parcel.create.mock.calls[0][0];
      expect(createCall.data.trackingNumber).toMatch(/^SD[0-9]{9}$/);
      expect(createCall.data.feeCents).toBe(52500);

      expect(prismaMock.parcelStatusHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            parcelId: 'p-1',
            fromStatus: null,
            toStatus: 'CREATED',
            actorRole: 'CUSTOMER',
          }),
        }),
      );

      expect(outboxMock.enqueue).toHaveBeenCalledWith(
        prismaMock,
        'parcel.created',
        expect.objectContaining({
          parcelId: 'p-1',
          trackingNumber: 'SD123456789',
          customerId: 'cust-1',
          merchantId: null,
        }),
      );
    });

    it('retries when tracking number has collision (P2002)', async () => {
      const p2002Err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.10.1',
        meta: { target: ['trackingNumber'] },
      });

      const createdParcel = {
        id: 'p-1',
        trackingNumber: 'SD987654321',
        status: 'CREATED',
      };

      // Fail once, succeed second time
      prismaMock.parcel.create.mockRejectedValueOnce(p2002Err).mockResolvedValueOnce(createdParcel);

      const result = await service.create(
        {
          source: 'CUSTOMER',
          senderName: 'Sender',
          senderPhone: '+94770000001',
          pickupAddress: 'Pickup Address',
          pickupCity: 'Colombo',
          recipientName: 'Recipient',
          recipientPhone: '+94770000002',
          dropoffAddress: 'Dropoff Address',
          dropoffCity: 'Kandy',
          size: 'SMALL',
          weightKg: 1,
        },
        'CUSTOMER',
      );

      expect(result).toBe(createdParcel);
      expect(prismaMock.parcel.create).toHaveBeenCalledTimes(2);
    });

    it('returns existing parcel for duplicate merchant order idempotency', async () => {
      const existingParcel = {
        id: 'p-merchant-1',
        trackingNumber: 'SD111222333',
        status: 'CREATED',
        source: 'MERCHANT_API',
        merchantId: 'm-1',
        merchantReference: 'order-ref-999',
      };

      prismaMock.parcel.findUnique.mockResolvedValue(existingParcel);

      const result = await service.create(
        {
          source: 'MERCHANT_API',
          merchantId: 'm-1',
          merchantReference: 'order-ref-999',
          senderName: 'Merchant Sender',
          senderPhone: '+94770000001',
          pickupAddress: 'Warehouse A',
          pickupCity: 'Colombo',
          recipientName: 'Customer',
          recipientPhone: '+94770000002',
          dropoffAddress: 'Home Address',
          dropoffCity: 'Kandy',
          size: 'MEDIUM',
          weightKg: 3,
        },
        'MERCHANT',
      );

      expect(result).toBe(existingParcel);
      expect(pricingMock.estimate).not.toHaveBeenCalled();
      expect(prismaMock.parcel.create).not.toHaveBeenCalled();
    });
  });

  describe('Status transition matrix (table-driven)', () => {
    // Generate all 36 combinations
    for (const from of PARCEL_STATUSES) {
      for (const to of PARCEL_STATUSES) {
        const isAllowed = PARCEL_TRANSITIONS[from].includes(to);

        if (isAllowed) {
          it(`allows transition from ${from} to ${to}`, async () => {
            const currentParcel = {
              id: 'p-1',
              trackingNumber: 'SD100000001',
              status: from,
              deliveryAttempts: from === 'FAILED' ? 1 : 0,
              merchantId: null,
              customerId: 'cust-1',
            };

            const updatedParcel = {
              ...currentParcel,
              status: to,
            };

            prismaMock.parcel.findUnique.mockResolvedValue(currentParcel);
            prismaMock.parcel.updateMany.mockResolvedValue({ count: 1 });
            prismaMock.parcel.findUniqueOrThrow.mockResolvedValue(updatedParcel);

            if (to === 'DELIVERED') {
              prismaMock.proofOfDelivery.findUnique.mockResolvedValue({ id: 'pod-1' });
            }

            const result = await service.transition('p-1', {
              to,
              actor: { id: 'u-1', role: 'COURIER' },
              failureReason: to === 'FAILED' ? 'RECIPIENT_UNAVAILABLE' : undefined,
            });

            expect(result.status).toBe(to);
            expect(prismaMock.parcel.updateMany).toHaveBeenCalledWith({
              where: { id: 'p-1', status: from },
              data: expect.objectContaining({ status: to }),
            });
            expect(outboxMock.enqueue).toHaveBeenCalledWith(
              prismaMock,
              'parcel.status_changed',
              expect.objectContaining({
                parcelId: 'p-1',
                previousStatus: from,
                newStatus: to,
              }),
            );
          });
        } else {
          it(`rejects transition from ${from} to ${to} with 409 INVALID_STATUS_TRANSITION`, async () => {
            prismaMock.parcel.findUnique.mockResolvedValue({
              id: 'p-1',
              trackingNumber: 'SD100000001',
              status: from,
              deliveryAttempts: 0,
            });

            await expect(
              service.transition('p-1', {
                to,
                actor: { id: 'u-1', role: 'COURIER' },
              }),
            ).rejects.toMatchObject({
              code: ERROR_CODES.INVALID_STATUS_TRANSITION,
              status: HttpStatus.CONFLICT,
              details: { from, to },
            });
          });
        }
      }
    }
  });

  describe('Transition rules & edge cases', () => {
    it('throws 404 when parcel is not found', async () => {
      prismaMock.parcel.findUnique.mockResolvedValue(null);

      await expect(
        service.transition('non-existent', {
          to: 'PICKED_UP',
          actor: { id: 'u-1', role: 'COURIER' },
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('requires failureReason when transitioning to FAILED (422 FAILURE_REASON_REQUIRED)', async () => {
      prismaMock.parcel.findUnique.mockResolvedValue({
        id: 'p-1',
        status: 'OUT_FOR_DELIVERY',
        deliveryAttempts: 1,
      });

      await expect(
        service.transition('p-1', {
          to: 'FAILED',
          actor: { id: 'u-1', role: 'COURIER' },
          // failureReason omitted
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.FAILURE_REASON_REQUIRED,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });

    it('requires proof of delivery when transitioning to DELIVERED (422 PROOF_REQUIRED)', async () => {
      prismaMock.parcel.findUnique.mockResolvedValue({
        id: 'p-1',
        status: 'OUT_FOR_DELIVERY',
        deliveryAttempts: 1,
      });
      prismaMock.proofOfDelivery.findUnique.mockResolvedValue(null);

      await expect(
        service.transition('p-1', {
          to: 'DELIVERED',
          actor: { id: 'u-1', role: 'COURIER' },
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.PROOF_REQUIRED,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });

    it('throws 409 MAX_ATTEMPTS_REACHED when re-attempting a parcel that reached MAX_DELIVERY_ATTEMPTS', async () => {
      prismaMock.parcel.findUnique.mockResolvedValue({
        id: 'p-1',
        trackingNumber: 'SD100000001',
        status: 'FAILED',
        deliveryAttempts: MAX_DELIVERY_ATTEMPTS,
      });

      await expect(
        service.transition('p-1', {
          to: 'OUT_FOR_DELIVERY',
          actor: { id: 'u-1', role: 'DISPATCHER' },
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.MAX_ATTEMPTS_REACHED,
        status: HttpStatus.CONFLICT,
      });
    });

    it('throws 409 CONFLICT on concurrent update (when updateMany matched 0 rows)', async () => {
      prismaMock.parcel.findUnique.mockResolvedValue({
        id: 'p-1',
        status: 'CREATED',
        deliveryAttempts: 0,
      });
      // Simulate race condition: another request transitioned the parcel first
      prismaMock.parcel.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.transition('p-1', {
          to: 'PICKED_UP',
          actor: { id: 'u-1', role: 'COURIER' },
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.CONFLICT,
        status: HttpStatus.CONFLICT,
      });
    });

    it('uses external transaction tx when passed (e.g., from courier proof upload)', async () => {
      const customTx: any = {
        parcel: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'p-1',
            status: 'OUT_FOR_DELIVERY',
            deliveryAttempts: 1,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({
            id: 'p-1',
            status: 'DELIVERED',
            deliveredAt: new Date(),
          }),
        },
        proofOfDelivery: {
          findUnique: jest.fn().mockResolvedValue({ id: 'pod-1' }),
        },
        parcelStatusHistory: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      await service.transition('p-1', {
        to: 'DELIVERED',
        actor: { id: 'c-1', role: 'COURIER' },
        tx: customTx,
      });

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(customTx.parcel.findUnique).toHaveBeenCalledWith({ where: { id: 'p-1' } });
      expect(customTx.proofOfDelivery.findUnique).toHaveBeenCalledWith({
        where: { parcelId: 'p-1' },
      });
      expect(outboxMock.enqueue).toHaveBeenCalledWith(
        customTx,
        'parcel.status_changed',
        expect.anything(),
      );
    });
  });

  describe('Public tracking & privacy controls', () => {
    it('returns privacy-safe projection with NO PII (no names, phones, street addresses, or notes)', async () => {
      const updatedAt = new Date('2026-10-26T10:00:00Z');
      const createdAt = new Date('2026-10-26T08:00:00Z');

      prismaMock.parcel.findUnique.mockResolvedValue({
        id: 'cuid-internal-123',
        trackingNumber: 'SD100000001',
        status: 'IN_TRANSIT',
        senderName: 'Private Sender',
        senderPhone: '+94771111111',
        pickupAddress: '123 Secret Lane',
        pickupCity: 'Colombo',
        recipientName: 'Private Recipient',
        recipientPhone: '+94772222222',
        dropoffAddress: '456 Confidential Road',
        dropoffCity: 'Kandy',
        internalNotes: 'Handle with extreme care, VIP package',
        updatedAt,
        statusHistory: [
          { toStatus: 'CREATED', createdAt, reason: null },
          { toStatus: 'PICKED_UP', createdAt: new Date('2026-10-26T09:00:00Z'), reason: null },
          { toStatus: 'IN_TRANSIT', createdAt: updatedAt, reason: null },
        ],
      });

      const tracking = await service.getPublicTracking('SD100000001');

      expect(tracking).toEqual({
        trackingNumber: 'SD100000001',
        status: 'IN_TRANSIT',
        originCity: 'Colombo',
        destinationCity: 'Kandy',
        updatedAt,
        history: [
          { status: 'CREATED', at: createdAt, reason: null },
          { status: 'PICKED_UP', at: new Date('2026-10-26T09:00:00Z'), reason: null },
          { status: 'IN_TRANSIT', at: updatedAt, reason: null },
        ],
      });

      // Explicit privacy checks
      const trackingRecord = tracking as any;
      expect(trackingRecord.id).toBeUndefined();
      expect(trackingRecord.senderName).toBeUndefined();
      expect(trackingRecord.senderPhone).toBeUndefined();
      expect(trackingRecord.pickupAddress).toBeUndefined();
      expect(trackingRecord.recipientName).toBeUndefined();
      expect(trackingRecord.recipientPhone).toBeUndefined();
      expect(trackingRecord.dropoffAddress).toBeUndefined();
      expect(trackingRecord.internalNotes).toBeUndefined();
    });

    it('throws 404 when tracking number is not found', async () => {
      prismaMock.parcel.findUnique.mockResolvedValue(null);

      await expect(service.getPublicTracking('SD999999999')).rejects.toMatchObject({
        code: ERROR_CODES.NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });
  });
});
