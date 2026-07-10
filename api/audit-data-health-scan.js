// api/audit-data-health-scan.js
// READ-ONLY, comprehensive — delete after use. Writes nothing, ever.
//
// Goes through EVERY document in the `audits` collection and checks for
// every category of data gap we've found and fixed today, plus a few
// related ones worth surfacing. Nothing here gets auto-fixed — this just
// produces a clear list so each category can be reviewed and fixed
// deliberately, one at a time.
//
// GET /api/audit-data-health-scan?secret=<BACKFILL_SECRET>

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;
const FIREBASE_PROJECT_ID = 'oro-audit';
const METABASE_BATCH_SIZE = 200;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = new Date().toISOString().slice(0, 10);

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

async function getAllAuditDocs(token) {
  const MAX_PAGES = 50;
  const docs = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    (data.documents || []).forEach(doc => {
      docs.push({ docId: doc.name.split('/').pop(), fields: doc.fields || {} });
    });
    pageToken = data.nextPageToken || null;
    pageCount++;
    if (pageCount >= MAX_PAGES && pageToken) break;
  } while (pageToken);

  return docs;
}

async function getCurrentGoldByLoan(loanIds) {
  const byLoan = {};
  for (let i = 0; i < loanIds.length; i += METABASE_BATCH_SIZE) {
    const batch = loanIds.slice(i, i + METABASE_BATCH_SIZE);
    const safeIds = batch.map(id => id.replace(/[^A-Za-z0-9\-]/g, ''));
    const inClause = safeIds.map(id => `'${id}'`).join(',');
    const query = `
      SELECT l.loan_number, go_type.name AS ornament_type, g.id AS gold_id
      FROM loan l
      JOIN gold g ON g.loan_id = l.id
      JOIN gold_ornament go_type ON go_type.id = g.gold_ornament_type_id
      WHERE l.loan_number IN (${inClause})
      AND g.is_active = true AND g.is_deleted = false AND g.original_gold_id IS NULL;
    `;
    const res = await fetch(`${METABASE_URL}/api/dataset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Metabase-Session': process.env.METABASE_SESSION_TOKEN,
        'Cookie': `metabase.SESSION=${process.env.METABASE_SESSION_TOKEN}`
      },
      body: JSON.stringify({ database: METABASE_DB_ID, type: 'native', native: { query } })
    });
    const data = await res.json();
    if (data.error) throw new Error('Metabase query failed: ' + data.error);
    (data.data?.rows || []).forEach(([loanNumber, type, goldId]) => {
      byLoan[loanNumber] = byLoan[loanNumber] || {};
      byLoan[loanNumber][type] = byLoan[loanNumber][type] || [];
      byLoan[loanNumber][type].push(goldId);
    });
  }
  return byLoan;
}

export default async function handler(req, res) {
  if (req.query.secret !== process.env.BACKFILL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = await getFirebaseToken();
    const docs = await getAllAuditDocs(token);

    const realDocs = docs.filter(d => d.fields.loanId?.stringValue);

    // 1. Missing loanBookingDate
    const missingBookingDate = [];
    // 2. Malformed loanBookingDate (not YYYY-MM-DD)
    const malformedBookingDate = [];
    // 3. twUpdatedAt from today with no twRecheckedBy (possible unattributed recheck, or import artifact recurrence)
    const suspiciousTwUpdate = [];
    // 4. Auditor missing, placeholder, or test-looking data
    const suspiciousAuditorOrLoanId = [];
    // 5. Ornaments still ambiguous (duplicate type) with no goldId
    const ambiguousOrnamentGroups = [];
    // 6. Ornaments with core measurement fields blank (informational — likely pre-dates mandatory validation)
    const incompleteOrnamentData = [];

    realDocs.forEach(d => {
      const f = d.fields;
      const loanId = f.loanId.stringValue;
      const source = f.source?.stringValue;
      const isRealAudit = source !== 'metabase-sync';

      if (isRealAudit) {
        const bookingDate = f.loanBookingDate?.stringValue;
        if (!bookingDate) {
          missingBookingDate.push({ docId: d.docId, loanId });
        } else if (!ISO_DATE_RE.test(bookingDate)) {
          malformedBookingDate.push({ docId: d.docId, loanId, value: bookingDate });
        }

        const twUpdatedAt = f.twUpdatedAt?.stringValue;
        if (twUpdatedAt && twUpdatedAt.slice(0, 10) === todayStr && !f.twRecheckedBy) {
          suspiciousTwUpdate.push({ docId: d.docId, loanId, twUpdatedAt, source: source || '(none)' });
        }

        const auditor = f.auditor?.stringValue;
        const looksLikePlaceholder = !auditor || auditor === '—' || auditor === 'Auditor';
        const looksLikeTest = /fake|test/i.test(loanId);
        if (looksLikePlaceholder || looksLikeTest) {
          suspiciousAuditorOrLoanId.push({ docId: d.docId, loanId, auditor: auditor || '(none)', reason: looksLikeTest ? 'loanId looks like test data' : 'placeholder/missing auditor' });
        }
      }

      const ornamentValues = f.ornaments?.arrayValue?.values;
      if (Array.isArray(ornamentValues) && ornamentValues.length) {
        const typeCount = {};
        ornamentValues.forEach(v => {
          const type = v.mapValue?.fields?.type?.stringValue;
          if (type) typeCount[type] = (typeCount[type] || 0) + 1;
        });
        const missingGoldIdByType = {};
        ornamentValues.forEach(v => {
          const of = v.mapValue?.fields;
          if (!of) return;
          const type = of.type?.stringValue;
          if (type && !of.goldId && typeCount[type] > 1) {
            missingGoldIdByType[type] = (missingGoldIdByType[type] || 0) + 1;
          }
          if (isRealAudit && (!of.gwAudit?.stringValue && !of.karatAudit?.stringValue && !of.hallmark?.stringValue)) {
            incompleteOrnamentData.push({ docId: d.docId, loanId, type: type || '(unknown)' });
          }
        });
        Object.entries(missingGoldIdByType).forEach(([type, count]) => {
          ambiguousOrnamentGroups.push({ docId: d.docId, loanId, type, count });
        });
      }
    });

    return res.status(200).json({
      totalDocsScanned: docs.length,
      realAuditDocs: realDocs.length,
      findings: {
        missingLoanBookingDate: { count: missingBookingDate.length, examples: missingBookingDate.slice(0, 10) },
        malformedLoanBookingDate: { count: malformedBookingDate.length, examples: malformedBookingDate.slice(0, 10) },
        suspiciousTwUpdateToday: { count: suspiciousTwUpdate.length, examples: suspiciousTwUpdate.slice(0, 10) },
        suspiciousAuditorOrLoanId: { count: suspiciousAuditorOrLoanId.length, examples: suspiciousAuditorOrLoanId.slice(0, 20) },
        ambiguousOrnamentGroupsStillMissingGoldId: { count: ambiguousOrnamentGroups.length, examples: ambiguousOrnamentGroups.slice(0, 20) },
        incompleteOrnamentMeasurements: {
          count: incompleteOrnamentData.length,
          note: 'Informational only — likely predates mandatory-field validation. Cannot be auto-fixed; would need a real re-audit.',
          examples: incompleteOrnamentData.slice(0, 10)
        }
      }
    });

  } catch (err) {
    console.error('Health scan failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
