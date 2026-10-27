import { TrackingStreamService } from './tracking-stream.service';

describe('TrackingStreamService (Unit)', () => {
  let service: TrackingStreamService;
  let rabbitMock: any;
  let messageHandler: ((payload: unknown) => void) | undefined;

  beforeEach(() => {
    rabbitMock = {
      subscribeExclusive: jest.fn().mockImplementation((queueName, bindingKeys, handler) => {
        messageHandler = handler;
        return Promise.resolve();
      }),
    };

    service = new TrackingStreamService(rabbitMock);
  });

  it('subscribes to exclusive queue and filters stream by trackingNumber', async () => {
    await service.onModuleInit();

    expect(rabbitMock.subscribeExclusive).toHaveBeenCalledWith(
      expect.stringMatching(/^api\.sse\..+/),
      ['parcel.status_changed.*'],
      expect.any(Function),
    );

    const tn1$ = service.streamFor('SD100000001');
    const tn2$ = service.streamFor('SD100000002');

    const receivedEventsTn1: any[] = [];
    const receivedEventsTn2: any[] = [];

    const sub1 = tn1$.subscribe((ev) => receivedEventsTn1.push(ev));
    const sub2 = tn2$.subscribe((ev) => receivedEventsTn2.push(ev));

    // Simulate domain event from RabbitMQ
    messageHandler!({
      eventId: '11111111-1111-4111-8111-111111111111',
      eventType: 'parcel.status_changed',
      eventVersion: 1,
      occurredAt: '2026-10-26T14:00:00.000Z',
      correlationId: 'req-1',
      data: {
        parcelId: 'p-1',
        trackingNumber: 'SD100000001',
        merchantId: null,
        customerId: 'cust-1',
        previousStatus: 'CREATED',
        newStatus: 'PICKED_UP',
        actorRole: 'COURIER',
      },
    });

    expect(receivedEventsTn1).toHaveLength(1);
    expect(receivedEventsTn1[0]).toEqual({
      trackingNumber: 'SD100000001',
      status: 'PICKED_UP',
      occurredAt: '2026-10-26T14:00:00.000Z',
    });

    // The other tracking number stream should NOT receive SD100000001 events
    expect(receivedEventsTn2).toHaveLength(0);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  it('ignores invalid event payloads safely', async () => {
    await service.onModuleInit();

    const stream$ = service.streamFor('SD100000001');
    const received: any[] = [];
    const sub = stream$.subscribe((ev) => received.push(ev));

    // Non-conforming payload
    messageHandler!({ invalid: true });

    expect(received).toHaveLength(0);
    sub.unsubscribe();
  });
});
