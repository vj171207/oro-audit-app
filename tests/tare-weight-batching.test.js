// tests/tare-weight-batching.test.js
//
// Tests the batching and merge logic behind loadActiveTareWeightAudits()
// in app.js — the fix that made Tare Weight fetch only currently-active
// loans instead of the entire audit history. See the README's
// "Performance: why two different fixes" section for the full context.
//
// Run with: node tests/tare-weight-batching.test.js

const FIRESTORE_IN_QUERY_LIMIT = 30; // Firestore's own hard limit on `in` queries

function simulateBatching(loanIds) {
  const batches = [];
  for (let i = 0; i < loanIds.length; i += FIRESTORE_IN_QUERY_LIMIT) {
    batches.push(loanIds.slice(i, i + FIRESTORE_IN_QUERY_LIMIT));
  }
  return batches;
}

// Must stay in sync with the merge logic inside loadActiveTareWeightAudits().
function simulateMerge(auditStore, freshResults) {
  freshResults.forEach(fresh => {
    const idx = auditStore.findIndex(a => a.id === fresh.id);
    if (idx >= 0) auditStore[idx] = fresh;
    else auditStore.unshift(fresh);
  });
  return auditStore;
}

let passed = 0, failed = 0;
function check(label, condition) {
  console.log((condition ? 'PASS' : 'FAIL') + ' — ' + label);
  condition ? passed++ : failed++;
}

// Batching must cover every loan ID, split into groups no larger than
// Firestore's hard limit — getting this wrong either silently drops loans
// or sends an oversized query Firestore will reject outright.
const loanIds147 = Array.from({ length: 147 }, (_, i) => 'TCGL' + i);
const batches = simulateBatching(loanIds147);
check('147 loans split into exactly 5 batches', batches.length === 5);
check('Every batch is 30 or fewer', batches.every(b => b.length <= 30));
check('All 147 loans are covered, none dropped or duplicated', batches.flat().length === 147);

check('Empty active-loan list produces zero batches (no crash)', simulateBatching([]).length === 0);

// Merge must UPDATE an existing record rather than duplicate it.
let store = [{ id: 'doc1', loanId: 'TCGL001', tw: 10.5 }, { id: 'doc2', loanId: 'TCGL002', tw: 20.0 }];
simulateMerge(store, [{ id: 'doc1', loanId: 'TCGL001', tw: 11.0 }]);
check('Merge updates an existing doc in place, does not duplicate it', store.length === 2 && store.find(a => a.id === 'doc1').tw === 11.0);

// Merge must ADD a genuinely new record.
simulateMerge(store, [{ id: 'doc3', loanId: 'TCGL003', tw: 5.0 }]);
check('Merge adds a genuinely new doc', store.length === 3 && !!store.find(a => a.id === 'doc3'));

// Unrelated data must be completely untouched by a merge.
check('Unrelated existing records are left untouched', store.find(a => a.id === 'doc2').tw === 20.0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
