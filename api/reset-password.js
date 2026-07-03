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

// Verifies that callerToken is a genuine, currently-valid Firebase session
// belonging to a user whose Firestore role is 'manager'. Previously this
// endpoint had no caller check at all — any request with a valid email
// could reset that user's password.
async function verifyCallerIsManager(callerToken, adminToken) {
  if (!callerToken) {
    return { ok: false, error: 'Missing authentication. Please log in again.' };
  }

  const lookupRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: callerToken })
    }
  );
  const lookupData = await lookupRes.json();
  const callerUid = lookupData.users?.[0]?.localId;
  if (lookupData.error || !callerUid) {
    return { ok: false, error: 'Invalid or expired session. Please log in again.' };
  }

  const roleRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${callerUid}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const roleData = await roleRes.json();
  const callerRole = roleData.fields?.role?.stringValue;

  if (callerRole !== 'manager') {
    return { ok: false, error: 'Only managers can reset passwords.' };
  }
  return { ok: true, uid: callerUid };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, newPassword, callerToken } = req.body;

  if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    // Get admin token — used for both the manager-role check and the
    // existing Firestore lookup below.
    const adminToken = await getAdminToken();

    const verification = await verifyCallerIsManager(callerToken, adminToken);
    if (!verification.ok) {
      return res.status(403).json({ error: verification.error });
    }

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
