// api/create-user.js
// Creates a Firebase Auth user + Firestore record in one shot
// Called from the Settings panel by managers only

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
  return data.idToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, role, callerToken } = req.body;

  if (!email || !password || !role) {
    return res.status(400).json({ error: 'Email, password and role are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!['auditor', 'manager'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  try {
    // Use Firebase Auth REST API to create user
    const apiKey = process.env.FIREBASE_API_KEY;

    // Create the Auth user
    const createRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: false })
      }
    );
    const createData = await createRes.json();

    if (createData.error) {
      const msg = createData.error.message;
      if (msg === 'EMAIL_EXISTS') return res.status(400).json({ error: 'This email is already registered.' });
      return res.status(400).json({ error: msg });
    }

    const uid = createData.localId;

    // Write user record to Firestore
    const token = await getFirebaseToken();
    const firestoreRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          fields: {
            email: { stringValue: email },
            role: { stringValue: role },
            uid: { stringValue: uid },
            createdAt: { stringValue: new Date().toISOString() }
          }
        })
      }
    );

    if (!firestoreRes.ok) {
      return res.status(500).json({ error: 'User created in Auth but failed to save role. Contact admin.' });
    }

    return res.status(200).json({ success: true, uid, email, role });

  } catch (err) {
    console.error('create-user error:', err);
    return res.status(500).json({ error: err.message });
  }
}
