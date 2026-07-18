# Tenmark Audit App — Environment Variables Reference

Every environment variable the app currently reads, extracted directly from `process.env.*` references across `api/*.js` (confirmed via grep across all 8 files — this list is exhaustive, not a guess). Needed by whoever provisions secrets for a Docker/PM2 deployment, or migrates these endpoints into Tenmark's existing infra.

| Variable | Used in | Purpose | Notes |
|---|---|---|---|
| `METABASE_API_KEY` | `active-loans.js`, `browse-loans.js`, `loan-lookup.js`, `tw-gross-weight.js`, `sync-loans.js` | Authenticates every Metabase `/api/dataset` query (DB 103, `oro.metabaseapp.com`). | The single most-used secret — 5 of 8 endpoints depend on it. If Tenmark's dashboard gets its own Metabase connection (open question), this may become shared infra rather than something this app provisions independently. |
| `FIREBASE_API_KEY` | `create-user.js`, `remove-user.js`, `reset-password.js`, `sync-loans.js` | Firebase Auth REST API key — used for the service-account sign-in flow and for creating/updating/looking up users. | Public-ish by Firebase convention (it's not a secret in the traditional sense — Firebase API keys are safe to expose client-side per Google's own docs — but still worth tracking as required config). |
| `FIREBASE_SYNC_EMAIL` | `create-user.js`, `remove-user.js`, `reset-password.js`, `sync-loans.js` | Email for the app's Firebase service account (`sync@oroaudit.com` per existing code comments), used to obtain an admin-equivalent ID token for privileged Firestore writes. | A **real credential** — must be rotated if ever exposed. Paired with the password below. |
| `FIREBASE_SYNC_PASSWORD` | `create-user.js`, `remove-user.js`, `reset-password.js`, `sync-loans.js` | Password for the same service account. | Same sensitivity as above — this pair effectively acts as this app's only "admin" credential into Firestore. |
| `CRON_SECRET` | `sync-loans.js` | Shared-secret check gating the nightly sync cron — request must include `Authorization: Bearer <CRON_SECRET>`, or it's rejected with `401`. | This is Vercel-cron-specific — if the nightly sync job moves to a different scheduler (e.g. a Redis/Bull job on Tenmark's infra, per the open migration question), this entire auth mechanism likely gets replaced, not ported. |

## What's conspicuously absent

- **No database connection string** — because there's no direct DB connection today; everything goes through the Firestore REST API (using the tokens above) and the Metabase REST API. A real migration to Postgres/Mongo will need to introduce a genuinely new variable (e.g. `DATABASE_URL` or `MONGO_URI`) that doesn't exist anywhere in the current app.
- **No `SETTINGS_PASSWORD` env var** — the shared Settings-panel password (`SETTINGS_PASSWORD` in `app.js`) is stored in Firestore (`app_settings/config.settingsPassword`), not as an environment variable. Worth knowing this is a different kind of secret than the 5 above — app data, not deployment config.

## For a Docker/PM2 deployment specifically

If these endpoints get ported into Tenmark's existing Express app rather than staying on Vercel, all 5 variables above need to be added to whatever `.env` / secrets-management approach their Docker setup already uses (their `env-cmd` dev/uat/prod split, mentioned in their frontend config, suggests there's already a established pattern to follow — worth asking which).

## Suggested `.env.example` (for reference — not present in the repo today)

```
METABASE_API_KEY=
FIREBASE_API_KEY=
FIREBASE_SYNC_EMAIL=
FIREBASE_SYNC_PASSWORD=
CRON_SECRET=
```

This file does not currently exist in the repo. Worth adding as a real, checked-in file (with empty values, obviously) purely so anyone setting up a new environment has a checklist instead of grepping the codebase the way this document was produced.
