# Authorization matrix

Coordinated by M2. Every endpoint owner adds the negative tests listed here.
Detailed cross-module security review and gap analysis: [`docs/security-review.md`](../security-review.md).

| Role       | Allowed                                                                                   | Must NOT be able to                                                             | Negative test (owner)                         |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| Public     | estimate fee, public tracking (safe fields), register, merchant sign-up                   | anything else                                                                   | private endpoints return 401 (M2)             |
| CUSTOMER   | create/view **own** parcels, receipts, proof photo of own delivered parcel                | view another customer's parcel, receipt or courier notes                        | customer2 → customer's parcel = 404 (M3)      |
| MERCHANT   | portal: own merchant profile, keys, webhooks; API (key): create/list **own** parcels      | another merchant's orders/keys/webhooks; choose `merchantId`                    | merchant A key → merchant B parcel = 404 (M5) |
| COURIER    | **assigned** deliveries: view, status updates, proof                                      | parcels assigned to someone else or unassigned                                  | courier2 → courier1's parcel = 404 (M6)       |
| DISPATCHER | unassigned queue, assign/unassign, workload, zones & pricing, reports                     | user management, merchant approval, audit log, event ops                        | dispatcher → /admin/users = 403 (M2)          |
| ADMIN      | everything administrative (users, merchant approval, zones, pricing, reports, audit, ops) | bypass audit logging, read secrets (raw keys, webhook secrets, password hashes) | secrets never in responses (M5, M2)           |

## Endpoint → roles (summary)

| Prefix                                                                          | Roles                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `/auth/*`, `/pricing/estimate`, `/tracking/*`, `/merchants/register`, `/health` | public                                                  |
| `/users/me`                                                                     | any signed-in user                                      |
| `/parcels`, `/parcels/mine`, `/parcels/:id`, `/parcels/:id/receipt`             | CUSTOMER (own only)                                     |
| `/parcels/:id/proof/photo`                                                      | COURIER (own), CUSTOMER (own), DISPATCHER, ADMIN        |
| `/merchants/me/*`                                                               | MERCHANT (own)                                          |
| `/merchant/*`                                                                   | X-Api-Key (own merchant, APPROVED)                      |
| `/courier/*`                                                                    | COURIER (assigned only)                                 |
| `/dispatch/*`, `/admin/zones`, `/admin/pricing-rules`, `/admin/reports/*`       | DISPATCHER, ADMIN                                       |
| `/admin/users`, `/admin/merchants`, `/admin/audit-logs`, `/admin/ops/*`         | ADMIN                                                   |
| `/dev/*`                                                                        | only when `ENABLE_DEV_LOGIN=true` (never in production) |
