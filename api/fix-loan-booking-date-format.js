// api/fix-loan-booking-date-format.js
// ONE-TIME FIX — not a recurring job, delete this file once it's been run successfully.
//
// Problem: a small number of audit docs were written by an EARLIER version of app.js
// that had a formatting bug — it stored loanBookingDate as "DD/MM/YY" (e.g. "02/07/26")
// instead of the raw ISO "YYYY-MM-DD" (e.g. "2026-07-02") that every other record uses
// and that the Tare Weight sort (renderTWTable() in app.js) expects. Since the sort uses
// plain string comparison (localeCompare), any dd/mm/yy string sorts before any real ISO
// date (a leading '0' or '1' beats a leading '2'), which shoves these specific loans to
// the very front of the "oldest first" list regardless of their real booking date.
//
// This is a DIFFERENT problem from backfill-loan-booking-dates.js (which handles docs
// with NO loanBookingDate at all) — this one handles docs that HAVE a value, just in
// the wrong shape.
//
// Two modes, both GET requests, both require ?secret=<BACKFILL_SECRET> (same secret
// already set up for the other backfill script — no new env var needed):
//   ?mode=preview   (default) — finds every audit doc whose loanBookingDate isn't in
//                     YYYY-MM-DD form, looks up the correct date from Metabase, and
//                     reports exactly what WOULD be corrected. Writes nothing.
//   ?mode=commit    — does the same lookup, then actually overwrites loanBookingDate
//                     with the correct ISO value on each matched doc. Each write is
//                     individually try/caught so one failure doesn't abort the rest.
//
// Always run ?mode=preview first and read the output before running ?mode=commit.

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;
const FIREBASE_PROJECT_ID = 'oro-audit';
const METABASE_BATCH_SIZE = 200;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// Paginate through every audit doc, return the ones whose loanBookingDate is present
// but NOT in proper YYYY-MM-DD form. Excludes metabase-sync placeholder docs, same as
// the missing-date backfill.
async function getDocsWithMalformedDate(token) {
  const MAX_PAGES = 50;
  const malformed = [];
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
        const currentValue = fields.loanBookingDate?.stringValue;
        if (loanId && source !== 'metabase-sync' && currentValue && !ISO_DATE_RE.test(currentValue)) {
          const docId = doc.name.split('/').pop();
          malformed.push({ docId, loanId, currentValue });
        }
      });
    }

    pageToken = data.nextPageToken || null;
    pageCount++;
    if (pageCount >= MAX_PAGES && pageToken) {
      console.warn(`getDocsWithMalformedDate hit the ${MAX_PAGES}-page safety cap with more pages remaining — stopping early.`);
      break;
    }
  } while (pageToken);

  return malformed;
}

async function getBookingDatesFromMetabase(loanIds) {
  const METABASE_SESSION = process.env.METABASE_SESSION_TOKEN;
  const dateByLoanId = {};

  for (let i = 0; i < loanIds.length; i += METABASE_BATCH_SIZE) {
    const batch = loanIds.slice(i, i + METABASE_BATCH_SIZE);
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

    const malformedDocs = await getDocsWithMalformedDate(token);
    const uniqueLoanIds = [...new Set(malformedDocs.map(d => d.loanId))];

    const dateByLoanId = await getBookingDatesFromMetabase(uniqueLoanIds);

    const notFoundLoanIds = uniqueLoanIds.filter(id => !dateByLoanId[id]);
    const writable = malformedDocs.filter(d => dateByLoanId[d.loanId]);

    if (mode === 'preview') {
      return res.status(200).json({
        mode: 'preview',
        totalDocsWithMalformedDate: malformedDocs.length,
        uniqueLoanIds: uniqueLoanIds.length,
        matchedInMetabase: uniqueLoanIds.length - notFoundLoanIds.length,
        notFoundInMetabase: notFoundLoanIds,
        docsThatWouldBeCorrected: writable.length,
        sample: writable.slice(0, 30).map(d => ({
          docId: d.docId,
          loanId: d.loanId,
          currentValue: d.currentValue,
          correctedValue: dateByLoanId[d.loanId]
        })),
        note: 'Nothing was written. Re-run with ?mode=commit to actually apply these corrections.'
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
      totalDocsWithMalformedDate: malformedDocs.length,
      attempted: writable.length,
      written,
      failed: failures.length,
      failures: failures.length > 0 ? failures : undefined,
      skippedNoMetabaseMatch: notFoundLoanIds
    });

  } catch (err) {
    console.error('Fix-format run failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
