# Al-Mahdi School Fee Manager — Backend API

REST API for the **Al-Mahdi School Fee Manager** Android app (AL-MAHDI PUBLIC HIGH SCHOOL & COLLEGE).
Phase 1 covers **students** and **fees**. Each phone keeps its own SQLite copy and syncs with this API,
which is the single source of truth.

- 1 Admin, any number of Teachers (each owns one or more class-sections), up to 5,000+ students
- Money is whole PKR (integers only)
- Business dates (fee month, due date, "today") use **Asia/Karachi**; timestamps are stored in UTC

## Stack

Node.js 24 · TypeScript (strict) · Express 5 · MongoDB (replica set, for transactions) · Mongoose 9 ·
Zod 4 · JWT (jose) · bcrypt · pino · Vitest + Supertest + mongodb-memory-server · Swagger UI.

## Quick start

Requirements: **Node.js 24+** and **Docker** (for the local MongoDB replica set).

```bash
npm install
cp .env.example .env          # defaults work for local development
docker compose up -d --wait   # MongoDB 8 as a single-node replica set (rs0) on port 27017
npm run seed                  # sample school; prints the logins once
npm run dev                   # http://localhost:4000
```

Then open:

- `http://localhost:4000/api/v1/health` → `{ "data": { "status": "ok", "db": "up" } }`
- `http://localhost:4000/docs` → Swagger UI (click **Authorize** and paste an access token from `POST /auth/login`)

### Port 27017 already in use?

If MongoDB is already installed on your machine, it usually listens on 27017 and Docker cannot use that port.
Either stop the local MongoDB service, or run Docker on another port:

1. In `docker-compose.yml`, change `'27017:27017'` to `'27018:27017'`.
2. In `.env`, use `MONGODB_URI=mongodb://localhost:27018/almahdi?directConnection=true`.

`directConnection=true` is needed because the replica set member calls itself `localhost:27017`.
Transactions still work.

## Seed data

`npm run seed` fills an **empty** database (it refuses if there is data; use `npm run seed -- --reset` to wipe
and start again — never allowed in production). It runs through the real services, so every rule and audit
entry applies:

- Settings with placeholder address and bank details
- Sessions 2025-26 (closed) and **2026-27 (current)**
- Playgroup, Nursery, Prep, Class 1–10, each with sections A and B, chained for promotion
- 2026-27 fee structures (Class 5: tuition 2,500 / admission 5,000 / exam 500; Class 10 tuition 3,500)
- Users `admin` (device `A`), `teacher1` (`T01`, sections of Playgroup–Class 4), `teacher2` (`T02`, Class 5–10).
  Passwords come from `SEED_PASSWORD`, otherwise they are generated and **printed once**.
- 60 students (Adm 1001–1060), one withdrawn with dues kept
- Vouchers April–November 2026 (exam fee in November) and ~390 payments
- **Ali Raza** s/o Ahmed Raza, Adm 1046, 5-A, Roll 12, phone 0345-1112233 owes exactly **PKR 8,000**:
  Aug 2,500 unpaid · Sep 1,500 left · Oct 1,000 left · Nov 3,000 (tuition + exam) unpaid.
  The script checks this and fails if it is not true.

The seed data ends in November 2026, so it must be run on or after 1 Nov 2026.

## Environment variables

All are validated at startup; the app refuses to start if one is missing or invalid.

| Variable                | Example                                            | Notes                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`              | `development`                                      | `development`, `test` or `production`                                                                                                                                                                 |
| `PORT`                  | `4000`                                             |                                                                                                                                                                                                       |
| `MONGODB_URI`           | `mongodb://localhost:27017/almahdi?replicaSet=rs0` | Must be a replica set (Atlas always is)                                                                                                                                                               |
| `JWT_ACCESS_SECRET`     |                                                    | Signs 15-minute access tokens. In production: 32+ random characters                                                                                                                                   |
| `JWT_REFRESH_SECRET`    |                                                    | Signs 30-day refresh tokens. Must differ from the access secret                                                                                                                                       |
| `ACCESS_TOKEN_TTL`      | `15m`                                              | Number + `s`/`m`/`h`/`d`                                                                                                                                                                              |
| `REFRESH_TOKEN_TTL`     | `30d`                                              |                                                                                                                                                                                                       |
| `CORS_ORIGINS`          | `http://localhost:8081`                            | Comma-separated browser origins. The Android app sends no Origin and is always allowed                                                                                                                |
| `TZ_BUSINESS`           | `Asia/Karachi`                                     | Time zone for fee months, due dates and report days                                                                                                                                                   |
| `TRUST_PROXY`           | `0`                                                | Optional. Set `1` behind Render/Railway/nginx so rate limits see the real client IP                                                                                                                   |
| `SEED_PASSWORD`         |                                                    | Optional, seed script only                                                                                                                                                                            |
| `STORAGE_PROVIDER`      | `cloudinary`                                       | Optional. Where certificate signature/stamp images go: `cloudinary` or `none` (`memory` is for tests). Default: `cloudinary` when the three keys below are set, otherwise `none` (uploads answer 503) |
| `CLOUDINARY_CLOUD_NAME` |                                                    | Cloudinary account (Settings → API Keys)                                                                                                                                                              |
| `CLOUDINARY_API_KEY`    |                                                    |                                                                                                                                                                                                       |
| `CLOUDINARY_API_SECRET` |                                                    | Keep secret; never commit it                                                                                                                                                                          |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## Scripts

| Command                                                       | What it does                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`                                                 | Start with reload (tsx)                                                                  |
| `npm run build`                                               | Compile to `dist/`                                                                       |
| `npm start`                                                   | Run the compiled server (`node dist/server.js`)                                          |
| `npm test`                                                    | All tests (in-memory MongoDB replica set; first run downloads a MongoDB binary)          |
| `npm run test:watch`                                          | Tests in watch mode                                                                      |
| `npm run typecheck` · `npm run lint` · `npm run format`       | TypeScript, ESLint, Prettier                                                             |
| `npm run seed`                                                | Sample data (see above)                                                                  |
| `npm run create-admin -- --username admin --name "Full Name"` | Create the single Admin for a real install (password asked hidden, or `ADMIN_PASSWORD`)  |
| `npm run migrate:admission-class` (`-- --dry-run` to preview) | One-off: fills `admissionClassId` on older students from their first class-history entry |

## Tests

```bash
npm test
```

Tests run against `mongodb-memory-server` in **replica-set mode**, so transactions behave as in production.
Each test file gets its own database. Tests that depend on "today" fix the clock to 20 Nov 2026 (Karachi).
They cover every scenario in the spec (Section 13): payments and double payments, idempotency, review
resolution, reversal, vouchers and previous dues, admission numbers under concurrency, promotion, withdrawal,
version conflicts, reports on Karachi day boundaries, and sync paging. The certificate tests cover the
12 certificate scenarios: dues block, SLC withdrawal and rollback, duplicates, numbering under concurrency
and across years, cancel, frozen snapshots, reprints, date-in-words, image upload limits, Staff access and
missing settings. Tests never upload to Cloudinary (`STORAGE_PROVIDER=memory`).

## API overview

Base path `/api/v1`, JSON only, `Authorization: Bearer <accessToken>`. Full list with request schemas: `/docs`.

- Success: `{ "data": … }` · lists: `{ "data": { items, page, limit, total } }` (`?page=&limit=` up to 200, `?sort=field|-field`)
- Error: `{ "error": { "code": "AMOUNT_EXCEEDS_BALANCE", "message": "…", "details": {} } }`

| Area                 | Endpoints                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Auth                 | login, refresh (rotating), logout, me, change-password                                                 |
| Users (Admin)        | list, reset password, sign out                                                                         |
| Teachers (Admin)     | list (+ sections without a teacher), create (phone code T01…), update sections/active, reset, sign out |
| Setup                | settings, sessions (+ set-current), classes and sections, fee structures (+ copy)                      |
| Students             | search, profile, fee history, admit, edit (version), change section, withdraw, promote, import         |
| Vouchers             | generate (+ preview), list (overdue filter), by number, fine, waive, cancel, opening balances          |
| Payments             | collect (idempotent by `_id`), list, by receipt, reverse, needs-review, resolve                        |
| Reports              | dashboard, daily collection, collection, class-wise, defaulters, status list, previous-session dues    |
| Sync                 | `POST /sync/push`, `GET /sync/pull?since=&limit=`                                                      |
| Certificates (Admin) | settings (principal, signature/stamp upload), check, issue, list/search, detail, reprint, cancel       |

## How the important parts work

- **Money:** integers only. `recalcVoucher` is the single place that derives a voucher's total, balance and
  status, and it throws rather than let a balance go negative. Every payment must add up:
  allocated + unallocated + refunded = amount.
- **Transactions:** every change to money or to more than one document runs in one MongoDB transaction
  together with its audit entry (`withTransaction`). Operations inside a transaction run one at a time.
- **Previous dues** are shown on a new voucher but never added to its total, so each rupee is owed on exactly one voucher.
- **Payments:** idempotent by the phone-made `_id`. Online, paying more than a balance is an error. Through
  sync, the money is already collected, so the server applies what fits and keeps the rest as
  `unallocatedAmount` with status `NEEDS_REVIEW` for the Admin to resolve. Payments are never edited or
  deleted; mistakes are reversed.
- **Sync:** every synced document gets a unique, increasing `syncSeq` from a counter that is updated inside the
  same transaction, so phones can page through `syncSeq > since` without missing anything. Bulk updates on
  synced collections are blocked for the same reason. Use `insertManySynced()` for bulk inserts.
- **Reports** are aggregations at request time; no totals are stored. Reversed payments never count.

### Certificates (Admin only)

Four types: Leaving (`SLC`), Character (`CC`), Bonafide (`BF`) and Date of Birth (`DOB`). The server
stores data only; the Admin phone renders and prints the PDF.

- **Numbers** look like `SLC-2026-0007`: one sequence per type and calendar year (Asia/Karachi), taken with an
  atomic `$inc` on `settings.counters.certificates` inside the issue transaction. An aborted issue rolls the
  counter back; numbers are never reused, even after a cancel. A duplicate SLC gets the next number plus `-D`.
- **Rules:** an SLC needs all dues cleared (`DUES_NOT_CLEAR` lists the open vouchers) and, if one already exists,
  `isDuplicate` with a reason (`SLC_ALREADY_ISSUED`). A Bonafide is for active students only. Nothing can be
  issued until the principal's name is set (`CERT_SETTINGS_MISSING`). `POST /certificates/check` runs the same
  rules without issuing.
- **One transaction:** rules → number → snapshot → insert → (SLC for an active student) withdraw with dues
  "collected" → audit `CERT_ISSUE`.
- **Snapshot:** everything printed (school, student, principal, signature/stamp URLs, he/she wording, form
  values) is frozen at issue time by the server. Reprints use only the snapshot, so they match the original
  even after the principal, signature or student record changes.
- **Never edited or deleted:** mistakes are cancelled with a reason (an SLC does not re-activate the student).
  Reprints only add to `reprints[]` and `reprintCount`.
- **Images:** signature and stamp photos (PNG/JPG, max 2 MB, magic bytes checked) are cleaned with sharp
  (rotate, trim, paper made transparent, max 900 px wide) and uploaded to Cloudinary under an unguessable key.
  Old files are never deleted, because old certificates point at them.
- **Sync:** certificates go only to the Admin phone; teachers never receive them.

## Teachers and sections (Attendance module, stage B1)

- Roles are **ADMIN** and **TEACHER** (STAFF was renamed). A teacher is given class-sections; each section belongs
  to at most one active teacher (`409 SECTION_ALREADY_ASSIGNED`, naming the teacher).
- A teacher collects fees only for students currently in their sections (`403 SECTION_NOT_ASSIGNED`).
- New teachers get phone codes `T01`, `T02` … (receipts `R-T01-00001`). Existing `S1`/`S2` users keep their codes.
- Sync: a teacher's phone pulls only their sections' students, vouchers and payments. The pull also returns
  `revokedSectionIds` (delete that local data) and `resetRequired` (a section was added: pull again from 0).
- Upgrading existing data: `npm run migrate:teachers -- --dry-run`, then `npm run migrate:teachers`
  (STAFF → TEACHER, assigned classes → their active sections, section on old payments). **Run it right after
  deploying**: payments now require `sectionIdAtPayment`.

## School calendar (Attendance module, stage B2)

- Weekly off days in `settings.calendar.weeklyOffDays` (0 = Sunday … 6 = Saturday, default Sunday):
  `GET/PATCH /settings/calendar`.
- `calendar_events`: HOLIDAY (one day or a range) and WORKING_DAY (a weekly off day worked as a make-up day),
  only inside the current session. Deleting keeps the event with `isDeleted: true` so phones sync the deletion.
- A date is a working day unless it is inside a holiday, or a weekly off day that is not a make-up day (a holiday
  always wins). The rules are pure functions in `modules/calendar/calendar.rules.ts` (shared with the app).
- Adding, moving or deleting a holiday over days that already have attendance returns `409 ATTENDANCE_EXISTS`
  with the dates; send `confirm=true` to go ahead (the attendance records are kept).
- `GET /calendar?month=YYYY-MM` returns each day's type and the month's working-day count.

## Daily attendance (Attendance module, stage B3)

- One `attendance_sheets` document per section and day (`_id` is a UUID made on the phone; unique
  `sectionId + date`), with an entry per enrolled student: PRESENT, ABSENT, LEAVE or LATE.
- The students of a sheet are those in the section that day: from admission, not after withdrawal, section
  changes from their date.
- `GET /attendance/sheet?sectionId=&date=` returns the sheet, or a draft with everyone PRESENT, plus `canEdit`,
  `reasonRequired` and `lockedReason`. `PUT /attendance/sheet` creates or updates it.
- Teachers: own sections, today only (`422 ATTENDANCE_LOCKED` otherwise). Admin: any day up to today; a past day
  needs a `reason`, and every change to it goes in the sheet's `changeLog`. Never on a weekend or holiday
  (`422 NOT_A_WORKING_DAY`), never in the future.
- Offline: sync push `SAVE_ATTENDANCE` (same payload). The same sheet id sent again is `DUPLICATE`. A second
  sheet for the same section and day from the same user is merged; from someone else it is kept under
  `conflicts` with `needsReview: true` for the Admin.
- Calculation (`modules/attendance/attendance.rules.ts`, shared with the app): counted days are working days
  with a sheet that has the student; weekends, holidays and not-marked days never count; LATE is present,
  LEAVE is not; % = (PRESENT + LATE) ÷ counted, rounded, or "—" when nothing is counted.

## Project structure

```
src/
  app.ts, server.ts           Express app and startup
  config/env.ts               Zod-validated environment
  db/                         connection, withTransaction, counters, syncSeq/version plugin
  common/                     errors, audit log, logger, middleware (auth, roles, validation, errors, uploads), utils
  common/storage/             image storage (Cloudinary) and signature/stamp image processing
  docs/openapi.ts             OpenAPI document built from the Zod schemas
  modules/<feature>/          *.model.ts, *.schemas.ts, *.service.ts (business logic), *.controller.ts, *.routes.ts, *.test.ts
scripts/                      seed.ts, create-admin.ts, backfill-admission-class.ts
test/                         test setup and helpers
```

Controllers stay thin; all business logic lives in services.

## Going live (real school data)

1. Deploy (below) and run `npm run create-admin -- --username admin --name "…"` against the production database.
2. Log in as Admin: update **settings**, create the session (the first one becomes current), create **classes and
   sections**, set **fee structures**.
3. Create the **teachers** (`POST /teachers`) with their sections; phone codes `T01`, `T02` … are given automatically.
4. **Import** existing students (`POST /students/import`, all-or-nothing, errors listed per row).
5. Enter each student's current dues from the paper registers as **opening balances** (`POST /vouchers/opening-balances`).
6. **Generate** the month's vouchers (preview first).
7. For certificates: set the principal's name and upload the signature (and stamp) in **Certificate Settings**.
   On a database with students from before certificates existed, run `npm run migrate:admission-class` once.

New admissions after go-live use `POST /students`, which also charges the first month's tuition + admission fee.

## Deployment

### 1. MongoDB Atlas

1. Create a cluster (MongoDB **7.0 or newer**; the free M0 tier works to start). Atlas clusters are replica sets,
   so transactions work.
2. **Database Access:** create a user with read/write on the app database only.
3. **Network Access:** allow your Node host's outbound IP (or `0.0.0.0/0` only if the host has no fixed IP).
4. Copy the connection string and add the database name, e.g.
   `mongodb+srv://almahdi:<password>@cluster0.xxxxx.mongodb.net/almahdi?retryWrites=true&w=majority`.
5. Turn on Atlas backups (paid tiers) or schedule `mongodump` exports.

### 2. Node host (Render, Railway, or a VPS)

Build `npm ci --include=dev && npm run build`, start `npm start`, Node 24. (`--include=dev` matters: hosts
often set `NODE_ENV=production` during the build, and plain `npm ci` would then skip TypeScript.)
Set the environment variables above with `NODE_ENV=production`, strong unique JWT secrets, the Atlas
`MONGODB_URI`, `TRUST_PROXY=1` on platforms that put a proxy in front of the app, and the three
`CLOUDINARY_*` keys for certificate images.
Health check path: `/api/v1/health`.

- **Render:** New → Web Service from the GitHub repo; build `npm ci --include=dev && npm run build`; start `npm start`.
- **Railway:** New project from the repo; set the same build/start commands and variables.
- **VPS:** install Node 24, clone, `npm ci --include=dev && npm run build`, run with a process manager
  (e.g. `pm2 start dist/server.js --name almahdi-api`) behind nginx with HTTPS (Let's Encrypt), `TRUST_PROXY=1`.

Then run `create-admin` once against the production database (from your machine with the production
`MONGODB_URI`, or in the host's shell). Never run `seed -- --reset` against production (it is refused).

The app logs JSON to stdout (secrets redacted) and shuts down cleanly on SIGTERM.

## Security

- Passwords hashed with bcrypt (cost 12); never logged or returned.
- Access tokens 15 min; refresh tokens 30 days, rotated on each use and stored only as a SHA-256 hash.
  Reusing an old refresh token logs the user out.
- Inactive users are rejected on login, refresh and every request.
- `helmet`, CORS allow-list, 1 MB JSON body limit (image uploads: one PNG/JPG up to 2 MB), rate limits (login: 5 failed tries per 15 min per IP + username;
  API: 300 requests/min per user).
- Every input is validated with Zod (unknown fields dropped). Teacher limits (own payments, own sections)
  are enforced in the services.
- No stack traces in responses; the audit log is insert-only.
