# M02: Authentication & user management

> **Kick-off prompt for your agent**
> "I am M2 on SwiftDrop. Read AGENTS.md, then docs/members/M02-auth-users.md, docs/conventions/security.md
> and docs/architecture/adr/0003-cookie-auth.md. Implement my Week-N tasks only inside my owned paths.
> Find stubs with `grep -rn "TODO(M2)\|notImplemented('M2')" apps packages`. Write unit + integration
> tests including negative authorization cases, then run `make check`."

## Mission

Secure sign-in for every role (password + Google OAuth), session management with rotating refresh
tokens, user/staff management for admins, and **coordination of authorization testing across the
team**.

## You own

- `apps/api/src/modules/auth/`, `apps/api/src/modules/users/`
- `apps/api/src/common/auth/` (JwtAuthGuard, RolesGuard, decorators, TokenService); M1 built it and hands it over in Week 1
- `apps/api/test/auth/`, `apps/api/test/auth-matrix/`
- `packages/db/prisma/schema/auth.prisma`, `packages/db/seed/00-users.ts`
- Web: `src/app/(public)/login/`, `src/app/(public)/register/`, `src/app/admin/users/`,
  `src/features/auth/`, `src/proxy.ts`, `src/lib/auth/`

## Do not edit (ask the owner)

Other modules' controllers and services, `app.module.ts` (M1), and `components/ui` (M1/M10).

## Interfaces you provide

| Interface                                                                                            | Used by                                   |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `UsersService.findById / findByEmail / createUser({ email, name, role, password?, phone? }) / toDto` | M5 (merchant sign-up), M7 (couriers list) |
| `@Public()`, `@Roles()`, `@CurrentUser()`, `AuthUser`, global `JwtAuthGuard` / `RolesGuard`          | everyone                                  |
| `TokenService.signAccessToken / setAccessCookie / setRefreshCookie / clearAuthCookies`               | auth, dev-login                           |
| `getSession()`, `requireRole()` (web)                                                                | all portal layouts                        |
| `ERROR_CODES.INVALID_CREDENTIALS / EMAIL_TAKEN / ACCOUNT_DISABLED`                                   | web forms                                 |

## Endpoints (stubs exist; implement them)

| Endpoint                                          | Notes                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                             | Always creates a **CUSTOMER**. Normalise the email to lower case; 409 `EMAIL_TAKEN`. Starts a session.                                                                                                                                                                                                                                                                            |
| `POST /auth/login`                                | argon2id verify. Return the same `INVALID_CREDENTIALS` for an unknown email and a wrong password; 403 `ACCOUNT_DISABLED`.                                                                                                                                                                                                                                                         |
| `POST /auth/refresh`                              | Rotate: revoke the old `RefreshSession` and create a new one with `replacedById`. **If a revoked token is reused, revoke the whole chain.**                                                                                                                                                                                                                                       |
| `POST /auth/logout`                               | Revoke the session and clear cookies.                                                                                                                                                                                                                                                                                                                                             |
| `GET /auth/google` → `GET /auth/google/callback`  | Authorization code + `state` + PKCE (`google-auth-library` `OAuth2Client`, `generateCodeVerifierAsync`). Store state and verifier in short-lived httpOnly cookies. Verify the `id_token` (audience = client id, `email_verified`). Link via `OAuthAccount`; create a CUSTOMER if new. Redirect to the role home. If `GOOGLE_CLIENT_ID` is empty, return 501 with a clear message. |
| `GET /users/me`                                   | ✅ already works.                                                                                                                                                                                                                                                                                                                                                                 |
| `PATCH /users/me`                                 | Name and phone only.                                                                                                                                                                                                                                                                                                                                                              |
| `GET/POST /admin/users`, `PATCH /admin/users/:id` | ADMIN. Create staff (COURIER also creates a `CourierProfile`). Change role or active flag. Deactivating revokes sessions. **Audit** each change via `AuditService.record`.                                                                                                                                                                                                        |

Refresh token format: 32 random bytes, base64url. Store `sha256(token)` in `RefreshSession.tokenHash`
and set `expiresAt` from `JWT_REFRESH_TTL_DAYS`.

Optional hardening: have `JwtAuthGuard` re-check `isActive` (cache for about 60 s) so a deactivated
user loses access quickly.

## Web pages

- `/login`: the `LoginForm` exists. Add a "Sign in with Google" button (`<a href="/api/v1/auth/google">`).
  Keep the dev login panel (M1 removes it for the final demo).
- `/register`: customer sign-up form → `POST /auth/register` → redirect to `home`.
- `/admin/users`: table with role and status filters, a create-staff form and a role/active toggle.
- Silent refresh: when an API call returns 401, call `POST /auth/refresh` once and retry. Put it in a
  small wrapper in `src/features/auth/`. Also make `LogoutButton` stop needing the dev fallback.

## Data you own

`User`, `RefreshSession`, `OAuthAccount` and the `Role` enum (it must match `ROLES` in contracts;
a parity test enforces this).

## Security rules

argon2id; constant-ish time failures; strict throttling on `/auth/*` (already 10/min); never return
`passwordHash`; never log credentials; OAuth `state` must match; cookies are httpOnly + SameSite=Lax
(+ Secure in production). Read docs/conventions/security.md fully.

## Tests required

- Unit: refresh rotation and reuse detection; password policy; Google profile → user linking.
- Integration (`test/auth/`):
  - register → `/users/me`;
  - login wrong password → 401 `INVALID_CREDENTIALS`;
  - disabled user → 403;
  - refresh rotates the cookie;
  - reused refresh token → 401 and the chain is revoked;
  - logout clears cookies;
  - non-admin → `/admin/users` = 403.
- **Coordination:** you own `test/auth-matrix/`. Extend it as modules land, and chase every API
  owner to add object-level negative tests (see docs/contracts/authorization-matrix.md).

## Week-by-week

| Week | Tasks                                                                                                | Exit                                                           |
| ---- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | Take over `common/auth`. Agree role names and tenancy rules with M5. Review the `auth.prisma` model. | Contracts agreed                                               |
| 2    | register, login, logout, refresh, `/users/me` PATCH. Web login and register pages.                   | A customer can register, sign in and sign out (vertical slice) |
| 3    | Admin user management API + page. Staff creation for couriers (with M7).                             | Admin creates a courier who can sign in                        |
| 4    | Google OAuth end to end. Silent refresh in the web app.                                              | Google sign-in works with test credentials                     |
| 5    | Authorization matrix tests for every module that exists. Deactivation revokes sessions.              | Auth matrix green                                              |
| 6    | Edge cases, rate limits, polish, remove the dev-logout fallback                                      | Journeys work without dev login                                |
| 7    | Security review of all modules (checklist) and the negative-test gap list                            | Evidence recorded                                              |
| 8    | Docs, demo of the Google login, contribution notes                                                   | —                                                              |

## Status / notes

- **Week 1-2 (Completed):**
  - Full authentication slice implemented: registration (CUSTOMER), argon2id login, refresh token rotation with token reuse breach detection revoking entire session chains, logout, and `/users/me` PATCH (name, phone).
  - Google OAuth 2.0 PKCE end-to-end integration with account linking and automatic role routing.
  - Web UI: `/register` (RegisterForm with Google button), `/login` (LoginForm with Google button), LogoutButton hitting `/api/v1/auth/logout`, and silent refresh 401 retry wrapper.
  - Comprehensive integration test suite in `apps/api/test/auth/auth.e2e-spec.ts` (13/13 tests passing).
- **Week 3 (Completed):**
  - Admin user management endpoints: `GET /api/v1/admin/users` (pagination, search, role filters), `POST /api/v1/admin/users` (staff creation with automatic `CourierProfile` provisioning for COURIERs and audit logging), `PATCH /api/v1/admin/users/:id` (role change, active status toggle; deactivation immediately revokes all refresh sessions and writes audit logs).
  - Web UI: `/admin/users` dashboard (`AdminUsersDashboard`, `CreateStaffModal`) with server-side role check (`requireRole(['ADMIN'])`), role filter pills, search input, status badge, role modifier, activate/deactivate toggle, and modal for creating staff accounts.
  - Integration tests added verifying courier creation + login (Week 3 exit criterion) and admin deactivation session revocation.
- **Week 4 (Completed):**
  - Google OAuth 2.0 PKCE flow end-to-end: `/api/v1/auth/google` (state and PKCE verifier cookies), `/api/v1/auth/google/callback` (Google ID token verification, account linking, customer provisioning, auth cookie issuance), and inline OAuth error display on web forms (`LoginForm`, `RegisterForm`).
  - Silent refresh retry wrapper in `apps/web/src/lib/api/client.ts` automatically refreshing expired access tokens on 401s.
- **Week 5 (Completed):**
  - Expanded team-wide Authorization Matrix e2e test suite (`apps/api/test/auth-matrix/auth-matrix.e2e-spec.ts`) covering `docs/contracts/authorization-matrix.md` across all 5 roles (`CUSTOMER`, `COURIER`, `MERCHANT`, `DISPATCHER`, `ADMIN`).
  - 79/79 tests passing:
    - 16 unauthenticated private endpoint tests (401 `UNAUTHENTICATED`).
    - Public endpoints (`/health`, `/pricing/estimate`, `/tracking/:trackingNumber`).
    - Universal profile access (`/users/me` GET & PATCH, verifying `passwordHash` is never leaked).
    - 40+ role boundary negative tests verifying 403 `FORBIDDEN` across all unauthorized endpoints.
    - Positive authorization tests confirming authorized roles reach handler surfaces.
    - Merchant partner API key authentication (`X-Api-Key` requirement, rejecting browser cookies).
- **Week 6 (Completed):**
  - Real-time deactivation hardening in `JwtAuthGuard`: added 60-second in-memory cache to re-check `user.isActive` on authenticated requests, immediately rejecting deactivated users with 403 `ACCOUNT_DISABLED`.
  - Immediate cache invalidation in `UsersService.adminUpdate` on deactivation or role change.
  - Rate limiting verification: added e2e integration test in `test/auth/auth.e2e-spec.ts` verifying 10 req/min throttling on auth endpoints (HTTP 429 `RATE_LIMITED`).
  - Unit tests added:
    - `apps/api/src/common/auth/jwt-auth.guard.spec.ts`: public routes, missing token, expired token, active status check, and cache invalidation.
    - `apps/api/src/modules/auth/auth.service.spec.ts`: refresh rotation, token reuse breach detection revoking entire session chains, expired session rejection, logout, and OAuth linking.
- **Week 7 (Completed):**
  - Cross-module security review across all 14 API services and controllers against the security checklist in `docs/conventions/security.md`.
  - Formulated and documented evidence and gap analysis in [`docs/security-review.md`](../security-review.md).
  - Built the formal Negative-Test Gap Matrix mapping required object-level tenancy checks (`404 NOT_FOUND` IDOR prevention) across Customer (M3), Merchant (M5), Courier (M6), and Dispatch (M7).
- **Week 8 (Completed):**
  - Finalized member documentation, Google OAuth live demonstration runbook, and contribution summary below.

---

## Google OAuth 2.0 Live Demo Guide

### 1. Environment Setup

To demonstrate live Google Sign-In during assessment:

1. Open Google Cloud Console → **APIs & Services → Credentials**.
2. Create an **OAuth 2.0 Client ID** (Web application):
   - **Authorized JavaScript origins**: `http://localhost:8080`
   - **Authorized redirect URIs**: `http://localhost:8080/api/v1/auth/google/callback`
3. Add the credentials to `.env`:
   ```env
   GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<your-client-secret>
   GOOGLE_CALLBACK_URL=http://localhost:8080/api/v1/auth/google/callback
   ```
4. Reload the API container with the updated `.env`:
   ```bash
   docker compose up -d --no-deps api
   ```

### 2. Demo Walkthrough Steps

1. **New Customer Auto-Provisioning**:
   - Navigate to `http://localhost:8080/login` or `http://localhost:8080/register`.
   - Click **Continue with Google**.
   - Inspect browser DevTools → Network: `GET /api/v1/auth/google` sets two short-lived `httpOnly` cookies (`sd_oauth_state`, `sd_oauth_verifier`) and responds with HTTP `302 Found` to Google's consent screen with `code_challenge_method=S256`.
   - Complete Google sign-in: Google redirects to `/api/v1/auth/google/callback?code=...&state=...`.
   - The server verifies the state cookie, exchanges the code using the PKCE verifier, validates the `id_token` signature and audience via `google-auth-library`, creates a `CUSTOMER` account + `OAuthAccount` link in one database transaction, sets `sd_access` and `sd_refresh` cookies, and redirects to `/customer`.
2. **Existing Account Linking**:
   - If a user registers with email/password first and later signs in with Google using the same verified email address, `AuthService.googleCallback` automatically links the `OAuthAccount` to their existing `User` record and preserves their assigned role.
3. **Graceful Unconfigured Fallback**:
   - When `GOOGLE_CLIENT_ID` is omitted from `.env`, clicking **Continue with Google** displays an inline alert (`"Google OAuth is not configured in this environment"`) on the login/register card without crashing or leaving the page.

---

## Member 2 — Final Contribution Summary

| Area                             | Key Deliverables & Files                                                                                                                                                                                                                                             | Verification                                                                           |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| **Core Auth & Sessions**         | `apps/api/src/modules/auth/auth.service.ts`, `auth.controller.ts`, `dto/auth.dto.ts` — Argon2id hashing, timing-safe login, 256-bit refresh token rotation, token-reuse breach detection revoking entire session chains.                                             | 14 e2e tests in `test/auth/auth.e2e-spec.ts` + 11 unit tests in `auth.service.spec.ts` |
| **Guards & Real-Time Hardening** | `apps/api/src/common/auth/jwt-auth.guard.ts`, `token.service.ts` — Global JWT verification + 60s cached `isActive` check + immediate cache invalidation on admin update.                                                                                             | 6 unit tests in `jwt-auth.guard.spec.ts` + e2e deactivation test                       |
| **Google OAuth 2.0 (PKCE)**      | `AuthService.googleAuthUrl` & `googleCallback` — `state` + `S256` PKCE flow, server-side `id_token` verification, automatic customer creation and account linking.                                                                                                   | E2E & unit tests + live browser verification                                           |
| **User & Staff Management**      | `apps/api/src/modules/users/users.service.ts`, `users.controller.ts` — `/users/me` profile update, `/admin/users` paginated filtering, staff creation with `CourierProfile` provisioning, session revocation on deactivation, and `AuditService.record` integration. | E2E tests in `test/auth/auth.e2e-spec.ts`                                              |
| **Web Auth & Admin UI**          | `apps/web/src/features/auth/{LoginForm,RegisterForm,AdminUsersDashboard,CreateStaffModal}.tsx`, `apps/web/src/lib/api/client.ts` (silent 401 token refresh retry), `LogoutButton.tsx`.                                                                               | Verified across Customer, Courier, and Admin portals                                   |
| **Team Security & Auth Matrix**  | `apps/api/test/auth-matrix/auth-matrix.e2e-spec.ts`, `docs/security-review.md`, `docs/contracts/authorization-matrix.md` — Role boundary enforcement and cross-module IDOR negative-test gap tracking.                                                               | 79/79 e2e tests passing in `auth-matrix.e2e-spec.ts`                                   |

### Review fixes merged from PR #1 (kept when PR #6 was merged)

- Refresh rotation is atomic: two concurrent refreshes with one token → one wins, the other counts
  as reuse. Reuse detection revokes **all** of the user's sessions (stricter than "the chain").
- Duplicate-email races return `EMAIL_TAKEN`; admins cannot change their own role/status; promoting a
  user to COURIER creates a `CourierProfile`; audit metadata carries no email.
- The `JwtAuthGuard` status cache is per API process. Another instance can keep a stale role/status
  for up to 60 s (refresh sessions are still revoked at once on deactivation).
