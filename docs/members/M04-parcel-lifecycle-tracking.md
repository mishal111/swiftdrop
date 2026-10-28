# M04: Parcel lifecycle & live tracking

> **Kick-off prompt for your agent**
> "I am M4 on SwiftDrop. Read AGENTS.md, then docs/members/M04-parcel-lifecycle-tracking.md,
> docs/contracts/parcel-lifecycle.md, docs/conventions/events.md and ADR-0004. Implement my Week-N tasks
> only inside my owned paths. Find stubs with `grep -rn "TODO(M4)\|notImplemented('M4')" apps packages`.
> Write unit + integration tests, then run `make check`."

## Mission

You are the **single source of truth for parcels**. You own:

- creation (tracking number, fee via pricing, initial history);
- every status transition (graph validation, history, outbox event, all in one transaction);
- public tracking with privacy controls;
- **live tracking over SSE**.

Every other module calls your service instead of touching parcel status.

## You own

- `apps/api/src/modules/parcels/` (ParcelsService, TrackingController, TrackingStreamService), `apps/api/test/parcels/`
- `packages/contracts/src/parcel-status.ts` (with M1), `packages/db/prisma/schema/parcel.prisma` (booking fields co-owned with M3), `packages/db/seed/30-parcels.ts`
- Web: `src/app/(public)/track/[trackingNumber]/`, `src/features/tracking/` (TrackForm, timeline, live hook)
- Doc: `docs/contracts/parcel-lifecycle.md`

## Interfaces you provide (signatures already in `parcels.service.ts`; keep them stable)

| Method                                                                             | Contract                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create(input: CreateParcelInput, actorRole): Promise<Parcel>`                     | `PricingService.estimate()` for the fee and zone ids → unique tracking number `SD#########` (retry on P2002) → one transaction: parcel (CREATED) + history row + `outbox.enqueue('parcel.created', …)`. Merchant orders are idempotent on `(merchantId, merchantReference)`: return the existing parcel.            |
| `transition(parcelId, { to, actor, failureReason?, note?, tx? }): Promise<Parcel>` | See the rules in docs/contracts/parcel-lifecycle.md: graph, required reason, max attempts, optimistic `where: { id, status: from }`, history + `outbox.enqueue('parcel.status_changed', …)`. Use `tx` when it's passed (M6 proof upload). Sets `deliveredAt` and increments `deliveryAttempts` on OUT_FOR_DELIVERY. |
| `findById`, `findByTrackingNumber`                                                 | ✅ done                                                                                                                                                                                                                                                                                                             |
| `getHistory(parcelId)`                                                             | Ordered history for owners and staff views                                                                                                                                                                                                                                                                          |
| `getPublicTracking(tn): PublicTrackingDto`                                         | **Privacy-safe projection only**: status, origin/destination city, history (status, at, reason code). 404 if not found.                                                                                                                                                                                             |
| Web `useLiveTracking(trackingNumber)` hook + `<TrackingTimeline>` component        | M3 (customer detail page)                                                                                                                                                                                                                                                                                           |

Callers do the _who_ checks (assignment, ownership). You do the _what_ checks (graph, required data).
Use the error codes `INVALID_STATUS_TRANSITION` (409), `FAILURE_REASON_REQUIRED` (422),
`PROOF_REQUIRED` (422) and `MAX_ATTEMPTS_REACHED` (409).

## SSE live tracking (ADR-0004)

- `TrackingStreamService.onModuleInit`: `rabbit.subscribeExclusive('api.sse.' + randomUUID(), ['parcel.status_changed.*'], handler)`.
  The handler validates with `parcelStatusChangedV1` and emits a `TrackingSseMessage`
  `{ trackingNumber, status, occurredAt }` onto the Subject.
- `streamFor(tn)` filters by tracking number. Merge in a heartbeat every 25 s (`interval` → a `{ type: 'ping' }`
  message) so proxies keep the connection open. Return 404 before streaming if the tracking number is unknown.
- Web: fetch the REST snapshot first, then `new EventSource('/api/v1/tracking/<tn>/events')`. On
  `status` events, update the timeline. On error, reconnect with backoff, and after repeated failures
  fall back to polling every 15 s.
- **End-to-end SSE needs M8's outbox relay.** Until it lands, you can test by publishing a message
  manually in the RabbitMQ UI (exchange `swiftdrop.events`, routing key `parcel.status_changed.v1`).

## Public tracking page (`/track/[trackingNumber]`)

- Status badge, origin → destination city, and a timeline with friendly labels (`STATUS_LABEL`).
  Live updates. Clear "not found" state.
- **Never show** names, phone numbers, street addresses, internal notes or internal ids.

## Tests required

- Unit: `transition` for every allowed and disallowed pair (table-driven), FAILED without a reason,
  max attempts, concurrent update (no row matched → 409), tracking-number format and collision retry.
- Integration (`test/parcels/`):
  - create → history row + outbox row exist in the same state;
  - invalid transition → 409 with `details`;
  - public tracking contains no PII (`expect(body).not.toHaveProperty('recipientName')`, no phone digits);
  - unknown tracking number → 404;
  - SSE endpoint responds with `text/event-stream`.
- E2E (with M10): the tracking page shows a live update after a courier status change (Week 4/5).

## Week-by-week

| Week | Tasks                                                                                                                 | Exit                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1    | **Confirm the status graph by day 2** (docs/contracts/parcel-lifecycle.md + contracts). Agree booking fields with M3. | Graph frozen                                                |
| 2    | `create`, `transition`, `getHistory`, public tracking API, seed.                                                      | **Create parcel + tracking retrievable** (vertical slice)   |
| 3    | Tracking page UI (snapshot), help M6/M7 integrate `transition`                                                        | Booking → courier update visible                            |
| 4    | SSE stream + `useLiveTracking` hook + timeline component (also used by M3)                                            | **Courier status change appears live on the tracking page** |
| 5    | Wire to M8's relay end to end, heartbeat, fallback polling                                                            | Live update in an integration test                          |
| 6    | Edge cases (re-attempt flow with M7), privacy review                                                                  | —                                                           |
| 7    | Full transition test matrix, E2E live-tracking spec                                                                   | Green                                                       |
| 8    | Demo steps 2 and 5, docs                                                                                              | —                                                           |

## Status / notes

- **Week 1-4 Core Complete**:
  - `ParcelsService.create`: Unique tracking number (`SD#########`) with collision retry, fee estimation via `PricingService`, merchant idempotency on `(merchantId, merchantReference)`, outbox event `parcel.created` in one transaction.
  - `ParcelsService.transition`: Complete state machine validation with `canTransition`, failure reason requirement for `FAILED` (422), proof check for `DELIVERED` (422), max delivery attempts limit (409), optimistic concurrency (`updateMany` count check → 409), history record and outbox event `parcel.status_changed` in one transaction. External `tx` supported for courier proof uploads.
  - `ParcelsService.getPublicTracking`: Zero-PII projection (only tracking number, status, cities, timestamps, failure reason code).
  - `TrackingStreamService` & `TrackingController`: SSE fan-out via RabbitMQ exclusive auto-delete queue (`api.sse.<uuid>`), in-memory filtering by tracking number, 404 validation for unknown tracking numbers, 25s ping heartbeats.
  - Frontend (`apps/web`): Public tracking page with server-side snapshot fetch, `<TrackingView>`, `<TrackingTimeline>` visual stepper and activity log, `<TrackForm>`, and `useLiveTracking` hook with EventSource, exponential backoff, and 15s polling fallback.
  - Tests: Full unit test suites (52 tests across service, stream, and controller) passing. Zero lint or typecheck errors.
  - Integration tests in `apps/api/test/parcels/parcels.e2e-spec.ts`: create → history + outbox row, transition writes all three together, invalid transition 409 with `details`, 422 for missing reason/proof, max attempts, concurrent transitions (one wins), public tracking has no PII, 404 for unknown numbers, SSE `text/event-stream`. `PricingService.estimate` is stubbed in the test until M7 lands.
- **Review fixes (merge):** a failure reason is only stored on FAILED transitions; the 409 for a concurrent update no longer includes the internal parcel id; the live hook re-fetches the snapshot when the stream opens and on each status event (no missed updates, no duplicate timeline rows, failure reasons shown); a FAILED parcel keeps its progress in the stepper; the track page tells "not found" apart from other errors; design tokens instead of hard-coded colours.
- **Known gaps:** `ParcelsService.create` only works once `PricingService.estimate` (M7) is implemented. The SSE stream has no end-to-end test through RabbitMQ yet. `useLiveTracking` takes an options object, not `(trackingNumber)` as the brief says; M3 should use the options form.
