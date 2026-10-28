# SwiftDrop — Security Review & Negative-Test Gap Analysis

> **Lead Author / Coordinator**: Member 2 (Authentication & User Management)  
> **Target Release**: Week 7 Milestone  
> **Reference Guidelines**: [`docs/conventions/security.md`](conventions/security.md), [`docs/contracts/authorization-matrix.md`](contracts/authorization-matrix.md), [`AGENTS.md`](../AGENTS.md)

---

## 1. Executive Summary

This security review audits the SwiftDrop API architecture against the project's security conventions and authorization contracts. All 14 API modules have been examined for:

1. **Authentication & Session Security** (passwords, tokens, PKCE, throttling)
2. **Role-Based Access Control (RBAC)** (guards, negative role boundaries)
3. **Object-Level Tenancy** (horizontal privilege escalation, IDOR prevention)
4. **Data Protection & Privacy** (sanitization of safe tracking fields, zero PII in events/logs)
5. **Secret Management & Cryptography** (Argon2id, AES-256-GCM, SHA-256 key hashing)
6. **Auditability & Traceability** (tamper-evident audit logging of sensitive admin actions)

All role-level access boundaries have been validated via **79 automated integration tests** in `apps/api/test/auth-matrix/auth-matrix.e2e-spec.ts`. This document establishes the formal **Negative-Test Gap List** assigning object-level negative tests to each module owner.

---

## 2. Security Domain Checklist & Audit Findings

### 2.1 Authentication & Session Management (M2) — ✅ PASSED

- [x] **Password Storage**: Passwords hashed with `argon2id` (`argon2.hash(pw, { type: argon2.argon2id })`). Password hashes are never exposed in user DTOs or logs.
- [x] **Timing-Attack Resistance**: When logging in with an unknown email, the service executes a dummy Argon2 hash verification to ensure execution time remains constant regardless of email existence.
- [x] **Access JWTs**: Short-lived (15 minutes), signed with `HS256`, strictly verifying `issuer` and `audience` claims. Minimal payload (`sub`, `email`, `role`).
- [x] **Refresh Token Rotation**: Refresh tokens are 256-bit cryptographically secure random values (base64url). Only the `SHA-256` hash is persisted. Tokens are rotated on every use; the replaced session is linked via `replacedById`.
- [x] **Breach Chain Detection**: If an already-rotated (revoked) refresh token is submitted, the system flags a potential token replay attack, immediately revokes all active sessions for that user, and denies access (`UNAUTHENTICATED`).
- [x] **Real-Time Deactivation Hardening**: `JwtAuthGuard` includes an in-memory 60-second status cache that re-checks `user.isActive`. Deactivated users are blocked with `403 ACCOUNT_DISABLED` immediately without waiting for JWT access expiration.
- [x] **Google OAuth 2.0 PKCE**: Authorization code flow enforced with cryptographic `state` and PKCE code challenge. Verification cookies (`sd_oauth_state`, `sd_oauth_verifier`) are `httpOnly`, `SameSite=Lax`. ID tokens are verified server-side using `google-auth-library` against client ID audience and verified email status. Client-supplied profile payloads are strictly ignored.
- [x] **Rate Limiting**: `POST /api/v1/auth/*` endpoints enforce strict `@Throttle({ default: { limit: 10, ttl: 60_000 } })`, returning `429 RATE_LIMITED`.

### 2.2 Role-Based Access Control (RBAC) (M1, M2) — ✅ PASSED

- [x] **Global Guard Pipeline**: NestJS `APP_GUARD` pipeline executes `ThrottlerGuard` → `JwtAuthGuard` → `RolesGuard` globally. Private routes require authentication by default; only explicit `@Public()` routes bypass JWT checks.
- [x] **Perimeter Authorization**: All 5 system roles (`CUSTOMER`, `COURIER`, `MERCHANT`, `DISPATCHER`, `ADMIN`) are locked to their authorized endpoints.
- [x] **Automated Verification**: Role boundary combinations tested and verified in `apps/api/test/auth-matrix/auth-matrix.e2e-spec.ts` (79/79 passing).

### 2.3 Object-Level Tenancy & Horizontal Access Control (M3, M5, M6, M7) — ⚠️ IN PROGRESS (Owners M3, M5, M6)

- [x] **Tenancy Pattern Defined**: Cross-user resource lookups MUST query by object ID _and_ tenant ID (e.g. `where: { id, customerId: user.id }`). Missing matches must return HTTP `404 NOT_FOUND` rather than `403 FORBIDDEN` to prevent ID harvesting/existence leaks.
- [x] **Merchant Tenancy Enforced**: `req.merchantId` is extracted strictly from the verified session or `X-Api-Key` header via `ApiKeyGuard`. `MerchantCreateParcelDto` prohibits client-supplied `merchantId`.
- [ ] **Customer Object Tenancy (M3)**: Verification that Customer B cannot view or download receipts for Customer A's parcel (`GET /api/v1/parcels/:id` and `GET /api/v1/parcels/:id/receipt` returning 404).
- [ ] **Courier Assignment Tenancy (M6)**: Verification that Courier B cannot update status or submit proof for Courier A's assigned parcel (`PATCH /api/v1/courier/parcels/:id/status` returning 404).
- [ ] **Merchant Partner Tenancy (M5)**: Verification that Merchant B's API key cannot access Merchant A's parcel (`GET /api/v1/merchant/parcels/:trackingNumber` returning 404).

### 2.4 Secret Management & Cryptography (M5, M8) — ✅ DESIGN VERIFIED

- [x] **Merchant API Keys (M5)**: Keys follow format `sd_live_<8-char-prefix>_<32-byte-secret>`. Persisted as prefix and `sha256(secret)`. Transmitted exclusively via `X-Api-Key` header; never accepted in query strings or path parameters. Logger automatically redacts `x-api-key`.
- [x] **Webhook Secret Encryption (M8)**: Webhook signing secrets encrypted at rest using AES-256-GCM via `WEBHOOK_SECRET_ENC_KEY`. HMAC signatures (`sha256=<sig>`) computed over payload for delivery verification.
- [x] **Zero Secrets in Repository**: `.env` is gitignored. `.env.example` provides empty/mock placeholders only. `ENABLE_DEV_LOGIN` is rejected in production mode.

### 2.5 Privacy & Data Protection (M4, M8, M9) — ✅ DESIGN VERIFIED

- [x] **Safe Public Tracking (M4)**: `GET /api/v1/tracking/:trackingNumber` projects safe fields only: `trackingNumber`, `status`, `originCity`, `destinationCity`, and status history timestamps with reason codes. Recipient names, phone numbers, full street addresses, and courier notes are omitted.
- [x] **PII-Free Domain Events (M8)**: Outbox events contain identifiers (`parcelId`, `trackingNumber`, `actorId`), statuses, and timestamps. Personal contact details and delivery notes are excluded from RabbitMQ event payloads.
- [x] **Proof of Delivery Uploads (M6)**: Multipart photo uploads restricted to image types and 5MB max file size. Stored in private S3 bucket with server-generated UUID object keys; streamed through authenticated API endpoint (`GET /api/v1/parcels/:id/proof/photo`).
- [x] **Audit Logging (M9)**: `AuditService.record()` captures administrative actions (`action`, `actorId`, `actorRole`, `entityType`, `entityId`, `metadata`, `ip`). Metadata excludes passwords, secrets, tokens, or customer phone/address data.

---

## 3. Negative-Test Gap List (Cross-Module Action Items)

The following matrix identifies required negative test cases for each API owner. While role-level guards (`RolesGuard`) prevent unauthorized roles, each module owner must implement object-level negative authorization tests in their respective `test/<module>/` suites.

| Module           | Endpoint                                            | Scenario                                              | Expected Status & Code                       | Owner | Status                       |
| :--------------- | :-------------------------------------------------- | :---------------------------------------------------- | :------------------------------------------- | :---- | :--------------------------- |
| **Auth**         | `POST /api/v1/auth/login`                           | Wrong password                                        | `401 INVALID_CREDENTIALS`                    | M2    | ✅ Implemented               |
| **Auth**         | `POST /api/v1/auth/login`                           | Disabled user account                                 | `403 ACCOUNT_DISABLED`                       | M2    | ✅ Implemented               |
| **Auth**         | `POST /api/v1/auth/refresh`                         | Reused / rotated refresh token                        | `401 UNAUTHENTICATED` (chain revoked)        | M2    | ✅ Implemented               |
| **Auth**         | `GET /api/v1/users/me`                              | Existing access token after deactivation              | `403 ACCOUNT_DISABLED`                       | M2    | ✅ Implemented               |
| **Auth**         | `POST /api/v1/auth/login`                           | Rate limit exceeded (>10 req/min)                     | `429 RATE_LIMITED`                           | M2    | ✅ Implemented               |
| **Bookings**     | `GET /api/v1/parcels/:id`                           | Customer A queries Customer B's parcel                | `404 NOT_FOUND`                              | M3    | ⚠️ Pending M3 implementation |
| **Bookings**     | `GET /api/v1/parcels/:id/receipt`                   | Customer A downloads Customer B's receipt             | `404 NOT_FOUND`                              | M3    | ⚠️ Pending M3 implementation |
| **Parcels**      | `POST /api/v1/parcels`                              | Invalid state transition (e.g. CREATED → DELIVERED)   | `400 INVALID_STATUS_TRANSITION`              | M4    | ⚠️ Pending M4 implementation |
| **Parcels**      | `GET /api/v1/tracking/:number`                      | Non-existent tracking number                          | `404 NOT_FOUND`                              | M4    | ⚠️ Pending M4 implementation |
| **Merchants**    | `GET /api/v1/merchants/me/api-keys`                 | Non-merchant accessing portal keys                    | `403 FORBIDDEN`                              | M5    | ✅ Covered in auth-matrix    |
| **Merchant API** | `GET /api/v1/merchant/parcels/:tracking`            | Merchant A API key queries Merchant B parcel          | `404 NOT_FOUND`                              | M5    | ⚠️ Pending M5 implementation |
| **Merchant API** | `POST /api/v1/merchant/parcels`                     | Missing or invalid API key                            | `401 INVALID_API_KEY`                        | M5    | ✅ Covered in auth-matrix    |
| **Merchant API** | `POST /api/v1/merchant/parcels`                     | Unapproved (PENDING) merchant API key                 | `403 MERCHANT_NOT_APPROVED`                  | M5    | ⚠️ Pending M5 implementation |
| **Courier**      | `GET /api/v1/courier/parcels/:id`                   | Courier A queries parcel assigned to Courier B        | `404 NOT_FOUND`                              | M6    | ⚠️ Pending M6 implementation |
| **Courier**      | `PATCH /api/v1/courier/parcels/:id/status`          | Courier updates unassigned parcel                     | `404 NOT_FOUND`                              | M6    | ⚠️ Pending M6 implementation |
| **Courier**      | `POST /api/v1/courier/parcels/:id/proof`            | Upload proof without photo or non-image MIME          | `400 UNSUPPORTED_FILE` / `VALIDATION_FAILED` | M6    | ⚠️ Pending M6 implementation |
| **Courier**      | `GET /api/v1/parcels/:id/proof/photo`               | Unauthorized customer views photo of another's parcel | `404 NOT_FOUND`                              | M6    | ⚠️ Pending M6 implementation |
| **Dispatch**     | `POST /api/v1/dispatch/assignments`                 | Assign parcel already assigned to active courier      | `409 ALREADY_ASSIGNED`                       | M7    | ⚠️ Pending M7 implementation |
| **Dispatch**     | `POST /api/v1/dispatch/assignments`                 | Assign to inactive or unavailable courier             | `400 COURIER_UNAVAILABLE`                    | M7    | ⚠️ Pending M7 implementation |
| **Pricing**      | `POST /api/v1/pricing/estimate`                     | Request quote for unserviced city                     | `400 ZONE_NOT_SERVICED`                      | M7    | ⚠️ Pending M7 implementation |
| **Audit**        | `GET /api/v1/admin/audit-logs`                      | Non-admin role attempting audit retrieval             | `403 FORBIDDEN`                              | M9    | ✅ Covered in auth-matrix    |
| **Event Ops**    | `POST /api/v1/admin/ops/webhook-attempts/:id/retry` | Non-admin attempting manual webhook replay            | `403 FORBIDDEN`                              | M8    | ✅ Covered in auth-matrix    |

---

## 4. Verification & Recommendations

1. **For Module Owners (M3–M9)**: As vertical slices are completed, each owner must copy their corresponding test case from the table above into their integration test suite (`test/<module>/<module>.e2e-spec.ts`).
2. **Tenancy Query Rule**: Always structure database queries with the tenant identifier in the `where` clause:
   ```ts
   // Recommended
   const parcel = await tx.parcel.findFirst({
     where: { id: parcelId, customerId: user.id },
   });
   if (!parcel) throw notFound('Parcel');
   ```
3. **Audit Log Coverage**: Ensure every state-altering administrative endpoint calls `AuditService.record()` within the same database transaction.
