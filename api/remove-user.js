// api/remove-user.js
// Removes a Firestore user record (revokes app access) — called from the
// Settings panel by managers only.
//
// This exists because removeUser() in app.js was previously trying to
// delete the Firestore document DIRECTLY from the browser, using the
// manager's own session. The security rules for the `users` collection
// only permit writes from the app's own service account
// (sync@oroaudit.com) — so that direct delete was ALWAYS going to fail with
// "Missing or insufficient permissions," for every manager, on every
// network, regardless of browser or extensions. This endpoint does the
// delete server-side, authenticated as that service account, after
// confirming the caller is a genuine, currently-valid manager — the same
// pattern already used by create-user.js and reset-password.js.
//
// Scope note: this only removes the Firestore record that grants the user
// access inside this app. It does not delete their underlying Firebase Auth
// account — matching exactly what the original client-side delete did
// (their login would fail afterward since the app's login flow requires
// this Firestore doc to exist, but their Auth credentials themselves are
// untouched). Expanding this to also delete the Auth account would be a
// real scope change, not just a bug fix, so it's deliberately left out here.

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

// Identical check to create-user.js's verifyCallerIsManager — verifies
// callerToken is a genuine, currently-valid session belonging to a user
// whose Firestore role is 'manager'.
async function verifyCallerIsManager(callerToken, adminToken) {
  if (!callerToken) {
    return { ok: false, error: 'Missing authentication. Please log in again.' };
  }

  const apiKey = process.env.FIREBASE_API_KEY;
  const lookupRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
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
    return { ok: false, error: 'Only managers can remove users.' };
  }
  return { ok: true, uid: callerUid };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { docId, callerToken } = req.body;

  if (!docId) {
    return res.status(400).json({ error: 'docId is required.' });
  }

  try {
    const token = await getFirebaseToken();

    const verification = await verifyCallerIsManager(callerToken, token);
    if (!verification.ok) {
      return res.status(403).json({ error: verification.error });
    }

    // A manager can't accidentally remove their own access this way — this
    // mirrors the general principle of not letting the last/current admin
    // lock themselves out with no one left who can undo it.
    if (verification.uid === docId) {
      return res.status(400).json({ error: 'You can\'t remove your own account.' });
    }

    const deleteRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${docId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );

    if (!deleteRes.ok) {
      const errText = await deleteRes.text();
      return res.status(500).json({ error: 'Failed to remove user record: ' + errText.slice(0, 200) });
    }

    return res.status(200).json({ success: true, docId });

  } catch (err) {
    console.error('remove-user error:', err);
    return res.status(500).json({ error: err.message });
  }
}
