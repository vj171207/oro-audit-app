// api/debug-loan-doc.js
// TEMPORARY READ-ONLY DIAGNOSTIC — delete after use.
// Returns the RAW Firestore field data for every audit doc matching a given
// loanId, so we can see exactly what's stored (including whether a given
// ornament type was ever recorded at all) without guessing from the UI.
//
// GET /api/debug-loan-doc?loanId=TCGL31136183&secret=<BACKFILL_SECRET>

const FIREBASE_PROJECT_ID = 'oro-audit';

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

export default async function handler(req, res) {
  if (req.query.secret !== process.env.BACKFILL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const loanId = req.query.loanId;
  if (!loanId) return res.status(400).json({ error: 'loanId is required' });

  try {
    const token = await getFirebaseToken();
    const matches = [];
    let pageToken = null;
    let pageCount = 0;

    do {
      const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/audits?pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();

      (data.documents || []).forEach(doc => {
        if (doc.fields?.loanId?.stringValue === loanId) {
          matches.push({
            docId: doc.name.split('/').pop(),
            allFields: doc.fields
          });
        }
      });

      pageToken = data.nextPageToken || null;
      pageCount++;
    } while (pageToken && pageCount < 50);

    return res.status(200).json({ loanId, matchCount: matches.length, matches });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
