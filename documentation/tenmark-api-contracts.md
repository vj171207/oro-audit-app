# Tenmark Audit App — API Contract Reference

Exact input/output shape for all 8 serverless functions in `api/`, extracted directly from source (not from memory). Purpose: whoever ports these into Tenmark's Express backend — or keeps them on Vercel calling Tenmark's DB remotely — has a precise spec instead of reverse-engineering behavior from `app.js`.

All endpoints currently run as Vercel serverless functions (`export default async function handler(req, res)`), reading Metabase (DB 103) for live loan data and/or Firestore for the app's own data. None of them currently depend on Vercel-specific APIs beyond that handler signature — a straightforward mechanical port to Express route handlers (`(req, res) => {...}`) should work with minimal changes, aside from `req.query` / `req.body` parsing conventions if Tenmark's Express setup differs from Vercel's defaults.

---

## 1. `GET /api/active-loans`

**Purpose:** all currently active loans from Metabase. Used to compute which loans are unaudited, and to gate "is this loan still active" checks throughout the app.

**Request:** no parameters.

**Response `200`:**
```json
{
  "loans": [
    { "loanNumber": "TCGL31241368", "loanAmount": 450000, "loanDate": "2026-01-15", "branch": "HQ", "city": "Chennai" }
  ],
  "fetchedAt": "2026-07-18T10:00:00.000Z"
}
```
- `loanAmount`: number (parsed via `parseFloat(...) || 0` — never a string).
- `loanDate`: `"YYYY-MM-DD"` string, or `"—"` if null in source data.
- Loans are filtered server-side to `status IN ('GOLD_STORED', 'LOAN_AMOUNT_TRANSFERRED')` and active/non-deleted gold records only.

**Response `500`:** `{ "error": "<message>" }` — Metabase token missing, Metabase returned non-JSON, Metabase query error, or any other exception. No other status codes used.

**Auth:** none — public endpoint, no caller verification.

---

## 2. `GET /api/browse-loans?from=YYYY-MM-DD&to=YYYY-MM-DD`

**Purpose:** loans disbursed within a date range, for the "browse by date" lookup flow.

**Request (query params):**
- `from` (required): `YYYY-MM-DD`
- `to` (required): `YYYY-MM-DD`
- Both are strictly regex-validated (`^\d{4}-\d{2}-\d{2}$`) before use — this is the SQL-injection guard for this endpoint.

**Response `200`:**
```json
{ "loans": [ { "loanNumber": "...", "loanAmount": 450000, "loanDate": "2026-01-15", "branch": "...", "city": "..." } ] }
```
Same shape as `active-loans`, minus `fetchedAt`.

**Response `400`:** `{ "error": "from and to dates are required" }` or `{ "error": "from and to must be valid dates in YYYY-MM-DD format" }`.

**Response `500`:** `{ "error": "<message>" }`.

**Auth:** none.

---

## 3. `GET /api/loan-lookup?loanId=<string>`

**Purpose:** the core single-loan lookup — pulls the loan's AP (Appraisal Partner) valuation and its full ornament list. **Confirmed: this always returns the AP valuation, never the Maker/Checker valuation** — filtered via `original_gold_id IS NULL` (see inline comment in source; decision attributed to Rijin).

**Request (query params):**
- `loanId` (required). Sanitized server-side to alphanumeric + dash only before use in SQL.

**Response `200`:**
```json
{
  "loanNumber": "TCGL31241368",
  "loanAmount": 450000,
  "loanDate": "2026-01-15T00:00:00.000Z",
  "branch": "HQ",
  "city": "Chennai",
  "ornaments": [
    { "type": "Chain", "count": 2, "gw": 45.2, "stoneDed": 0, "karat": 22, "nw": 40.0, "goldId": "812331" }
  ]
}
```
- `loanAmount`: raw number (fixed — previously returned a pre-formatted `"₹1,20,000"` string; see loanAmount type fix).
- `loanDate`: raw Metabase timestamp string (not pre-formatted to `YYYY-MM-DD` — `app.js` handles display formatting).
- `ornaments`: one row per genuinely distinct AP gold record (no artificial deduplication — a prior `DISTINCT ON` bug that silently dropped genuine duplicate-type-same-quantity ornaments has been fixed and must NOT be reintroduced in a port).

**Response `400`:** `{ "error": "loanId is required" }`.

**Response `404`:** `{ "error": "Loan not found" }` — no matching AP gold records.

**Response `500`:** `{ "error": "<message>" }`.

**Auth:** none. Also handles `OPTIONS` (CORS preflight) → `200` empty body.

---

## 4. `POST /api/tw-gross-weight`

**Purpose:** bulk gross-weight lookup for the Tare Weight report's GW-vs-TW tally column. Built to scale to 10,000+ loans via batching — the SUM happens in SQL, not client-side.

**Request body:**
```json
{ "loanIds": ["TCGL31241368", "TCGL31290410", "..."] }
```
- `loanIds`: required array. Deduplicated and sanitized (alphanumeric + dash) server-side. Batched internally at 500 IDs per Metabase query — caller does not need to batch.

**Response `200`:**
```json
{
  "gwByLoanId": { "TCGL31241368": 45.2, "TCGL31290410": 30.0 },
  "requested": 2,
  "matched": 2,
  "failedBatches": undefined
}
```
- `gwByLoanId[loanId]` is the **total** gross weight across all AP ornament lines for that loan (never per-piece — same total-not-per-piece rule as elsewhere).
- **⚠️ Type note, worth confirming before a port:** unlike every other endpoint in this file, the value here is passed through with **zero numeric coercion** (`gwByLoanId[row[0]] = row[1];` — no `Number()`/`parseFloat()`). Whether this comes back as a JS number or a string depends entirely on how Metabase's dataset API serializes a Postgres `SUM()` over a numeric column, which this code makes no assumption about either way. Any consumer (or migration target with a strict numeric column) should not assume this is guaranteed to be a number without verifying Metabase's actual behavior first.
- `failedBatches` (only present if non-empty): `[{ "batchStart": 0, "batchSize": 500, "error": "..." }]` — a failed batch does NOT abort the whole request; other batches still succeed and are reported.

**Response `400`:** `{ "error": "loanIds array is required in the request body" }`.

**Response `405`:** `{ "error": "POST required" }` if called with any other method.

**Auth:** none. Also handles `OPTIONS`.

---

## 5. `POST /api/sync-loans`

**Purpose:** the nightly Vercel cron job. Pulls all active loans from Metabase, adds any not already in Firestore as `metabase-sync` placeholder audit docs. Also updates `app_settings/config` with sync result metadata.

**Request:** no body needed. Auth is via header, not body.

**Response `200`:**
```json
{
  "success": true,
  "totalActive": 1500,
  "existingInFirestore": 1480,
  "newLoansAdded": 18,
  "failedWrites": 2,
  "failures": [ { "loanNumber": "TCGL...", "error": "..." } ],
  "syncedAt": "2026-07-18T03:30:00.000Z"
}
```
- `failures`: only present if `failedWrites > 0`.
- Each individual Firestore write is now independently try/caught — one failure doesn't abort the batch or silently count as success (fixed; must be preserved in any port).
- Side effect: writes `lastSyncAt` / `lastSyncStatus` (`'success'` or `'completed_with_errors'`) / `lastSyncFailureCount` to `app_settings/config`.

**Response `401`:** `{ "error": "Unauthorized" }` if the `Authorization: Bearer <CRON_SECRET>` header doesn't match.

**Response `500`:** `{ "error": "<message>" }` — e.g. Firebase auth failure.

**Auth:** `Authorization: Bearer ${CRON_SECRET}` header — this is a shared-secret check, not a user auth check. **Known open question for migration:** if the job queue for this becomes Redis/Bull-based on Tenmark's infra (per the open questions list), this cron-secret pattern likely needs rethinking.

---

## 6. `POST /api/create-user`

**Purpose:** creates a Firebase Auth user + Firestore role record in one call. Manager-only.

**Request body:**
```json
{ "email": "new@orocorp.in", "password": "at-least-6-chars", "role": "auditor", "callerToken": "<firebase-id-token>" }
```
- `role` must be `'auditor'` or `'manager'`.
- `callerToken`: the calling manager's own Firebase ID token — verified server-side (looks up caller's UID, then checks their Firestore role is `'manager'`) before proceeding.

**Response `200`:** `{ "success": true, "uid": "...", "email": "...", "role": "auditor" }`.

**Response `400`:** missing fields, password < 6 chars, invalid role, or `{ "error": "This email is already registered." }`.

**Response `403`:** `{ "error": "<reason>" }` — caller token missing/invalid/expired, or caller is not a manager.

**Response `405`:** wrong HTTP method.

**Response `500`:** `{ "error": "User created in Auth but failed to save role. Contact admin." }` — a genuine partial-failure state worth flagging: Auth user exists but Firestore role write failed.

**Auth:** manager-only, enforced via `callerToken` verification described above. **FLAG FOR MIGRATION:** if Tenmark's dashboard auth replaces this app's own user management entirely (per the ongoing auth discussion), this whole endpoint may become unnecessary rather than something to port.

---

## 7. `POST /api/remove-user`

**Purpose:** removes a user's Firestore access record (does NOT delete their underlying Firebase Auth account — deliberately, to match legacy client-side-delete behavior exactly). Manager-only.

**Request body:**
```json
{ "docId": "<firebase-uid>", "callerToken": "<firebase-id-token>" }
```

**Response `200`:** `{ "success": true, "docId": "..." }`.

**Response `400`:** `{ "error": "docId is required." }` or `{ "error": "You can't remove your own account." }` (self-removal is explicitly blocked).

**Response `403`:** caller token invalid/expired, or caller is not a manager.

**Response `405`:** wrong HTTP method.

**Response `500`:** Firestore delete failed.

**Auth:** manager-only, same `callerToken` verification pattern as `create-user`. Same migration flag applies.

---

## 8. `POST /api/reset-password`

**Purpose:** lets a manager reset another user's password via the Firebase Auth REST API. Manager-only.

**Request body:**
```json
{ "email": "user@orocorp.in", "newPassword": "at-least-6-chars", "callerToken": "<firebase-id-token>" }
```

**Response `200`:** `{ "success": true }`.

**Response `400`:** missing fields, password < 6 chars, or a Firebase Auth REST API error surfaced directly (e.g. malformed request).

**Response `403`:** caller token invalid/expired, or caller is not a manager.

**Response `404`:** `{ "error": "User not found." }` or `{ "error": "User UID not found." }` — the target email doesn't match any Firestore user doc.

**Response `405`:** wrong HTTP method.

**Response `500`:** unexpected exception.

**Auth:** manager-only, same `callerToken` verification pattern. Same migration flag applies.

---

## Cross-cutting patterns worth preserving in any port

1. **The manager-only endpoints (6, 7, 8) all share the identical `verifyCallerIsManager()` logic**, copy-pasted across three files rather than shared. If porting into Express, this is a natural candidate for a single reusable middleware — but note it currently does two round-trips (token lookup, then a Firestore role read) per call, which matters for latency if converted to a hot-path middleware.
2. **Every Metabase-querying endpoint (1–4) repeats the same `original_gold_id IS NULL` AP-valuation filter and the same alphanumeric-plus-dash sanitization pattern.** Any replacement of these endpoints must preserve both — dropping the filter would silently start pulling Maker valuations instead of AP ones; dropping the sanitization reopens the SQL-injection risk that was deliberately closed.
3. **`gross_weight` (and by extension `gwByLoanId` values) is always a per-line total, never a per-piece figure.** This rule is stated explicitly in `tw-gross-weight.js`'s comments and must not be reintroduced as a per-piece calculation during a rewrite.
4. **Failure handling is deliberately partial/per-item where it matters** (`sync-loans`'s per-loan try/catch, `tw-gross-weight`'s per-batch try/catch) — a single failure doesn't silently succeed or abort the whole request. Any rewrite should preserve this granularity, not collapse it into one all-or-nothing try/catch.
5. **None of these endpoints currently validate the `callerToken`'s email domain restriction** (`@orocorp.in`) at the API layer — that restriction, if it exists, is enforced elsewhere (Firebase Auth config or Firestore rules), not in this code. Worth confirming this explicitly if domain restriction needs to carry over.
6. **Numeric coercion is inconsistent across endpoints.** `active-loans`, `browse-loans`, and `sync-loans` all use `parseFloat(...) || 0`; `loan-lookup` uses `Number(...) || 0`; `tw-gross-weight` applies **no coercion at all** to its weight values (see endpoint 4 above). Worth normalizing this to one consistent pattern during a rewrite, rather than porting the inconsistency forward.
