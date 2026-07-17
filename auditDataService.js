// auditDataService.js
// ────────────────────────────────────────────────────────────────
// DATA ACCESS LAYER — all Firebase/Firestore calls live here, and only here.
//
// WHY THIS FILE EXISTS: in preparation for a possible future move to
// Tenmark Core's own backend/database, every place app.js used to call
// `db.collection(...)` directly has been pulled into a named function here
// instead. app.js now calls these functions by name and never touches
// Firestore directly.
//
// IMPORTANT: this is a pure relocation, not a behavior change. Every
// function below does exactly what the inline call it replaces used to do
// — same collection, same method, same arguments, same return shape. When
// Tenmark Core's actual backend is confirmed, only the *insides* of these
// functions need to change (e.g. swap `db.collection(...).get()` for a
// `fetch()` call) — nothing in app.js should need to change at all, since
// it only ever sees the function names and their return values.
//
// Loaded via <script> tag in index.html, BEFORE app.js, so `db`, `auth`,
// and every function below are available as globals when app.js runs —
// exactly the same as before, just organized into a separate file.
// ────────────────────────────────────────────────────────────────

// ── Firebase config ──
const firebaseConfig = {
  apiKey: "AIzaSyALq2Ss5yq2Kls-J9xB4rr3QSbxiu1cYfM",
  authDomain: "oro-audit.firebaseapp.com",
  projectId: "oro-audit",
  storageBucket: "oro-audit.firebasestorage.app",
  messagingSenderId: "875163871561",
  appId: "1:875163871561:web:be80f9291c72cce4029298"
};

// ── Firebase init (loaded via CDN in index.html) ──
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const COLLECTION = 'audits';
const auth = firebase.auth();

// ────────────────────────────────────────
// APP SETTINGS (collection: app_settings, doc: config)
// ────────────────────────────────────────

// Replaces: db.collection('app_settings').doc('config').get()  [was line 178]
function getAppSettingsDoc() {
  return db.collection('app_settings').doc('config').get();
}

// Replaces: db.collection('app_settings').doc('config').set(data, {merge:true})
// [was lines 2280, 2300, 2348 — same call shape in all three places, only
// the `data` object passed in differs, so one function covers all three]
function mergeAppSettings(data) {
  return db.collection('app_settings').doc('config').set(data, { merge: true });
}

// Replaces: db.collection('app_settings').doc('config').get().then(...)  [was line 2327]
// Kept as a separate function (rather than reusing getAppSettingsDoc) because
// the original call site used .then()/.catch() directly inline rather than
// async/await — preserved here as-is so the calling code doesn't need to change.
function getAppSettingsDocThenable() {
  return db.collection('app_settings').doc('config').get();
}

// ────────────────────────────────────────
// AUDITS (collection: audits)
// ────────────────────────────────────────

// Unchanged from original — was already a named function in app.js,
// simply relocated here as-is. [was line 337]
function loadAudits() {
  return db.collection(COLLECTION)
    .orderBy('date', 'desc')
    .get()
    .then(snapshot => {
      auditStore = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return auditStore;
    })
    .catch(err => {
      console.error('Firestore load error:', err);
      showErrorPopup(
        'Couldn\'t load audit history',
        'Audit records failed to load from Firestore. Check your internet connection and refresh the page.',
        err.message
      );
      // Re-throw (rather than returning []) so callers relying on Promise.all
      // to detect this failure — and show a persistent retry option instead
      // of silently rendering "0 audits" as if that were really the data —
      // actually see it. auditStore is deliberately left untouched here: on
      // a transient failure, keeping the last-known-good data on screen is
      // more honest than replacing it with an empty result.
      throw err;
    });
}

// Unchanged from original — was already a named function in app.js,
// simply relocated here as-is. [was line 366]
function saveAudit(audit) {
  return db.collection(COLLECTION)
    .add(audit)
    .then(ref => {
      audit.id = ref.id;
      auditStore.unshift(audit);
      return audit;
    });
}

// Replaces: db.collection(COLLECTION).where('loanId', 'in', batch).get()  [was line 492]
function queryAuditsByLoanIdBatch(batch) {
  return db.collection(COLLECTION).where('loanId', 'in', batch).get();
}

// Replaces: db.collection('audits').doc(pendingDocId).delete()  [was line 1261]
function deleteAuditDoc(docId) {
  return db.collection('audits').doc(docId).delete();
}

// Replaces: db.collection('audits').doc(audit.id).update(updates)  [was line 1588]
function updateAuditDoc(docId, updates) {
  return db.collection('audits').doc(docId).update(updates);
}

// ────────────────────────────────────────
// USERS (collection: users)
// ────────────────────────────────────────

// Replaces: db.collection('users').doc(currentUser.uid).get()  [was line 2003]
function getUserDoc(uid) {
  return db.collection('users').doc(uid).get();
}

// Replaces: db.collection('users').get()  [was line 2144]
function getAllUsersSnapshot() {
  return db.collection('users').get();
}
