import { HttpStatus } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { TrackingController } from './tracking.controller';

describe('TrackingController (Unit)', () => {
  let controller: TrackingController;
  let parcelsMock: any;
  let streamMock: any;

  beforeEach(() => {
    parcelsMock = {
      getPublicTracking: jest.fn(),
      findByTrackingNumber: jest.fn(),
    };

    streamMock = {
      streamFor: jest.fn(),
    };

    controller = new TrackingController(parcelsMock, streamMock);
  });

  it('delegates get(:trackingNumber) to ParcelsService.getPublicTracking', async () => {
    const trackingData = {
      trackingNumber: 'SD123456789',
      status: 'IN_TRANSIT',
      originCity: 'Colombo',
      destinationCity: 'Kandy',
      updatedAt: new Date(),
      history: [],
    };
    parcelsMock.getPublicTracking.mockResolvedValue(trackingData);

    const result = await controller.get('SD123456789');
    expect(result).toBe(trackingData);
    expect(parcelsMock.getPublicTracking).toHaveBeenCalledWith('SD123456789');
  });

  it('throws 404 in events(:trackingNumber) if tracking number is unknown', async () => {
    parcelsMock.findByTrackingNumber.mockResolvedValue(null);

    await expect(controller.events('SD999999999')).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('streams status changes and heartbeats when tracking number exists', async () => {
    parcelsMock.findByTrackingNumber.mockResolvedValue({
      id: 'p-1',
      trackingNumber: 'SD123456789',
    });

    const statusEvent = {
      trackingNumber: 'SD123456789',
      status: 'DELIVERED',
      occurredAt: '2026-10-26T12:00:00.000Z',
    };

    const { of } = await import('rxjs');
    streamMock.streamFor.mockReturnValue(of(statusEvent));

    const observable = await controller.events('SD123456789');
    const firstEvent = await firstValueFrom(observable);

    expect(firstEvent).toEqual({
      type: 'status',
      data: statusEvent,
    });
  });
});
