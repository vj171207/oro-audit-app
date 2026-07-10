// api/backfill-ornament-gold-ids.js
// ONE-TIME BACKFILL — not a recurring job, delete this file once it's been run.
//
// Retroactively assigns `goldId` onto historical audit records' ornaments, so
// old audits can benefit from the exact-match re-audit reference feature
// (see getPreviousAuditForLoan/matchPreviousOrnament in app.js) instead of
// always falling back to type-name matching.
//
// This ONLY assigns a goldId when it can be done with total confidence:
//   - The ornament type appears exactly ONCE in the old audit's own record, AND
//   - That same type appears exactly ONCE in Metabase's CURRENT gold records
//     for that loan.
// If either side has more than one of that type, the ornament is left
// completely untouched — no guessing. There's no reliable way to know which
// of two same-named old entries belongs to which current gold record, and a
// wrong guess dressed up as a confirmed match would be worse than the
// existing honest "ambiguous, compare manually" fallback already in place.
//
// Two modes, both GET requests, both require ?secret=<BACKFILL_SECRET>:
//   ?mode=preview   (default) — reports what WOULD be assigned and what would
//                     be skipped and why. Writes nothing.
//   ?mode=commit    — writes goldId onto the matched ornaments only. Every
//                     other field on every ornament is left byte-for-byte
//                     untouched; unmatched ornaments are not modified at all.

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;
const FIREBASE_PROJECT_ID = 'oro-audit';
const METABASE_BATCH_SIZE = 200;

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

// Fetch every audit doc that has an ornaments array, keeping the RAW
// Firestore field wrappers untouched — we'll surgically edit specific
// ornament entries later, not round-trip the whole structure through JS.
async function getAuditDocsWithOrnaments(token) {
  const MAX_PAGES = 50;
  const docs = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    (data.documents || []).forEach(doc => {
      const fields = doc.fields || {};
      const loanId = fields.loanId?.stringValue;
      const ornamentValues = fields.ornaments?.arrayValue?.values;
      if (loanId && Array.isArray(ornamentValues) && ornamentValues.length) {
        docs.push({ docId: doc.name.split('/').pop(), loanId, ornamentValues });
      }
    });

    pageToken = data.nextPageToken || null;
    pageCount++;
    if (pageCount >= MAX_PAGES && pageToken) {
      console.warn(`getAuditDocsWithOrnaments hit the ${MAX_PAGES}-page safety cap — stopping early.`);
      break;
    }
  } while (pageToken);

  return docs;
}

// One batched, grouped query for every loan needed — returns, per loan, the
// list of current gold IDs for each ornament type (AP records only, same
// filter as the fixed loan-lookup.js).
async function getCurrentGoldIdsByLoan(loanIds) {
  const byLoan = {}; // { loanId: { type: [goldId, goldId, ...] } }

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
      AND g.is_active = true
      AND g.is_deleted = false
      AND g.original_gold_id IS NULL;
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

async function writeOrnaments(token, docId, ornamentValues) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits/${docId}?updateMask.fieldPaths=ornaments`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: { ornaments: { arrayValue: { values: ornamentValues } } } })
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
    const docs = await getAuditDocsWithOrnaments(token);

    // Only bother querying Metabase for loans that actually have at least
    // one ornament missing a goldId — no point fetching current data for
    // loans that are already fully backfilled.
    const loansNeedingCheck = [...new Set(
      docs
        .filter(d => d.ornamentValues.some(v => !v.mapValue?.fields?.goldId))
        .map(d => d.loanId)
    )];

    const currentGoldIdsByLoan = await getCurrentGoldIdsByLoan(loansNeedingCheck);

    let docsChanged = 0;
    let ornamentsAssigned = 0;
    let ornamentsSkippedAmbiguousInDoc = 0;
    let ornamentsSkippedAmbiguousInMetabase = 0;
    let ornamentsSkippedNoMatchInMetabase = 0;
    let ornamentsAlreadyHadGoldId = 0;
    const sample = [];
    const writePlan = []; // { docId, ornamentValues } — only for commit mode

    for (const doc of docs) {
      // Count occurrences of each type WITHIN this doc's own ornament list.
      const typeCountInDoc = {};
      doc.ornamentValues.forEach(v => {
        const type = v.mapValue?.fields?.type?.stringValue;
        if (type) typeCountInDoc[type] = (typeCountInDoc[type] || 0) + 1;
      });

      const metabaseTypes = currentGoldIdsByLoan[doc.loanId] || {};
      let docModified = false;
      const newOrnamentValues = doc.ornamentValues.map(v => {
        const fields = v.mapValue?.fields;
        if (!fields) return v;
        if (fields.goldId) { ornamentsAlreadyHadGoldId++; return v; }

        const type = fields.type?.stringValue;
        if (!type) return v;

        if (typeCountInDoc[type] > 1) {
          ornamentsSkippedAmbiguousInDoc++;
          return v;
        }

        const metabaseIds = metabaseTypes[type];
        if (!metabaseIds || metabaseIds.length === 0) {
          ornamentsSkippedNoMatchInMetabase++;
          return v;
        }
        if (metabaseIds.length > 1) {
          ornamentsSkippedAmbiguousInMetabase++;
          return v;
        }

        // Exactly one on both sides — safe to assign.
        ornamentsAssigned++;
        docModified = true;
        if (sample.length < 30) {
          sample.push({ docId: doc.docId, loanId: doc.loanId, type, assignedGoldId: metabaseIds[0] });
        }
        return {
          mapValue: {
            fields: { ...fields, goldId: { integerValue: String(metabaseIds[0]) } }
          }
        };
      });

      if (docModified) {
        docsChanged++;
        writePlan.push({ docId: doc.docId, ornamentValues: newOrnamentValues });
      }
    }

    if (mode === 'preview') {
      return res.status(200).json({
        mode: 'preview',
        totalAuditDocsScanned: docs.length,
        loansCheckedAgainstMetabase: loansNeedingCheck.length,
        docsThatWouldBeModified: docsChanged,
        ornamentsThatWouldBeAssigned: ornamentsAssigned,
        ornamentsAlreadyHadGoldId,
        ornamentsSkipped: {
          ambiguousInOldRecord: ornamentsSkippedAmbiguousInDoc,
          ambiguousInCurrentMetabase: ornamentsSkippedAmbiguousInMetabase,
          noLongerFoundInMetabase: ornamentsSkippedNoMatchInMetabase
        },
        sample,
        note: 'Nothing was written. Re-run with ?mode=commit to actually apply these assignments.'
      });
    }

    // mode === 'commit'
    let written = 0;
    const failures = [];
    for (const plan of writePlan) {
      try {
        await writeOrnaments(token, plan.docId, plan.ornamentValues);
        written++;
      } catch (err) {
        failures.push({ docId: plan.docId, error: err.message });
      }
    }

    return res.status(200).json({
      mode: 'commit',
      docsAttempted: writePlan.length,
      docsWritten: written,
      docsFailed: failures.length,
      failures: failures.length ? failures : undefined,
      ornamentsAssigned,
      ornamentsSkipped: {
        ambiguousInOldRecord: ornamentsSkippedAmbiguousInDoc,
        ambiguousInCurrentMetabase: ornamentsSkippedAmbiguousInMetabase,
        noLongerFoundInMetabase: ornamentsSkippedNoMatchInMetabase
      }
    });

  } catch (err) {
    console.error('Backfill failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
