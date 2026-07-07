// api/find-suspect-tw-updates.js
// TEMPORARY DIAGNOSTIC + FIX — delete after use.
//
// Problem: some audit docs have twUpdatedAt stamped to TODAY even though nobody
// clicked "Save" on a tare-weight recheck for them. This makes renderTWTable()'s
// sort (app.js) treat them as "rechecked today" and sink them to the very bottom
// of the Tare Weight list, completely overriding their real loanBookingDate.
//
// Confirmed so far (via debug-loan-doc.js) on two loans:
//   TCGL30675365 -> twUpdatedAt: 2026-07-07T09:04:00.628Z, source: sheet-fresh-import
//   TCGL30699711 -> twUpdatedAt: 2026-07-07T09:04:55.248Z, source: sheet-fresh-import
// Both stamped ~55 seconds apart under the same source — consistent with a bulk
// import/migration script touching many docs in sequence, not real individual
// Save clicks (which would be spread across the day at random intervals).
//
// This script does NOT assume every today-stamped record is bad — it reports
// them grouped by source and by how tightly their timestamps cluster, so you can
// visually confirm the pattern before anything gets changed.
//
// Two modes, both GET, both require ?secret=<BACKFILL_SECRET> (same secret as before):
//   ?mode=preview   (default) — lists every audit doc with twUpdatedAt from today,
//                     grouped by source, sorted by timestamp. Writes nothing.
//   ?mode=commit    — ONLY clears twUpdatedAt on docs whose source is
//                     'sheet-fresh-import' or 'sheet-import' (the confirmed import
//                     sources) AND whose twUpdatedAt falls on today's date. Any
//                     today-stamped doc from a DIFFERENT source (e.g. a real Save
//                     via the UI) is left completely untouched.

const FIREBASE_PROJECT_ID = 'oro-audit';
const IMPORT_SOURCES = ['sheet-fresh-import', 'sheet-import'];

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

async function getTodayStampedDocs(token, todayStr) {
  const MAX_PAGES = 50;
  const found = [];
  let pageToken = null;
  let pageCount = 0;

  do {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();

    if (data.documents) {
      data.documents.forEach(doc => {
        const fields = doc.fields || {};
        const twUpdatedAt = fields.twUpdatedAt?.stringValue;
        if (twUpdatedAt && twUpdatedAt.slice(0, 10) === todayStr) {
          found.push({
            docId: doc.name.split('/').pop(),
            loanId: fields.loanId?.stringValue,
            twUpdatedAt,
            source: fields.source?.stringValue || '(none)',
            auditor: fields.auditor?.stringValue || '(none)',
            loanBookingDate: fields.loanBookingDate?.stringValue || '(none)'
          });
        }
      });
    }

    pageToken = data.nextPageToken || null;
    pageCount++;
    if (pageCount >= MAX_PAGES && pageToken) {
      console.warn(`getTodayStampedDocs hit the ${MAX_PAGES}-page safety cap with more pages remaining — stopping early.`);
      break;
    }
  } while (pageToken);

  return found;
}

async function clearTwUpdatedAt(token, docId) {
  // updateMask targeting twUpdatedAt with no corresponding value in `fields`
  // deletes just that field, leaving everything else on the doc untouched.
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits/${docId}?updateMask.fieldPaths=twUpdatedAt`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: {} })
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
  const todayStr = new Date().toISOString().slice(0, 10);

  try {
    const token = await getFirebaseToken();
    const allTodayStamped = await getTodayStampedDocs(token, todayStr);

    const bySource = {};
    allTodayStamped.forEach(d => {
      bySource[d.source] = bySource[d.source] || [];
      bySource[d.source].push(d);
    });

    const importSuspects = allTodayStamped.filter(d => IMPORT_SOURCES.includes(d.source));
    const other = allTodayStamped.filter(d => !IMPORT_SOURCES.includes(d.source));

    if (mode === 'preview') {
      return res.status(200).json({
        mode: 'preview',
        todayStr,
        totalDocsWithTwUpdatedAtToday: allTodayStamped.length,
        countBySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])),
        importSourceSuspects: importSuspects.length,
        otherSourcesNotTouched: other.length,
        // Full listing so you can eyeball the timestamps and confirm the tight
        // clustering pattern (or spot anything that looks like a real Save).
        importSuspectSample: importSuspects
          .sort((a, b) => a.twUpdatedAt.localeCompare(b.twUpdatedAt))
          .map(d => ({ docId: d.docId, loanId: d.loanId, twUpdatedAt: d.twUpdatedAt, source: d.source, auditor: d.auditor, loanBookingDate: d.loanBookingDate })),
        otherSourcesDetail: other.map(d => ({ docId: d.docId, loanId: d.loanId, twUpdatedAt: d.twUpdatedAt, source: d.source, auditor: d.auditor })),
        note: 'Nothing was written. mode=commit will ONLY clear twUpdatedAt on the importSourceSuspects listed above — otherSourcesDetail entries are never touched.'
      });
    }

    // mode === 'commit' — only ever touches import-source docs
    let cleared = 0;
    const failures = [];
    for (const doc of importSuspects) {
      try {
        await clearTwUpdatedAt(token, doc.docId);
        cleared++;
      } catch (err) {
        failures.push({ docId: doc.docId, loanId: doc.loanId, error: err.message });
      }
    }

    return res.status(200).json({
      mode: 'commit',
      attempted: importSuspects.length,
      cleared,
      failed: failures.length,
      failures: failures.length > 0 ? failures : undefined,
      leftUntouched: other.map(d => ({ docId: d.docId, loanId: d.loanId, source: d.source }))
    });

  } catch (err) {
    console.error('find-suspect-tw-updates failed:', err);
    return res.status(500).json({ error: err.message });
  }
}
