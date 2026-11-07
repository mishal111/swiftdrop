# M09: Reporting, audit & operational insights

## Mission

Member 9 provides operational reporting, the Admin Overview dashboard, and an auditable history
of sensitive administrative actions. Reports use `ParcelStatusHistory` for delivery activity rather
than duplicating parcel status changes in the audit log.

## Ownership

- API: `apps/api/src/modules/reports/`, `apps/api/src/modules/audit/`
- API tests: `apps/api/test/reports/` and Member 9 unit tests beside the services
- Web: `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/admin/reports/`,
  `apps/web/src/app/admin/audit/`, and `apps/web/src/features/{reports,audit}/`
- Database ownership: `packages/db/prisma/schema/audit.prisma`

Member 9 does not own User Management, Zone Management, Pricing, Dispatch, Courier, or Merchant
workflows. Those modules provide data and audit integrations through their existing contracts.

## Reporting definitions

All report date ranges use `Asia/Colombo` calendar days. The default range is the last 30 days,
and ranges are limited to 366 days. The backend uses inclusive start-of-day and exclusive
next-day boundaries.

For the selected range:

- **Total parcels** is the number of unique parcels created in the range or having a terminal
  status event in the range.
- **Delivered** and **Failed** classify each parcel by its latest in-range terminal event.
- **In progress** is `total - delivered - failed`.
- **Success rate** is `delivered / (delivered + failed)`, or `0` when there are no terminal outcomes.
- **Daily created** counts parcel creation timestamps by Colombo calendar day.
- **Daily delivered/failed** counts the latest terminal event for each parcel on its event day.
- Daily results include zero rows for dates with no activity.

Repeated terminal transitions are not double-counted. For example, Failed -> Delivered contributes
to Delivered only; Delivered -> Failed contributes to Failed only.

Courier Performance preserves the existing assignment attribution contract: assignments in the
selected date range remain attributed to the courier recorded on each assignment. Delivered and
failed outcome columns now use one latest terminal outcome per parcel, so one parcel cannot
contribute to both outcome columns within the same assignment/report scope.

All report SQL uses parameterized Prisma tagged SQL. No raw query concatenates user input.

## API endpoints

The application global prefix is `/api/v1`.

| Endpoint                                 | Roles             | Query                                                                           | Output                                                                 |
| ---------------------------------------- | ----------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/v1/admin/reports/deliveries`   | ADMIN, DISPATCHER | `from`, `to`, `zoneId`                                                          | `{ total, delivered, failed, inProgress, successRate }`                |
| `GET /api/v1/admin/reports/daily-volume` | ADMIN, DISPATCHER | `from`, `to`, `zoneId`                                                          | Daily `{ date, created, delivered, failed }` rows, including zero days |
| `GET /api/v1/admin/reports/couriers`     | ADMIN, DISPATCHER | `from`, `to`, `zoneId`                                                          | `{ courierId, name, assigned, delivered, failed }` rows                |
| `GET /api/v1/admin/zones`                | ADMIN, DISPATCHER | None                                                                            | Configured delivery zones from Member 7                                |
| `GET /api/v1/admin/audit-logs`           | ADMIN             | `action`, `entityType`, `entityId`, `actorId`, `from`, `to`, `page`, `pageSize` | Paginated audit entries                                                |
| `GET /api/v1/admin/audit-logs/users`     | ADMIN             | `search`, `page`, `pageSize`                                                    | Paginated `{ id, name, email }` lookup rows                            |

Audit log responses include actor details when the actor still exists and affected-person details
for current User records. Historical audit rows remain visible when an affected user is renamed,
deactivated, or deleted; deleted users have no current name/email enrichment.

Pagination is capped by the shared API maximum of 100 rows per page. The audit person lookup is
name-only, partial, and case-insensitive. The UI loads the first page, provides **Load more users**
for later pages, deduplicates by user ID, and ignores stale responses from older searches.

## Zone filtering

The Reports page loads zones dynamically from `GET /api/v1/admin/zones`. It displays **All zones**
by default and uses the returned `DeliveryZone.id` as the option value; zone names and codes are
display labels only.

The selected `zoneId` is sent consistently to:

- Delivery summary
- Daily delivery volume
- Courier performance

The frontend does not contain hardcoded district names and does not create zones. The endpoint is
owned by Member 7's Zone Management/Pricing module and is currently a team-integration dependency:
the repository exposes the controller contract, but `PricingService.listZones()` is still stubbed.
If zone loading fails, the UI shows an explicit unavailable message rather than treating failure as
a valid empty zone list.

## Admin Overview

`/admin` is ADMIN-only and displays:

- Total, delivered, failed, in-progress, and success-rate KPI cards
- Daily activity bars for created and latest terminal events
- Courier performance
- Recent audit activity
- Links to detailed Reports and Audit Logs

Summary, daily volume, courier, and audit requests are tracked independently. A failed request
shows a safe section-level error and does not replace successful sections with zeroes or fabricated
empty data. Genuine zero values and successful empty results remain distinct from failures.
A Retry button reloads the overview requests without an automatic retry loop.

## Reports page and CSV export

`/admin/reports` is available to ADMIN and DISPATCHER users. It provides date filters, dynamic
zone filtering, KPI cards, daily activity, courier performance, loading/error/empty states, and
client-side CSV export of the currently loaded filtered data.

CSV cells preserve normal quoting and escaping for commas, quotes, and line breaks. Untrusted text
whose first non-whitespace character is `=`, `+`, `-`, or `@` is prefixed with an apostrophe before
CSV escaping. Numeric report values are not modified. This prevents spreadsheet formula injection
without changing report calculations or column headings.

## Audit Logs page

`/admin/audit` is ADMIN-only. It supports:

- **Search by Person:** partial, case-insensitive name search
- **Email address:** dropdown selection to distinguish identical names
- **Entity ID:** automatically populated from the selected database user ID and read-only, with Copy ID
- **Start date:** required for person-search mode
- **End date:** optional and inclusive; it must not precede Start date
- Action, entity type, entity ID, and actor ID advanced filters
- **All Activity:** general audit investigation without person/date-search requirements
- Newest-first ordering, pagination, loading, error, empty, and retry states

Changing the person name clears the selected email and Entity ID. Changing mode clears person
selection state. Search requests are debounced and protected against stale responses.

Audit metadata is recursively sanitized for password, token, secret, API-key, authorization, and
cookie keys. Role-change details show only recorded previous/new role values; missing values are
not invented. Actor and affected-person responses expose only the fields required by the table.

## Audit service interface

Other modules record sensitive actions through the global service:

```ts
AuditService.record(
  { actor, action, entityType, entityId, metadata?, ip? },
  tx?,
)
```

Metadata is limited to small, non-sensitive context such as IDs and before/after values of
non-PII fields. Passwords, tokens, secrets, API keys, addresses, and phone numbers must not be
recorded.

The published action vocabulary is:

`user.created`, `user.role_changed`, `user.deactivated`, `user.status_changed`, `user.updated`,
`merchant.approved`, `merchant.rejected`, `merchant.suspended`, `api_key.created`,
`api_key.revoked`, `webhook.secret_rotated`, `zone.created`, `zone.updated`,
`pricing_rule.created`, `pricing_rule.updated`, `parcel.assigned`, `parcel.unassigned`,
`webhook_attempt.retried`.

Currently verified integrations include User Management role/status/create events and Event Ops
webhook retry events. Merchant, Zone/Pricing, Dispatch, Courier, and other parcel-operation audit
events remain dependent on their owners' implementations. Parcel status changes remain in
`ParcelStatusHistory` and are consumed by Reports rather than duplicated as audit records.

## Authorization

- Reports endpoints: ADMIN and DISPATCHER
- Audit log and audit user lookup endpoints: ADMIN
- Admin Overview page: ADMIN
- Reports page: ADMIN or DISPATCHER
- Audit page: ADMIN

Authentication is enforced by the global JWT guard and role checks by the global roles guard.

## Tests and verification

Member 9 API unit coverage includes:

- Success-rate and divide-by-zero behavior
- Default and maximum date ranges
- Reversed dates and Colombo boundaries
- Zero-filled daily periods
- In-range creation/completion semantics
- Older parcels completed during the range
- Later completion and in-progress parcels
- Repeated terminal transitions in both directions
- Zone-filter-compatible report calculations
- Audit ordering, filters, pagination, metadata sanitization
- Minimal user lookup fields, duplicate names, empty results, and later pages

The configured API and web TypeScript checks, Member 9 API tests, ESLint, Prettier, and
`git diff --check` have passed in the current branch. Frontend component tests are not currently
configured. End-to-end verification remains pending until the dependent M5, M6, and M7 modules
and a safe integration test environment are available.

## Integration checklist

After teammate branches are merged, verify:

1. `GET /api/v1/admin/zones` returns real active zones and stable IDs.
2. Zone IDs match parcel pickup/dropoff zone fields.
3. Reports work for All zones and each configured zone across all three report sections.
4. Courier assignments and reassignment history match the preserved attribution contract.
5. Parcel status transitions are written atomically to `ParcelStatusHistory`.
6. User, merchant, zone, pricing, dispatch, courier, and webhook audit events appear with safe metadata.
7. ADMIN, DISPATCHER, and CUSTOMER authorization behavior matches the endpoint table.
8. Deleted users leave historical audit rows visible without invented identity details.
9. CSV exports remain safe when courier names contain formula-like text.
10. Overview partial failures preserve successful sections and Retry recovers temporary failures.

## Status and dependencies

Member 9's reporting, audit, overview, zone-filtering, CSV-hardening, lookup-pagination, and
latest-outcome changes are implemented in this branch. Remaining runtime dependencies are owned by:

- **M7:** Zone Management/Pricing endpoint and Dispatch assignment lifecycle
- **M6:** Courier profiles and courier workflow
- **M5:** Merchant workflows and merchant audit events
- **M4:** Complete parcel lifecycle/status-history integration where applicable

These dependencies must be verified after integration; Member 9 does not implement them here.

## Review fixes (merge of PR #10)

- **Courier performance** credits each outcome to the courier whose assignment was current when it
  happened (latest DELIVERED/FAILED after that assignment and before the parcel's next one). Joining
  on the parcel alone gave a reassigned parcel's delivery to every courier and hid the first
  courier's failure. Integration test: courier 1 fails, parcel reassigned, courier 2 delivers.
- Integration tests now run the real SQL for "failed, re-attempted, delivered = one delivery", and
  cover 401s, 403s for every non-allowed role, 400s for bad ranges, and the user lookup endpoint.
  The audit test uses dates relative to today (it hard-coded 2027).
- Audit: the action filter uses M5's real name `webhook_secret.rotated` and drops `user.deactivated`
  (deactivation is recorded as `user.status_changed`); entity-type filter is case-insensitive;
  `search` is required and trimmed; sanitised metadata keeps `null` values.
- CSV export also neutralises cells starting with a tab or carriage return. Dashboards show an
  error instead of a stuck spinner on network failures.
- **Follow-ups:** `summarizeActivity` in `reports.service.ts` is only used by unit tests (the real
  numbers come from SQL); remove it or use it. `GET /admin/audit-logs` has no `@ApiOkResponse`, so
  the web code casts its response. A parcel re-attempted after FAILED counts as failed until it is
  delivered.
