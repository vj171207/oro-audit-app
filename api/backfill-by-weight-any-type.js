// api/backfill-by-weight-any-type.js
// ONE-TIME BACKFILL, final pass — not a recurring job, delete after use.
//
// Root cause found: TCGL31136183's "Studs" ornament was never assigned a
// goldId, not because the loan was closed, but because the OLD audit record
// stored the type as "Stud" (singular) while Metabase's current
// gold_ornament naming is "Studs" (plural). Every previous backfill pass
// filtered candidates by matching type NAME first — so a renamed type is
// silently treated as "not found," identical to a genuinely closed loan,
// even though the physical item and its weight are still sitting right
// there in Metabase under a slightly different label.
//
// This pass drops the type-name requirement entirely. For any ornament
// still missing goldId, it checks ALL current gold records for that loan —
// regardless of what type they're currently labeled — for a weight that
// matches the old record's gwPC. If exactly one candidate matches, that's
// almost certainly the same physical item, whatever it's called now. If its
// type name differs from what the old record says, that's noted explicitly
// rather than silently assumed.
//
// Genuinely closed/inactive loans are unaffected by this change — they have
// ZERO current gold records of ANY type, so there's nothing to match
// regardless of how loosely we search.
//
// Modes (both GET, both require ?secret=<BACKFILL_SECRET>):
//   ?mode=preview   (default) — reports what would be resolved, and flags
//                     every case where the matched type name differs from
//                     the old one (a real rename, not a coincidence).
//   ?mode=commit    — writes goldId onto the matched ornaments only.

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;
const FIREBASE_PROJECT_ID = 'oro-audit';
const METABASE_BATCH_SIZE = 200;
const WEIGHT_EPSILON = 0.001;

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
    if (pageCount >= MAX_PAGES && pageToken) break;
  } while (pageToken);
  return docs;
}

// This time: EVERY current gold record for the loan, with its type name and
// weight — no type filter applied, since type name is exactly what we can't
// trust to have stayed the same.
async function getAllCurrentGoldByLoan(loanIds) {
  const byLoan = {}; // { loanId: [{goldId, type, weight}, ...] }
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
    (data.data?.rows || []).forEach(([loanNumber, type, goldId, weight]) => {
      byLoan[loanNumber] = byLoan[loanNumber] || [];
      byLoan[loanNumber].push({ goldId, type, weight });
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

    const relevantDocs = docs.filter(d => d.ornamentValues.some(v => !v.mapValue?.fields?.goldId));
    const loanIds = [...new Set(relevantDocs.map(d => d.loanId))];
    const currentGoldByLoan = await getAllCurrentGoldByLoan(loanIds);

    let ornamentsAssigned = 0;
    let ornamentsAssignedWithRename = 0;
    let ornamentsSkippedNoMatch = 0;
    let ornamentsSkippedCollision = 0;
    const sample = [];
    const renameSample = [];
    const writePlan = [];

    for (const doc of relevantDocs) {
      const allCurrent = currentGoldByLoan[doc.loanId] || [];
      let docModified = false;
      const newOrnamentValues = [...doc.ornamentValues];

      doc.ornamentValues.forEach((v, idx) => {
        const f = v.mapValue?.fields;
        if (!f || f.goldId) return;
        const oldType = f.type?.stringValue;
        const gwPC = f.gwPC?.stringValue ?? f.gwPC?.doubleValue;
        if (gwPC == null) { ornamentsSkippedNoMatch++; return; }

        const matches = allCurrent.filter(c => closeEnough(c.weight, gwPC));
        if (matches.length === 0) { ornamentsSkippedNoMatch++; return; }
        if (matches.length > 1) { ornamentsSkippedCollision++; return; }

        const matched = matches[0];
        const renamed = oldType && matched.type !== oldType;

        ornamentsAssigned++;
        if (renamed) ornamentsAssignedWithRename++;
        docModified = true;
        newOrnamentValues[idx] = {
          mapValue: { fields: { ...f, goldId: { integerValue: String(matched.goldId) } } }
        };

        const entry = { docId: doc.docId, loanId: doc.loanId, oldType, currentType: matched.type, gwPC, assignedGoldId: matched.goldId };
        if (renamed && renameSample.length < 30) renameSample.push(entry);
        if (sample.length < 30) sample.push(entry);
      });

      if (docModified) writePlan.push({ docId: doc.docId, ornamentValues: newOrnamentValues });
    }

    if (mode === 'preview') {
      return res.status(200).json({
        mode: 'preview',
        docsExamined: relevantDocs.length,
        ornamentsThatWouldBeAssigned: ornamentsAssigned,
        ofWhichTypeNameChanged: ornamentsAssignedWithRename,
        stillUnresolved: {
          noMatchFound: ornamentsSkippedNoMatch,
          weightCollision: ornamentsSkippedCollision
        },
        renameSample,
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
      ornamentsAssigned,
      ofWhichTypeNameChanged: ornamentsAssignedWithRename
    });

  } catch (err) {
    console.error('Weight-any-type backfill failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
