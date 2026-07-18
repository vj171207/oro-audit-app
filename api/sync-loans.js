// api/sync-loans.js
// Manually triggered sync — no longer runs on an automatic schedule (the
// Vercel cron trigger was removed; see vercel.json). Triggered today only
// via the "Run sync" button in Settings (app.js's runSync()), which sends
// the shared secret as a Bearer token in the Authorization header — the
// endpoint itself doesn't distinguish between "a cron called this" and
// "a manager clicked a button," it only checks the token.
// Queries Metabase for all active loans, adds any new ones to Firestore

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;

// Firebase Admin SDK via REST API
const FIREBASE_PROJECT_ID = 'oro-audit';

async function getFirebaseToken() {
  // Use Firebase REST API with the web API key
  const apiKey = process.env.FIREBASE_API_KEY;
  const email = process.env.FIREBASE_SYNC_EMAIL;
  const password = process.env.FIREBASE_SYNC_PASSWORD;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const data = await res.json();
  if (!data.idToken) {
    // Previously this returned undefined silently on a failed login, which
    // meant every downstream Firestore call would fail too — but with a
    // confusing generic error, not a clear "the login itself failed"
    // message. This matches the same check every other file already has.
    throw new Error('Firebase auth failed: ' + JSON.stringify(data));
  }
  return data.idToken;
}

async function getExistingLoanIds(token) {
  // Paginate through ALL Firestore documents — pageSize=1000 cap means we must loop.
  // MAX_PAGES is a safety net, not an expected limit: at 1000 docs/page, 50 pages
  // covers up to 50,000 audit records — far beyond any realistic near-term growth.
  // Without this cap, an unexpected data issue (e.g. a pagination token loop)
  // could otherwise run until the whole function times out with no clear signal why.
  const MAX_PAGES = 50;
  const existingIds = new Set();
  let pageToken = null;
  let pageCount = 0;

  do {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.documents) {
      data.documents.forEach(doc => {
        const loanId = doc.fields?.loanId?.stringValue;
        if (loanId) existingIds.add(loanId);
      });
    }

    pageToken = data.nextPageToken || null;
    pageCount++;

    if (pageCount >= MAX_PAGES && pageToken) {
      console.warn(`getExistingLoanIds hit the ${MAX_PAGES}-page safety cap with more pages remaining — stopping early. The audits collection may be larger than expected; consider raising MAX_PAGES.`);
      break;
    }
  } while (pageToken);

  return existingIds;
}

async function getActiveLoansFromMetabase() {
  const METABASE_API_KEY = process.env.METABASE_API_KEY;

  const query = `
    SELECT DISTINCT
      l.loan_number,
      l.disbursed_amount,
      l.loan_booking_date,
      b.name AS branch_name,
      c.name AS city_name
    FROM loan l
    JOIN branch b ON b.id = l.branch_id
    JOIN city c ON c.id = l.city_id
    JOIN gold g ON g.loan_id = l.id
    WHERE g.is_active = true
    AND g.is_deleted = false
    AND l.loan_number IS NOT NULL
    AND l.status IN ('GOLD_STORED', 'LOAN_AMOUNT_TRANSFERRED')
    ORDER BY l.loan_booking_date DESC;
  `;

  const res = await fetch(`${METABASE_URL}/api/dataset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': METABASE_API_KEY
    },
    body: JSON.stringify({
      database: METABASE_DB_ID,
      type: 'native',
      native: { query }
    })
  });

  const data = await res.json();
  const rows = data.data?.rows || [];

  return rows.map(r => ({
    loanNumber: String(r[0]),
    loanAmount: parseFloat(r[1]) || 0,
    loanDate: r[2] || null,
    branch: r[3] || '—',
    city: r[4] || '—'
  }));
}

async function addLoanToFirestore(token, loan) {
  const docId = loan.loanNumber + '_pending';
  const body = {
    fields: {
      loanId: { stringValue: loan.loanNumber },
      loanAmount: { doubleValue: loan.loanAmount },
      date: { stringValue: loan.loanDate || '—' },
      branch: { stringValue: loan.branch },
      city: { stringValue: loan.city },
      auditor: { stringValue: '—' },
      tw: { nullValue: null },
      excessFunding: { stringValue: 'No' },
      spurious: { stringValue: 'No' },
      source: { stringValue: 'metabase-sync' },
      syncedAt: { stringValue: new Date().toISOString() }
    }
  };

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits/${docId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    }
  );

  // Previously this response was never checked — a failed write would
  // still silently count as "added". Now a non-OK response throws, so the
  // caller can catch it, record exactly which loan failed and why, and
  // keep going instead of either lying about success or aborting the
  // whole batch over one bad write.
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore write failed (${res.status}): ${errText.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  // Security check — shared-secret auth (CRON_SECRET). Despite the name,
  // this is no longer cron-specific: it's the same check used by the
  // manual "Run sync" button in Settings. Anyone with the correct secret
  // can call this, whether that's an automated trigger or a person.
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Starting loan sync...');

    // 1. Get Firebase token
    const token = await getFirebaseToken();

    // 2. Get existing loan IDs from Firestore
    const existingIds = await getExistingLoanIds(token);
    console.log(`Found ${existingIds.size} existing loans in Firestore`);

    // 3. Get all active loans from Metabase
    const activeLoans = await getActiveLoansFromMetabase();
    console.log(`Found ${activeLoans.length} active loans in Metabase`);

    // 4. Find new loans not in Firestore
    const newLoans = activeLoans.filter(l => !existingIds.has(l.loanNumber));
    console.log(`Found ${newLoans.length} new loans to add`);

    // 5. Add each new loan to Firestore.
    // Each write is now individually wrapped: one failure is recorded and
    // skipped, not allowed to silently count as success OR to abort every
    // remaining loan in the batch. "added" now reflects writes that
    // genuinely succeeded.
    let added = 0;
    const failures = [];
    for (const loan of newLoans) {
      try {
        await addLoanToFirestore(token, loan);
        added++;
      } catch (err) {
        console.error(`Failed to add loan ${loan.loanNumber}:`, err.message);
        failures.push({ loanNumber: loan.loanNumber, error: err.message });
      }
    }

    if (failures.length > 0) {
      console.warn(`Sync completed with ${failures.length} failed write(s):`, JSON.stringify(failures));
    }

    // Update last sync timestamp + result summary in app_settings — this is
    // also what a future email/Slack notification would read from, so it's
    // worth recording accurately now even before that's built.
    const syncTime = new Date().toISOString();
    try {
      const settingsRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/app_settings/config?updateMask.fieldPaths=lastSyncAt&updateMask.fieldPaths=lastSyncStatus&updateMask.fieldPaths=lastSyncFailureCount`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            fields: {
              lastSyncAt: { stringValue: syncTime },
              lastSyncStatus: { stringValue: failures.length > 0 ? 'completed_with_errors' : 'success' },
              lastSyncFailureCount: { integerValue: failures.length }
            }
          })
        }
      );
      const settingsData = await settingsRes.json();
      console.log('lastSyncAt updated:', settingsData.fields?.lastSyncAt?.stringValue || 'failed');
    } catch (e) {
      console.warn('Failed to update lastSyncAt:', e.message);
    }

    return res.status(200).json({
      success: true,
      totalActive: activeLoans.length,
      existingInFirestore: existingIds.size,
      newLoansAdded: added,
      failedWrites: failures.length,
      failures: failures.length > 0 ? failures : undefined,
      syncedAt: syncTime
    });

  } catch (err) {
    console.error('Sync failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
