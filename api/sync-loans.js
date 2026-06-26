// api/sync-loans.js
// Vercel cron job — runs daily at 9 AM IST (3:30 AM UTC)
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
  return data.idToken;
}

async function getExistingLoanIds(token) {
  // Paginate through ALL Firestore documents — pageSize=1000 cap means we must loop
  const existingIds = new Set();
  let pageToken = null;

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
  } while (pageToken);

  return existingIds;
}

async function getActiveLoansFromMetabase() {
  const METABASE_SESSION = process.env.METABASE_SESSION_TOKEN;

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
      'X-Metabase-Session': METABASE_SESSION,
      'Cookie': `metabase.SESSION=${METABASE_SESSION}`
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

  await fetch(
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
}

export default async function handler(req, res) {
  // Security check — only allow Vercel cron calls
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Starting daily loan sync...');

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

    // 5. Add each new loan to Firestore
    let added = 0;
    for (const loan of newLoans) {
      await addLoanToFirestore(token, loan);
      added++;
    }

    // Update last sync timestamp in app_settings
    const syncTime = new Date().toISOString();
    try {
      const settingsRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/app_settings/config?updateMask.fieldPaths=lastSyncAt`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            fields: { lastSyncAt: { stringValue: syncTime } }
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
      syncedAt: syncTime
    });

  } catch (err) {
    console.error('Sync failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
