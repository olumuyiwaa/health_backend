# Healthcare Staffing Platform — Backend API

> On-Demand Healthcare Staffing & Visit Management Portal  
> Designed for **Qudus Elite LLC** · Built with Node.js · REST API

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [User Roles & Permissions](#user-roles--permissions)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Database Setup](#database-setup)
  - [Running the Server](#running-the-server)
- [API Reference](#api-reference)
  - [Authentication](#authentication)
  - [Users](#users)
  - [Credentials](#credentials)
  - [Facilities](#facilities)
  - [Cases](#cases)
  - [Shifts](#shifts)
  - [Visits (EVV)](#visits-evv)
  - [Messaging](#messaging)
  - [Notifications](#notifications)
  - [Billing](#billing)
  - [Reports](#reports)
  - [Storage](#storage)
- [Real-Time (Socket.io)](#real-time-socketio)
- [File Storage](#file-storage)
- [Security](#security)
- [Electronic Visit Verification (EVV)](#electronic-visit-verification-evv)
- [Anti-Double-Booking Engine](#anti-double-booking-engine)
- [Notification Channels](#notification-channels)
- [Database Schema](#database-schema)
- [Scripts Reference](#scripts-reference)
- [Deployment](#deployment)

---

## Overview

This is the backend API for a multi-tenant, on-demand healthcare staffing marketplace. It connects certified healthcare professionals (nurses, CNAs, HHAs) with commercial healthcare facilities (home care agencies, skilled nursing facilities, hospitals).

The system handles the full lifecycle of a clinical engagement:

```
Facility posts shift → Nurse claims shift → Nurse checks in (GPS verified) → 
Visit completed → EVV audit trail generated → Invoice created → Payout processed
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Clients                              │
│  Flutter Mobile App   │   Facility Web Dashboard   │  Admin │
└──────────┬────────────┴──────────────┬─────────────┴────────┘
           │                           │
           ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Node.js / Express REST API                     │
│                    (this repository)                        │
│                                                             │
│  Auth  │  Shifts  │  EVV  │  Billing  │  Messaging  │ ...  │
└──────┬──────────────────────────────────────────────────────┘
       │
       ├──► PostgreSQL (Prisma ORM)
       ├──► Redis (sessions, rate limiting, queues)
       ├──► DigitalOcean Spaces (private file storage)
       ├──► Stripe Connect (payments & payouts)
       ├──► Firebase (push notifications)
       ├──► SendGrid (email)
       ├──► Twilio (SMS / OTP)
       └──► Google Maps API (geocoding & EVV geofencing)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| Framework | Express 4 |
| ORM | Prisma 5 |
| Database | PostgreSQL (managed) |
| Cache / Queues | Redis |
| File Storage | DigitalOcean Spaces (S3-compatible) |
| Real-Time | Socket.io 4 |
| Authentication | JWT (access + refresh token rotation) |
| 2FA | TOTP via speakeasy + QR code |
| Payments | Stripe Connect |
| Push Notifications | Firebase Admin SDK |
| Email | SendGrid via Nodemailer |
| SMS / OTP | Twilio |
| Geocoding / EVV | Google Maps API + Haversine algorithm |
| Logging | Winston + Daily Rotate File |
| Validation | express-validator |
| Security | Helmet, CORS, bcryptjs, rate-limiting |

---

## Project Structure

```
healthcare-api/
├── prisma/
│   └── schema.prisma          # Full database schema (24 models)
├── src/
│   ├── server.js              # Entry point — HTTP server + Socket.io boot
│   ├── app.js                 # Express app, middleware stack, route mounting
│   ├── routes/
│   │   └── index.js           # Central route registry
│   ├── config/
│   │   ├── database.js        # Prisma singleton
│   │   ├── logger.js          # Winston logger
│   │   ├── socket.js          # Socket.io init + room helpers
│   │   └── storage.js         # DO Spaces / S3 client + uploader factory
│   ├── middleware/
│   │   ├── authenticate.js    # JWT auth + role guards + facility scoping
│   │   ├── errorHandler.js    # Global error handler
│   │   ├── rateLimiter.js     # Global / auth / upload rate limiters
│   │   ├── requestLogger.js   # Request ID injection
│   │   └── validate.js        # express-validator result handler
│   ├── utils/
│   │   ├── jwt.js             # Token sign / verify helpers
│   │   ├── response.js        # Standardised response helpers
│   │   ├── geo.js             # Haversine distance + geofence check
│   │   └── audit.js           # Audit log writer (non-blocking)
│   └── modules/
│       ├── auth/              # Registration, login, 2FA, sessions, password reset
│       ├── users/             # User management, suspension, profile, audit trail
│       ├── credentials/       # License uploads, approval workflow, expiry alerts
│       ├── facilities/        # Facility CRUD, addresses, billing, team, requirements
│       ├── cases/             # Patient case management (OASIS, PHI masking)
│       ├── shifts/            # Marketplace, booking, assignment, cancellation
│       ├── visits/            # EVV check-in/out, geofencing, overrides, audit logs
│       ├── messaging/         # Conversations, real-time chat, attachments
│       ├── notifications/     # Email, push, SMS dispatch + in-app records
│       ├── billing/           # Invoices, payouts, Stripe integration
│       ├── reports/           # Analytics, dashboards, audit trail exports
│       └── storage/           # Signed URLs, direct upload, download, delete
├── .env.example
└── package.json
```

---

## User Roles & Permissions

| Role | Description |
|---|---|
| `SUPER_ADMIN` | Full platform access — user management, finances, all facilities |
| `FACILITY_ADMIN` | Manages their own facility — cases, shifts, team members, billing |
| `TEAM_MEMBER` | Scoped facility operator — can post shifts and view records within their facility |
| `RECRUITER` | Read-only cross-platform access — credential review, worker activity |
| `NURSE` | Field professional — claims shifts, checks in/out, manages credentials |

### Nurse Designations

`RN` · `LVN` · `LPN` · `CNA` · `HHA` · `THERAPIST` · `CAREGIVER`

Each shift specifies a `requiredDesignation`. Nurses can only book shifts that match their designation.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- PostgreSQL 14+ (or a managed instance on DigitalOcean / Supabase / Railway)
- Redis 6+ (optional but recommended for production sessions)
- A DigitalOcean Spaces bucket (private ACL)
- SendGrid account
- Twilio account
- Firebase project with a service account
- Stripe account with Connect enabled
- Google Maps API key (Geocoding API enabled)

### Installation

```bash
git clone https://github.com/your-org/healthcare-staffing-api.git
cd healthcare-staffing-api
npm install
```

### Environment Variables

Copy the example file and fill in every value:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Min 64-char secret for access tokens |
| `JWT_REFRESH_SECRET` | Separate secret for refresh tokens |
| `SENDGRID_API_KEY` | SendGrid API key for transactional email |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio credentials for SMS / OTP |
| `FIREBASE_PROJECT_ID` / `FIREBASE_PRIVATE_KEY` | Firebase service account for push notifications |
| `DO_SPACES_ENDPOINT` | e.g. `https://nyc3.digitaloceanspaces.com` |
| `DO_SPACES_BUCKET` | Your private Spaces bucket name |
| `DO_SPACES_KEY` / `DO_SPACES_SECRET` | Spaces access credentials |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_` or `sk_test_`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `GOOGLE_MAPS_API_KEY` | For geocoding and EVV distance calculations |
| `EVV_GEOFENCE_RADIUS_METERS` | Max allowed check-in distance (default: `200`) |

### Database Setup

```bash
# Generate the Prisma client
npm run generate

# Run migrations (development)
npm run migrate:dev

# Or apply migrations in production
npm run migrate

# Optional: seed initial data
npm run seed
```

### Running the Server

```bash
# Development (with hot reload)
npm run dev

# Production
npm start
```

The API will be available at `http://localhost:8000/api/v1`.  
Health check: `GET http://localhost:8000/health`

---

## API Reference

All endpoints are prefixed with `/api/v1`. Authenticated endpoints require:

```
Authorization: Bearer <accessToken>
```

Responses follow a consistent envelope:

```json
{
  "success": true,
  "message": "...",
  "data": { ... }
}
```

Paginated responses include a `pagination` object:

```json
{
  "success": true,
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 143,
    "totalPages": 8,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | Public | Register a new user (nurse or admin) |
| `POST` | `/auth/login` | Public | Login — returns tokens or 2FA challenge |
| `POST` | `/auth/verify-email` | Public | Verify email with 6-digit OTP |
| `POST` | `/auth/resend-verification` | Public | Resend email verification OTP |
| `POST` | `/auth/forgot-password` | Public | Send password reset link |
| `POST` | `/auth/reset-password` | Public | Reset password using token from email |
| `POST` | `/auth/refresh` | Public | Rotate access + refresh tokens |
| `POST` | `/auth/logout` | ✓ | Revoke current session |
| `POST` | `/auth/logout-all` | ✓ | Revoke all active sessions |
| `GET` | `/auth/sessions` | ✓ | List active sessions |
| `DELETE` | `/auth/sessions/:id` | ✓ | Revoke a specific session |
| `POST` | `/auth/2fa/setup` | ✓ | Generate TOTP secret + QR code |
| `POST` | `/auth/2fa/enable` | ✓ | Confirm and activate 2FA |
| `POST` | `/auth/2fa/verify` | Public | Complete login with TOTP code |

**Registration body (nurse):**
```json
{
  "email": "nurse@example.com",
  "password": "SecurePass1",
  "firstName": "Jane",
  "lastName": "Doe",
  "role": "NURSE",
  "designation": "RN",
  "phone": "+12025551234"
}
```

**Login response (2FA disabled):**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": { "id": "...", "email": "...", "role": "NURSE" }
}
```

**Login response (2FA enabled):**
```json
{
  "requires2FA": true,
  "challengeToken": "abc123...",
  "userId": "..."
}
```

---

### Users

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/users` | Admin, Recruiter | List all users (filterable by role, status, search) |
| `GET` | `/users/me` | ✓ | Get own full profile |
| `PATCH` | `/users/me` | ✓ | Update own profile |
| `PATCH` | `/users/me/password` | ✓ | Change password |
| `GET` | `/users/:id` | Admin, Recruiter | Get any user by ID |
| `PATCH` | `/users/:id/suspend` | Super Admin | Suspend a user account |
| `PATCH` | `/users/:id/restore` | Super Admin | Restore a suspended account |
| `DELETE` | `/users/:id` | Super Admin | Soft-deactivate a user |
| `GET` | `/users/admin/audit-logs` | Super Admin | Platform-wide audit trail |

---

### Credentials

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/credentials` | Nurse | Upload a credential document |
| `GET` | `/credentials/mine` | Nurse | List own credentials with signed download URLs |
| `GET` | `/credentials` | Admin, Recruiter | List all credentials (filterable) |
| `GET` | `/credentials/:id` | ✓ | Get one credential + signed URL |
| `PATCH` | `/credentials/:id/approve` | Admin, Recruiter | Approve a credential |
| `PATCH` | `/credentials/:id/reject` | Admin, Recruiter | Reject with reason |
| `DELETE` | `/credentials/:id` | Nurse | Delete own pending credential |
| `GET` | `/credentials/admin/expiry-alerts` | Admin, Recruiter | Credentials expiring within N days |

**Supported credential types:**
`STATE_LICENSE` · `CPR_CERTIFICATION` · `TB_TEST` · `BACKGROUND_CHECK` · `GOVERNMENT_ID` · `OIG_CHECK` · `SAM_CHECK` · `IMMUNIZATION` · `WORK_AUTHORIZATION` · `CUSTOM`

---

### Facilities

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/facilities` | Super Admin | Create facility + admin user |
| `GET` | `/facilities` | Admin, Recruiter | List all facilities |
| `GET` | `/facilities/:id` | ✓ | Get facility details |
| `PATCH` | `/facilities/:id` | Admin, Facility Admin | Update facility info |
| `POST` | `/facilities/:id/logo` | Admin, Facility Admin | Upload logo |
| `POST` | `/facilities/:id/addresses` | Admin, Facility Admin | Add address |
| `PATCH` | `/facilities/:id/addresses/:addrId` | Admin, Facility Admin | Update address |
| `DELETE` | `/facilities/:id/addresses/:addrId` | Admin, Facility Admin | Delete address |
| `PUT` | `/facilities/:id/billing` | Admin, Facility Admin | Set billing info |
| `GET` | `/facilities/:id/requirements` | ✓ | Get workplace requirements |
| `POST` | `/facilities/:id/requirements` | Admin, Facility Admin | Add/update a requirement |
| `DELETE` | `/facilities/:id/requirements/:reqId` | Admin, Facility Admin | Remove a requirement |
| `POST` | `/facilities/:id/members` | Admin, Facility Admin | Invite a team member |
| `PATCH` | `/facilities/:id/members/:memberId` | Admin, Facility Admin | Update member permissions |
| `DELETE` | `/facilities/:id/members/:memberId` | Admin, Facility Admin | Remove team member |
| `PUT` | `/facilities/:id/staffing-preferences` | Admin, Facility Admin | Set staffing preferences |
| `PUT` | `/facilities/:id/notification-preferences` | Admin, Facility Admin | Set notification preferences |

---

### Cases

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/cases` | Admin, Facility Admin, Team Member | Create a patient case |
| `GET` | `/cases` | ✓ | List cases (scoped to facility for non-admins) |
| `GET` | `/cases/:id` | ✓ | Get case (PHI masked for nurses) |
| `PATCH` | `/cases/:id` | Admin, Facility Admin, Team Member | Update case |
| `DELETE` | `/cases/:id` | Admin, Facility Admin | Soft-archive case |

**Case body:**
```json
{
  "facilityId": "...",
  "addressLine1": "123 Main St",
  "city": "Los Angeles",
  "state": "CA",
  "zipCode": "90001",
  "visitType": "ADMISSION",
  "isOasisCase": true,
  "oasisType": "ADMISSION",
  "specialties": ["WOUND_CARE", "IV_INFUSION"],
  "primaryDiagnosis": "CHF",
  "patientFirstName": "John",
  "patientLastName": "Smith"
}
```

A `publicIdentifier` (e.g. `Case-PT-7701`) is auto-generated to mask PHI in marketplace feeds.

**Visit types:** `ADMISSION` · `REGULAR` · `RESUMPTION_OF_CARE` · `RECERTIFICATION` · `SUPERVISORY` · `DISCHARGE`

**Specialties:** `WOUND_CARE` · `WOUND_VAC` · `PICC_LINE` · `DEMENTIA_CARE` · `TRACHEOSTOMY` · `IV_INFUSION` · `TPN` · `G_TUBE` · `VENTILATOR` · `PEDIATRICS` · `COMPLEX_MEDS` · `CATHETER_CARE`

---

### Shifts

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/shifts` | Admin, Facility Admin, Team Member | Create a shift |
| `GET` | `/shifts` | ✓ | List shifts (scoped by role) |
| `GET` | `/shifts/:id` | ✓ | Get shift details |
| `GET` | `/shifts/marketplace` | Nurse | Browse open shifts with filters |
| `POST` | `/shifts/:id/book` | Nurse | Instantly book an open shift (atomic) |
| `POST` | `/shifts/:id/assign` | Admin, Facility Admin | Manually assign a nurse |
| `PATCH` | `/shifts/:id/cancel` | ✓ | Cancel shift or nurse's booking |
| `GET` | `/shifts/nurse/my-shifts` | Nurse | Get own booked/completed shifts |

**Marketplace filters:** `?designation=RN&visitType=ADMISSION&minPay=25&maxPay=60&isUrgent=true&date=2026-06-01`

---

### Visits (EVV)

Electronic Visit Verification — GPS-enforced check-in/out with a 200m geofence.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/visits` | ✓ | List visits (scoped by role) |
| `GET` | `/visits/:id` | ✓ | Get visit details + audit events |
| `POST` | `/visits/:id/check-in` | Nurse | GPS check-in (geofence enforced) |
| `POST` | `/visits/:id/check-out` | Nurse | GPS check-out + duration calculation |
| `PATCH` | `/visits/:id/override-approve` | Admin, Facility Admin | Approve a flagged check-in override |

**Check-in body:**
```json
{
  "latitude": 34.052235,
  "longitude": -118.243683,
  "qrCode": "optional-qr-token"
}
```

If the nurse is more than 200m from the case address, the visit is flagged as `FLAGGED` and an override request is created for admin review.

---

### Messaging

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/messages/conversations` | ✓ | Start or retrieve a conversation |
| `GET` | `/messages/conversations` | ✓ | List own conversations |
| `GET` | `/messages/conversations/:id/messages` | ✓ | Get messages in a conversation |
| `POST` | `/messages/conversations/:id/messages` | ✓ | Send a message (text or attachment) |
| `PATCH` | `/messages/conversations/:id/read` | ✓ | Mark conversation as read |

Real-time delivery uses Socket.io (see [Real-Time](#real-time-socketio)).

---

### Notifications

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/notifications` | ✓ | List notifications (`?unreadOnly=true`) |
| `PATCH` | `/notifications/read-all` | ✓ | Mark all as read |
| `PATCH` | `/notifications/:id/read` | ✓ | Mark one as read |

---

### Billing

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/billing/invoices` | Admin, Facility Admin | List invoices |
| `GET` | `/billing/invoices/:id` | Admin, Facility Admin | Get invoice + line items |
| `POST` | `/billing/invoices` | Super Admin | Generate invoice for a facility |
| `PATCH` | `/billing/invoices/:id/void` | Super Admin | Void an invoice |
| `GET` | `/billing/payouts` | Admin, Nurse | List payouts |
| `GET` | `/billing/wallet` | Nurse | Get own wallet balance |
| `POST` | `/billing/stripe/webhook` | Public (Stripe) | Handle Stripe webhook events |

---

### Reports

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/reports/dashboard` | Admin, Recruiter | Platform-wide KPI summary |
| `GET` | `/reports/shifts` | ✓ | Shift analytics (fill rate, completion rate, by type) |
| `GET` | `/reports/revenue` | Super Admin | Revenue by facility and month |
| `GET` | `/reports/facilities/:id/performance` | Admin, Facility users | Per-facility performance stats |
| `GET` | `/reports/facilities/:id/dashboard` | Admin, Facility users | Facility live dashboard |
| `GET` | `/reports/workers` | Admin, Recruiter, Facility Admin | Per-nurse activity report |
| `GET` | `/reports/credentials/expiry` | Admin, Recruiter | Expiring + expired credentials |
| `GET` | `/reports/billing` | Admin, Facility Admin | Invoice and revenue billing report |
| `GET` | `/reports/audit-trail` | Super Admin | Full audit trail with filters |

All report endpoints accept `?from=YYYY-MM-DD&to=YYYY-MM-DD` date range parameters.

---

### Storage

All files are stored privately in DigitalOcean Spaces. No file is ever publicly accessible. Access is always via time-limited signed URLs.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/storage/signed-upload-url` | ✓ | Get a pre-signed PUT URL for direct upload |
| `POST` | `/storage/confirm` | ✓ | Confirm direct upload + get download URL |
| `POST` | `/storage/upload/:folder` | ✓ | Proxied multipart upload via API |
| `GET` | `/storage/download?key=` | ✓ | Generate a signed download URL |
| `DELETE` | `/storage` | Super Admin | Hard-delete an object |
| `GET` | `/storage/folders` | ✓ | List folders accessible to current role |

**Storage folders and role access:**

| Folder | Allowed Roles | Max Size |
|---|---|---|
| `credentials` | Nurse | 15 MB |
| `avatars` | All | 5 MB |
| `facility-logos` | Super Admin, Facility Admin | 5 MB |
| `facility-documents` | Super Admin, Facility Admin, Team Member | 20 MB |
| `chat-attachments` | All | 50 MB |
| `visit-signatures` | Nurse | 5 MB |
| `admin-documents` | Super Admin | 50 MB |

---

## Real-Time (Socket.io)

Connect with a valid Bearer token in the handshake auth:

```javascript
const socket = io('https://api.yourdomain.com', {
  auth: { token: accessToken }
});
```

**Client events to emit:**

| Event | Payload | Description |
|---|---|---|
| `join_conversation` | `conversationId` | Subscribe to a chat room |
| `leave_conversation` | `conversationId` | Unsubscribe from a chat room |
| `typing` | `{ conversationId }` | Broadcast typing indicator |

**Server events to listen for:**

| Event | Description |
|---|---|
| `notification` | In-app notification dispatched |
| `new_message` | New chat message in a conversation |
| `user_typing` | Another user is typing |

Each user is automatically joined to a personal room (`user:<userId>`) for targeted notifications.

---

## File Storage

All uploads go to DigitalOcean Spaces with `ACL: private`. The API never exposes raw Spaces URLs — only time-limited signed URLs generated server-side.

**Recommended flow for large files (e.g. credential PDFs):**

```
1. POST /storage/signed-upload-url  →  { uploadUrl, objectKey }
2. PUT <uploadUrl> with file binary  →  direct to Spaces (no API hop)
3. POST /storage/confirm { objectKey }  →  { downloadUrl }
4. Store objectKey in your DB record
```

**For small files (avatars, signatures):**

```
POST /storage/upload/:folder  (multipart/form-data, field: "file")
→  { objectKey, downloadUrl }
```

---

## Security

- **HTTPS only** — HSTS enabled via Helmet
- **JWT rotation** — short-lived access tokens (15m) + rotating refresh tokens (30d)
- **Session tracking** — every token is tied to a DB session record; individual sessions can be revoked
- **Rate limiting** — global (100 req/15min), auth endpoints (10 req/15min), uploads (30 req/hour)
- **RBAC** — every route has explicit role guards; facility users are scoped to their own tenant
- **Input validation** — express-validator on all mutation endpoints
- **Password hashing** — bcrypt with 12 salt rounds
- **PHI masking** — patient names/DOB stripped from all nurse-facing responses; public IDs used in marketplace
- **Audit trail** — every create/update/delete/login event written to `AuditLog`
- **Private storage** — no public file URLs; all access via signed URLs with configurable expiry
- **2FA** — optional TOTP (Google Authenticator compatible) for any account
- **SQL injection** — Prisma parameterised queries throughout; no raw string interpolation

---

## Electronic Visit Verification (EVV)

The EVV engine uses the **Haversine formula** to calculate the great-circle distance between a nurse's GPS coordinates and the case address at the moment of check-in.

```
If distance > EVV_GEOFENCE_RADIUS_METERS (default: 200m):
  → Visit status set to FLAGGED
  → overrideRequired = true
  → Admin/Facility Admin must approve before visit proceeds
```

Every check-in and check-out generates an immutable `VisitAuditLog` entry recording the action, coordinates, distance, performer, and timestamp.

---

## Anti-Double-Booking Engine

Shift booking uses a **pessimistic database lock** (`SELECT ... FOR UPDATE`) inside a Prisma interactive transaction to prevent race conditions during high-concurrency marketplace events:

```sql
BEGIN;
  SELECT status FROM "Shift" WHERE id = $1 FOR UPDATE;
  -- If status != 'OPEN' → ROLLBACK → 409 Conflict
  UPDATE "Shift" SET status = 'BOOKED' WHERE id = $1;
  INSERT INTO "ShiftAssignment" (shift_id, nurse_id, ...) VALUES (...);
COMMIT;
```

Additionally, each booking checks for overlapping accepted shifts on the same nurse before committing.

---

## Notification Channels

Notifications are dispatched across up to three channels simultaneously:

| Channel | Provider | Use Case |
|---|---|---|
| **Email** | SendGrid | Credential approvals/rejections, password reset, invoice alerts |
| **Push** | Firebase Cloud Messaging | Shift alerts, booking confirmations, new messages |
| **SMS** | Twilio | OTP verification, emergency fill alerts |
| **In-app** | Socket.io | Real-time bell notifications (no external provider) |

All dispatched notifications are also persisted to the `Notification` table for in-app inbox display.

---

## Database Schema

The Prisma schema defines **24 models** across these domains:

| Domain | Models |
|---|---|
| Auth & Users | `User`, `AdminProfile`, `NurseProfile`, `Session`, `PasswordReset`, `OtpCode` |
| Facilities | `Facility`, `FacilityAddress`, `FacilityBilling`, `FacilityMember`, `WorkplaceRequirement`, `StaffingPreference`, `FacilityNotificationPref` |
| Clinical | `Case`, `Shift`, `ShiftAssignment` |
| Credentials | `Credential` |
| EVV | `Visit`, `VisitAuditLog` |
| Messaging | `Conversation`, `Message` |
| Notifications | `Notification` |
| Billing | `Wallet`, `Payout`, `Invoice`, `InvoiceLineItem` |
| Audit | `AuditLog` |

Run `npm run studio` to open Prisma Studio and browse the database visually.

---

## Scripts Reference

```bash
npm run dev           # Start with nodemon (hot reload)
npm start             # Start in production mode
npm run generate      # Regenerate Prisma client after schema changes
npm run migrate:dev   # Create and apply a new migration (development)
npm run migrate       # Apply pending migrations (production)
npm run seed          # Run prisma/seed.js
npm run studio        # Open Prisma Studio on localhost:5555
```

---

## Deployment

### DigitalOcean Droplet (recommended)

```bash
# 1. Provision a Droplet (Ubuntu 22.04, minimum 2GB RAM)
# 2. Install Node.js 18+, PostgreSQL, Redis

# 3. Clone and install
git clone https://github.com/your-org/healthcare-staffing-api.git
cd healthcare-staffing-api
npm ci --omit=dev

# 4. Set environment variables
cp .env.example .env
# ... fill in all values

# 5. Run migrations
npm run migrate

# 6. Start with a process manager
npm install -g pm2
pm2 start src/server.js --name healthcare-api
pm2 save
pm2 startup
```

### Environment Checklist

- [ ] `NODE_ENV=production`
- [ ] `DATABASE_URL` points to managed PostgreSQL
- [ ] `REDIS_URL` points to managed Redis
- [ ] `JWT_SECRET` is at least 64 random characters
- [ ] `JWT_REFRESH_SECRET` is different from `JWT_SECRET`
- [ ] DigitalOcean Spaces bucket ACL is set to **private**
- [ ] Stripe webhook endpoint registered at `/api/v1/billing/stripe/webhook`
- [ ] Firebase service account key is set
- [ ] SSL/TLS termination is configured (Nginx or DO Load Balancer)
- [ ] `FRONTEND_URL` and `ADMIN_URL` are set to actual domains (CORS)

---

## License

Proprietary — Designed for **Qudus Elite LLC**. All rights reserved.
