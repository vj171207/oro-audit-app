// api/backfill-loan-booking-dates.js
// ONE-TIME BACKFILL — not a recurring job, delete this file once it's been run successfully.
//
// Problem: loanBookingDate is only written onto an audit record at the moment a NEW
// audit is submitted (app.js submitAudit(), using the live Metabase lookup value).
// Every audit record that existed in Firestore BEFORE that feature landed has no
// loanBookingDate field at all, which breaks the Tare Weight table's oldest-first sort
// (renderTWTable() in app.js) for almost all existing data.
//
// This script finds every audit doc missing loanBookingDate, looks up the real
// loan_booking_date for that loan from Metabase (same column loan-lookup.js already
// uses, so the value will match what's shown elsewhere in the app), and writes it
// onto the doc.
//
// Two modes, both GET requests, both require ?secret=<BACKFILL_SECRET>:
//   ?mode=preview   (default) — finds everything, queries Metabase, reports exactly what
//                     WOULD be written, and which loan IDs have no match in Metabase.
//                     Writes nothing.
//   ?mode=commit    — does the same lookup, then actually writes loanBookingDate onto
//                     each matched doc. Each write is individually try/caught so one
//                     failure doesn't abort the rest, matching sync-loans.js's pattern.
//
// Always run ?mode=preview first and read the output before running ?mode=commit.

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;
const FIREBASE_PROJECT_ID = 'oro-audit';
const METABASE_BATCH_SIZE = 200; // loan IDs per Metabase IN-clause query

async function getFirebaseToken() {
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
  if (!data.idToken) throw new Error('Firebase auth failed: ' + JSON.stringify(data));
  return data.idToken;
}

// Paginate through every audit doc, return the ones missing loanBookingDate.
// Excludes metabase-sync placeholder docs (source: 'metabase-sync') — those aren't
// real audits, they're filtered out in renderTWTable() already, and get deleted
// automatically once a real audit is submitted for that loan.
async function getDocsMissingBookingDate(token) {
  const MAX_PAGES = 50;
  const missing = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.documents) {
      data.documents.forEach(doc => {
        const fields = doc.fields || {};
        const loanId = fields.loanId?.stringValue;
        const source = fields.source?.stringValue;
        const hasBookingDate = !!fields.loanBookingDate?.stringValue;
        if (loanId && source !== 'metabase-sync' && !hasBookingDate) {
          // doc.name is the full path — pull just the doc ID off the end
          const docId = doc.name.split('/').pop();
          missing.push({ docId, loanId });
        }
      });
    }

    pageToken = data.nextPageToken || null;
    pageCount++;
    if (pageCount >= MAX_PAGES && pageToken) {
      console.warn(`getDocsMissingBookingDate hit the ${MAX_PAGES}-page safety cap with more pages remaining — stopping early.`);
      break;
    }
  } while (pageToken);

  return missing;
}

// Batched Metabase lookup: loan_number -> loan_booking_date, for a list of loan IDs.
async function getBookingDatesFromMetabase(loanIds) {
  const METABASE_SESSION = process.env.METABASE_SESSION_TOKEN;
  const dateByLoanId = {};

  for (let i = 0; i < loanIds.length; i += METABASE_BATCH_SIZE) {
    const batch = loanIds.slice(i, i + METABASE_BATCH_SIZE);
    // Same sanitisation as loan-lookup.js — strip anything that isn't
    // alphanumeric or a dash before it goes anywhere near the SQL string.
    const safeIds = batch.map(id => id.replace(/[^A-Za-z0-9\-]/g, ''));
    const inClause = safeIds.map(id => `'${id}'`).join(',');

    const query = `
      SELECT DISTINCT l.loan_number, l.loan_booking_date
      FROM loan l
      WHERE l.loan_number IN (${inClause});
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
    if (data.error) throw new Error('Metabase query failed: ' + data.error);

    (data.data?.rows || []).forEach(row => {
      dateByLoanId[row[0]] = row[1];
    });
  }

  return dateByLoanId;
}

async function writeBookingDate(token, docId, bookingDate) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits/${docId}?updateMask.fieldPaths=loanBookingDate`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: { loanBookingDate: { stringValue: bookingDate } } })
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore write failed (${res.status}): ${errText.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  if (req.query.secret !== process.env.BACKFILL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mode = req.query.mode === 'commit' ? 'commit' : 'preview';

  try {
    const token = await getFirebaseToken();

    const missingDocs = await getDocsMissingBookingDate(token);
    const uniqueLoanIds = [...new Set(missingDocs.map(d => d.loanId))];

    const dateByLoanId = await getBookingDatesFromMetabase(uniqueLoanIds);

    const notFoundLoanIds = uniqueLoanIds.filter(id => !dateByLoanId[id]);
    const writable = missingDocs.filter(d => dateByLoanId[d.loanId]);

    if (mode === 'preview') {
      return res.status(200).json({
        mode: 'preview',
        totalAuditDocsMissingDate: missingDocs.length,
        uniqueLoanIds: uniqueLoanIds.length,
        matchedInMetabase: uniqueLoanIds.length - notFoundLoanIds.length,
        notFoundInMetabase: notFoundLoanIds,
        docsThatWouldBeWritten: writable.length,
        sample: writable.slice(0, 30).map(d => ({
          docId: d.docId,
          loanId: d.loanId,
          loanBookingDate: dateByLoanId[d.loanId]
        })),
        note: 'Nothing was written. Re-run with ?mode=commit to actually apply these changes.'
      });
    }

    // mode === 'commit'
    let written = 0;
    const failures = [];
    for (const doc of writable) {
      try {
        await writeBookingDate(token, doc.docId, dateByLoanId[doc.loanId]);
        written++;
      } catch (err) {
        failures.push({ docId: doc.docId, loanId: doc.loanId, error: err.message });
      }
    }

    return res.status(200).json({
      mode: 'commit',
      totalAuditDocsMissingDate: missingDocs.length,
      attempted: writable.length,
      written,
      failed: failures.length,
      failures: failures.length > 0 ? failures : undefined,
      skippedNoMetabaseMatch: notFoundLoanIds
    });

  } catch (err) {
    console.error('Backfill failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
