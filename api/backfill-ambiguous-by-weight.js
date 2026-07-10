// api/backfill-ambiguous-by-weight.js
// ONE-TIME BACKFILL, second pass — not a recurring job, delete after use.
//
// backfill-ornament-gold-ids.js already handled every ornament that was
// unambiguous on both sides. What's left are ornaments where the SAME type
// appears more than once on a loan (e.g. two Lockets) — those were correctly
// left untouched rather than guessed.
//
// This script makes ONE more attempt at those specific leftovers, using a
// stronger signal than list position: gross weight. gwPC (the weight
// recorded on the Pledge Card at the time of that old audit) is a fixed
// physical measurement of a specific piece of gold — it doesn't change over
// time. If Metabase's CURRENT gold records for that loan+type still show a
// gross weight that matches ONE OLD ENTRY exactly, and that weight is unique
// among both the old duplicates and the current records, that's a genuine
// re-identification of the same physical item — not a guess.
//
// Anything where two old duplicates share the same recorded weight, or where
// the current records don't have a uniquely matching weight, is left
// completely untouched. No positional guessing, ever.
//
// Modes (both GET, both require ?secret=<BACKFILL_SECRET>):
//   ?mode=preview   (default) — reports what would be resolved and what
//                     would remain ambiguous even after this pass. Writes nothing.
//   ?mode=commit    — writes goldId onto the matched ornaments only.

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;
const FIREBASE_PROJECT_ID = 'oro-audit';
const METABASE_BATCH_SIZE = 200;
const WEIGHT_EPSILON = 0.001; // float-storage tolerance, not a measurement tolerance

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

// Same as before, but this time pulling gross_weight alongside goldId, since
// weight is the actual matching key for this pass.
async function getCurrentGoldByLoan(loanIds) {
  const byLoan = {}; // { loanId: { type: [{goldId, weight}, ...] } }

  for (let i = 0; i < loanIds.length; i += METABASE_BATCH_SIZE) {
    const batch = loanIds.slice(i, i + METABASE_BATCH_SIZE);
    const safeIds = batch.map(id => id.replace(/[^A-Za-z0-9\-]/g, ''));
    const inClause = safeIds.map(id => `'${id}'`).join(',');

    const query = `
      SELECT l.loan_number, go_type.name AS ornament_type, g.id AS gold_id, g.gross_weight
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

    (data.data?.rows || []).forEach(([loanNumber, type, goldId, weight]) => {
      byLoan[loanNumber] = byLoan[loanNumber] || {};
      byLoan[loanNumber][type] = byLoan[loanNumber][type] || [];
      byLoan[loanNumber][type].push({ goldId, weight });
    });
  }

  return byLoan;
}

function closeEnough(a, b) {
  return Math.abs(parseFloat(a) - parseFloat(b)) < WEIGHT_EPSILON;
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

    // Only look at docs that actually have an ambiguous (duplicate-type,
    // missing-goldId) ornament — no point querying Metabase for anything else.
    const relevantDocs = docs.filter(d => {
      const typeCount = {};
      d.ornamentValues.forEach(v => {
        const type = v.mapValue?.fields?.type?.stringValue;
        if (type) typeCount[type] = (typeCount[type] || 0) + 1;
      });
      return d.ornamentValues.some(v => {
        const f = v.mapValue?.fields;
        return f && !f.goldId && f.type?.stringValue && typeCount[f.type.stringValue] > 1;
      });
    });

    const loanIds = [...new Set(relevantDocs.map(d => d.loanId))];
    const currentGoldByLoan = await getCurrentGoldByLoan(loanIds);

    let ornamentsAssigned = 0;
    let ornamentsSkippedOldWeightCollision = 0;
    let ornamentsSkippedCurrentWeightCollision = 0;
    let ornamentsSkippedNoWeightMatch = 0;
    const sample = [];
    const writePlan = [];

    for (const doc of relevantDocs) {
      const typeCountInDoc = {};
      doc.ornamentValues.forEach(v => {
        const type = v.mapValue?.fields?.type?.stringValue;
        if (type) typeCountInDoc[type] = (typeCountInDoc[type] || 0) + 1;
      });

      // Group this doc's own ambiguous entries by type, so we can check
      // whether their OLD weights are even distinct from each other first.
      const ambiguousByType = {};
      doc.ornamentValues.forEach((v, idx) => {
        const f = v.mapValue?.fields;
        const type = f?.type?.stringValue;
        if (f && !f.goldId && type && typeCountInDoc[type] > 1) {
          ambiguousByType[type] = ambiguousByType[type] || [];
          ambiguousByType[type].push({ idx, gwPC: f.gwPC?.stringValue ?? f.gwPC?.doubleValue });
        }
      });

      let docModified = false;
      const newOrnamentValues = [...doc.ornamentValues];

      for (const [type, entries] of Object.entries(ambiguousByType)) {
        // If two old entries of this type share the same gwPC, weight can't
        // disambiguate them either — skip the whole group for this type.
        const oldWeightsDistinct = entries.every((e, i) =>
          entries.every((other, j) => i === j || !closeEnough(e.gwPC, other.gwPC))
        );
        if (!oldWeightsDistinct) {
          ornamentsSkippedOldWeightCollision += entries.length;
          continue;
        }

        const currentRecords = (currentGoldByLoan[doc.loanId] || {})[type] || [];

        entries.forEach(entry => {
          if (entry.gwPC == null) { ornamentsSkippedNoWeightMatch++; return; }
          const matches = currentRecords.filter(c => closeEnough(c.weight, entry.gwPC));
          if (matches.length === 0) { ornamentsSkippedNoWeightMatch++; return; }
          if (matches.length > 1) { ornamentsSkippedCurrentWeightCollision++; return; }

          // Exactly one current record shares this exact weight — assign.
          ornamentsAssigned++;
          docModified = true;
          const f = newOrnamentValues[entry.idx].mapValue.fields;
          newOrnamentValues[entry.idx] = {
            mapValue: { fields: { ...f, goldId: { integerValue: String(matches[0].goldId) } } }
          };
          if (sample.length < 30) {
            sample.push({ docId: doc.docId, loanId: doc.loanId, type, gwPC: entry.gwPC, assignedGoldId: matches[0].goldId });
          }
        });
      }

      if (docModified) writePlan.push({ docId: doc.docId, ornamentValues: newOrnamentValues });
    }

    if (mode === 'preview') {
      return res.status(200).json({
        mode: 'preview',
        ambiguousDocsExamined: relevantDocs.length,
        ornamentsThatWouldBeAssigned: ornamentsAssigned,
        stillAmbiguousAfterThisPass: {
          oldRecordHasWeightCollision: ornamentsSkippedOldWeightCollision,
          currentMetabaseHasWeightCollision: ornamentsSkippedCurrentWeightCollision,
          noMatchingWeightFound: ornamentsSkippedNoWeightMatch
        },
        sample,
        note: 'Nothing was written. Re-run with ?mode=commit to actually apply these assignments.'
      });
    }

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
      ornamentsAssigned
    });

  } catch (err) {
    console.error('Weight-match backfill failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
