// tests/data-service-unwrap.test.js
//
// WHAT THIS TESTS: that auditDataService.js's 5 previously "leaky"
// functions now return plain JS values (objects/arrays/null) instead of
// raw Firestore DocumentSnapshot/QuerySnapshot objects — and that this
// is true for BOTH the "doc exists / has results" case AND the
// "doc missing / empty results" edge case.
//
// This is exactly what a future backend swap (Tenmark Core DB) depends
// on: whatever replaces `db`, these 5 functions must keep returning the
// same plain shapes. This test locks that contract in place.
//
// No real Firebase needed — `db` is mocked in-file to simulate exactly
// what the Firestore SDK returns.
//
// Run with: node tests/data-service-unwrap.test.js

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// ── Minimal Firestore-shaped mock ──
// Mimics real Firestore snapshot objects closely enough to exercise the
// exact unwrapping code paths in auditDataService.js.
function makeDocSnapshot(exists, id, data) {
  return { exists, id, data: () => data };
}
function makeQuerySnapshot(docs) {
  return { docs: docs.map(([id, data]) => makeDocSnapshot(true, id, data)), empty: docs.length === 0 };
}

function makeMockDb(scenario) {
  return {
    collection(name) {
      return {
        doc(id) {
          return { get: () => Promise.resolve(scenario.docs[`${name}/${id}`]) };
        },
        where() {
          return { get: () => Promise.resolve(scenario.queries[name]) };
        },
        get: () => Promise.resolve(scenario.queries[name]),
        orderBy() { return this; }, // not exercised by these 5 functions
      };
    },
  };
}

// ── Load auditDataService.js functions with a mock `db`/`firebase` in scope ──
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'auditDataService.js'), 'utf8');

function loadServiceWithMockDb(scenario) {
  const mockDb = makeMockDb(scenario);
  const mockFirebase = { initializeApp: () => {}, firestore: () => mockDb, auth: () => ({}) };
  const sandbox = { firebase: mockFirebase, console, showErrorPopup: () => {}, auditStore: [] };
  // Strip the firebase.initializeApp/db/auth init lines by running the
  // whole file in a function scope where `firebase` is our mock — the
  // real init calls run harmlessly against the mock.
  const fn = new Function('firebase', 'console', 'showErrorPopup', `
    ${src}
    return { getAppSettingsDoc, getAppSettingsDocThenable, queryAuditsByLoanIdBatch, getUserDoc, getAllUsersSnapshot };
  `);
  return fn(mockFirebase, console, () => {});
}

async function run() {
  console.log('\n1. getAppSettingsDoc — doc exists');
  {
    const svc = loadServiceWithMockDb({ docs: { 'app_settings/config': makeDocSnapshot(true, 'config', { pendingDays: 30 }) }, queries: {} });
    const result = await svc.getAppSettingsDoc();
    check('returns plain object, not a snapshot', result && typeof result === 'object' && result.exists === undefined);
    check('has the expected field', result.pendingDays === 30);
    check('has no leaked .data method', typeof result.data !== 'function');
  }

  console.log('\n2. getAppSettingsDoc — doc missing (edge case)');
  {
    const svc = loadServiceWithMockDb({ docs: { 'app_settings/config': makeDocSnapshot(false, 'config', undefined) }, queries: {} });
    const result = await svc.getAppSettingsDoc();
    check('returns null, not a snapshot with exists:false', result === null);
  }

  console.log('\n3. getAppSettingsDocThenable — doc exists');
  {
    const svc = loadServiceWithMockDb({ docs: { 'app_settings/config': makeDocSnapshot(true, 'config', { lastSyncAt: '2026-07-01' }) }, queries: {} });
    const result = await svc.getAppSettingsDocThenable();
    check('returns plain object', result.lastSyncAt === '2026-07-01');
  }

  console.log('\n4. getAppSettingsDocThenable — doc missing (edge case)');
  {
    const svc = loadServiceWithMockDb({ docs: { 'app_settings/config': makeDocSnapshot(false, 'config', undefined) }, queries: {} });
    const result = await svc.getAppSettingsDocThenable();
    check('returns null', result === null);
  }

  console.log('\n5. queryAuditsByLoanIdBatch — results found');
  {
    const svc = loadServiceWithMockDb({ docs: {}, queries: { audits: makeQuerySnapshot([['a1', { loanId: 'TCGL1', date: '2026-07-01' }], ['a2', { loanId: 'TCGL2', date: '2026-07-02' }]]) } });
    const result = await svc.queryAuditsByLoanIdBatch(['TCGL1', 'TCGL2']);
    check('returns a plain array', Array.isArray(result));
    check('array has no .docs wrapper', result.docs === undefined);
    check('each item has id + fields merged', result[0].id === 'a1' && result[0].loanId === 'TCGL1');
    check('correct length', result.length === 2);
  }

  console.log('\n6. queryAuditsByLoanIdBatch — no results (edge case)');
  {
    const svc = loadServiceWithMockDb({ docs: {}, queries: { audits: makeQuerySnapshot([]) } });
    const result = await svc.queryAuditsByLoanIdBatch(['TCGL999']);
    check('returns empty array, not empty QuerySnapshot', Array.isArray(result) && result.length === 0);
  }

  console.log('\n7. getUserDoc — user exists');
  {
    const svc = loadServiceWithMockDb({ docs: { 'users/uid123': makeDocSnapshot(true, 'uid123', { email: 'vj@orocorp.in', role: 'auditor' }) }, queries: {} });
    const result = await svc.getUserDoc('uid123');
    check('returns plain object with id merged in', result.id === 'uid123' && result.email === 'vj@orocorp.in');
    check('no leaked .exists property shadowing real data', result.role === 'auditor');
  }

  console.log('\n8. getUserDoc — user missing (edge case, access-denied path)');
  {
    const svc = loadServiceWithMockDb({ docs: { 'users/ghost': makeDocSnapshot(false, 'ghost', undefined) }, queries: {} });
    const result = await svc.getUserDoc('ghost');
    check('returns null so app.js can do a simple falsy check', result === null);
  }

  console.log('\n9. getAllUsersSnapshot — users exist');
  {
    const svc = loadServiceWithMockDb({ docs: {}, queries: { users: makeQuerySnapshot([['u1', { email: 'a@orocorp.in', role: 'manager' }], ['u2', { email: 'b@orocorp.in', role: 'auditor' }]]) } });
    const result = await svc.getAllUsersSnapshot();
    check('returns plain array', Array.isArray(result));
    check('correct count', result.length === 2);
    check('id preserved per user for removeUser() calls downstream', result[0].id === 'u1');
  }

  console.log('\n10. getAllUsersSnapshot — no users (edge case, "No users yet" path)');
  {
    const svc = loadServiceWithMockDb({ docs: {}, queries: { users: makeQuerySnapshot([]) } });
    const result = await svc.getAllUsersSnapshot();
    check('returns empty array so app.js can just check .length', Array.isArray(result) && result.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
