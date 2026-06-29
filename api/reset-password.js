// api/reset-password.js
// Allows a manager to reset another user's password
// Uses Firebase Auth REST API

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_SYNC_EMAIL = process.env.FIREBASE_SYNC_EMAIL;
const FIREBASE_SYNC_PASSWORD = process.env.FIREBASE_SYNC_PASSWORD;
const FIREBASE_PROJECT_ID = 'oro-audit';

async function getAdminToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: FIREBASE_SYNC_EMAIL, password: FIREBASE_SYNC_PASSWORD, returnSecureToken: true })
    }
  );
  const data = await res.json();
  return data.idToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, newPassword } = req.body;

  if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    // Get admin token
    const adminToken = await getAdminToken();

    // Look up the user's UID from Firestore
    const fsRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'users' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'email' },
                op: 'EQUAL',
                value: { stringValue: email }
              }
            },
            limit: 1
          }
        })
      }
    );
    const fsData = await fsRes.json();
    const userDoc = fsData[0]?.document;
    if (!userDoc) return res.status(404).json({ error: 'User not found.' });

    const uid = userDoc.fields?.uid?.stringValue;
    if (!uid) return res.status(404).json({ error: 'User UID not found.' });

    // Update password via Firebase Auth REST API
    const updateRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: adminToken, localId: uid, password: newPassword, returnSecureToken: false })
      }
    );

    // Use Admin approach — update via identity platform
    const adminUpdateRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: uid, password: newPassword })
      }
    );

    const adminUpdateData = await adminUpdateRes.json();
    if (adminUpdateData.error) {
      return res.status(400).json({ error: adminUpdateData.error.message });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ error: err.message });
  }
}
