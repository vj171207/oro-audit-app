// api/diagnose-remaining-ambiguous.js
// READ-ONLY DIAGNOSTIC — delete after use. Writes nothing, ever.
//
// After backfill-ornament-gold-ids.js (exact/unambiguous pass) and
// backfill-ambiguous-by-weight.js (weight-match pass), some ornaments still
// have no goldId — either because they're genuinely ambiguous in current
// Metabase too, or because no current record shares the old recorded weight.
//
// This lists exactly those remaining ornaments, alongside EVERY current
// Metabase candidate of that same type on that same loan (with weight,
// karat, quantity) — so a person can look at the actual numbers and decide
// whether a looser match (weight tolerance, karat+count combo) is
// defensible, on a case-by-case basis, rather than guessing blindly.
//
// GET /api/diagnose-remaining-ambiguous?secret=<BACKFILL_SECRET>

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

async function getCurrentGoldByLoan(loanIds) {
  const byLoan = {}; // { loanId: { type: [{goldId, weight, karat, quantity}, ...] } }

  for (let i = 0; i < loanIds.length; i += METABASE_BATCH_SIZE) {
    const batch = loanIds.slice(i, i + METABASE_BATCH_SIZE);
    const safeIds = batch.map(id => id.replace(/[^A-Za-z0-9\-]/g, ''));
    const inClause = safeIds.map(id => `'${id}'`).join(',');

    const query = `
      SELECT l.loan_number, go_type.name AS ornament_type, g.id AS gold_id,
             g.gross_weight, g.actual_quality, g.quantity
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

    (data.data?.rows || []).forEach(([loanNumber, type, goldId, weight, karat, quantity]) => {
      byLoan[loanNumber] = byLoan[loanNumber] || {};
      byLoan[loanNumber][type] = byLoan[loanNumber][type] || [];
      byLoan[loanNumber][type].push({ goldId, weight, karat, quantity });
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
    const docs = await getAuditDocsWithOrnaments(token);

    // Same "ambiguous type, no goldId" filter as before — but now, after
    // both backfill passes, whatever's left here IS the remaining unresolved set.
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

    const results = [];
    for (const doc of relevantDocs) {
      doc.ornamentValues.forEach(v => {
        const f = v.mapValue?.fields;
        if (!f || f.goldId) return;
        const type = f.type?.stringValue;
        if (!type) return;

        const candidates = (currentGoldByLoan[doc.loanId] || {})[type] || [];
        // Only report if there ARE current candidates of this type but none
        // exactly matched by weight in the previous pass — i.e. genuinely
        // "close but not exact" or "current data disagrees" cases.
        if (candidates.length > 0) {
          results.push({
            docId: doc.docId,
            loanId: doc.loanId,
            type,
            oldRecord: {
              gwPC: f.gwPC?.stringValue ?? f.gwPC?.doubleValue ?? null,
              karatPC: f.karatPC?.stringValue ?? f.karatPC?.doubleValue ?? null,
              countPC: f.count?.integerValue ?? f.count?.stringValue ?? null,
              gwAudit: f.gwAudit?.stringValue ?? null,
              karatAudit: f.karatAudit?.stringValue ?? null,
              countAudit: f.countAudit?.integerValue ?? null
            },
            currentCandidates: candidates
          });
        }
      });
    }

    // De-duplicate identical (docId, type) groups so each ambiguous type on
    // a loan shows once with all its old entries together, easier to read.
    const grouped = {};
    results.forEach(r => {
      const key = r.docId + '|' + r.type;
      grouped[key] = grouped[key] || { docId: r.docId, loanId: r.loanId, type: r.type, oldEntries: [], currentCandidates: r.currentCandidates };
      grouped[key].oldEntries.push(r.oldRecord);
    });

    return res.status(200).json({
      totalRemainingWithCandidates: Object.keys(grouped).length,
      details: Object.values(grouped)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
