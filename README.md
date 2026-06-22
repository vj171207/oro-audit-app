# Oro Audit App

Internal collateral audit tool for Oro's audit team.

## What it does

- **New audit** — Enter a loan ID, ops data auto-populates from the database, auditor fills in audit findings + tear weight, submits and saves.
- **Tear weight** — Month-on-month tear weight ledger. All historical loans listed, auditor enters current readings, mismatches (>0.3g) flagged in red automatically.
- **All audits** — Full audit history with summary stats. Click any row for the full report.

## Deploy to Netlify (2 minutes)

1. Go to [netlify.com](https://netlify.com) and sign in
2. Click **Add new site → Deploy manually**
3. Drag and drop this entire folder into the deploy box
4. Done — Netlify gives you a live URL instantly

Or connect to GitHub:
1. Push this folder to a GitHub repo
2. In Netlify: **Add new site → Import from Git**
3. Select your repo, build command: leave blank, publish directory: `.`
4. Deploy

## Connecting to real data (next step)

Right now the ops data uses a mock database in `app.js`. To connect to the real Google Sheets:

1. Enable the Google Sheets API in Google Cloud Console
2. Create a service account and share the sheet with it
3. Replace the `fetchLoanData()` function in `app.js` with a fetch call to your Sheets API endpoint
4. Audits currently save to `localStorage` — replace `saveAudits()` / `auditStore` with Firebase Firestore calls for centralised storage

## Files

- `index.html` — App structure
- `style.css` — All styles
- `app.js` — All logic and mock data
- `netlify.toml` — Deployment config
