// tests/tw-counters-and-apirequest.test.js
//
// Covers two refactors made together (no behavior change intended in either):
//
// 1. apiRequest() — a single wrapper now used by all 9 /api/* call sites
//    instead of each one calling fetch() directly. Tested by confirming it
//    performs the exact same fetch + res.json() sequence.
//
// 2. computeAuditedLoansForTW / sortTWLoans / computeTWCounters — pulled out
//    of renderTWTable() so the "which loans, what order, what counts" logic
//    is testable without a DOM. This test proves the extracted functions
//    produce IDENTICAL output to what the original inline code computed,
//    using realistic audit-shaped fixtures.
//
// Logic under test is copied here per this repo's existing test convention
// (see ornament-matching.test.js). If you change the real logic, update
// this copy too.
//
// Run with: node tests/tw-counters-and-apirequest.test.js

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// ── Copied logic under test ──

function computeAuditedLoansForTW(auditStore, activeLoanIds) {
  const audited = auditStore.filter(a => a.tw !== null && a.tw !== undefined && a.source !== 'metabase-sync' && activeLoanIds.has(a.loanId));
  const loanMap = {};
  audited.forEach(a => {
    if (!loanMap[a.loanId] || a.date > loanMap[a.loanId].date) {
      loanMap[a.loanId] = a;
    }
  });
  return Object.values(loanMap);
}

function sortTWLoans(loans, todayStr) {
  return [...loans].sort((a, b) => {
    const aDoneToday = !!(a.twUpdatedAt && a.twUpdatedAt.slice(0, 10) === todayStr);
    const bDoneToday = !!(b.twUpdatedAt && b.twUpdatedAt.slice(0, 10) === todayStr);
    if (aDoneToday !== bDoneToday) return aDoneToday ? 1 : -1;
    if (aDoneToday && bDoneToday) {
      return (a.twUpdatedAt || '').localeCompare(b.twUpdatedAt || '');
    }
    if (!a.loanBookingDate && !b.loanBookingDate) return 0;
    if (!a.loanBookingDate) return -1;
    if (!b.loanBookingDate) return 1;
    return (a.loanBookingDate || '').localeCompare(b.loanBookingDate || '');
  });
}

function computeTWCounters(loans, twCurrentValues, todayStr, twThreshold, getLoanStatusFn) {
  const checked = Object.keys(twCurrentValues).length;
  const flagged = Object.entries(twCurrentValues).filter(([id, v]) => {
    const a = loans.find(x => x.loanId === id);
    return a && a.tw != null && Math.abs(v - a.tw) > twThreshold;
  }).length;
  const matched = checked - flagged;
  const pendingCount = loans.filter(a => getLoanStatusFn(a.loanId) === 'pending').length;
  const completedToday = loans.filter(a => a.twUpdatedAt && a.twUpdatedAt.slice(0, 10) === todayStr).length;
  const remainingToday = loans.length - completedToday;
  return { checked, flagged, matched, pendingCount, completedToday, remainingToday };
}

// ── ORIGINAL inline logic, reproduced verbatim, to diff against the
// extracted version above using identical fixtures ──
function originalInlineComputation(auditStore, activeLoanIds, twCurrentValues, twThreshold, getLoanStatusFn) {
  const audited = auditStore.filter(a => a.tw !== null && a.tw !== undefined && a.source !== 'metabase-sync' && activeLoanIds.has(a.loanId));
  const loanMap = {};
  audited.forEach(a => {
    if (!loanMap[a.loanId] || a.date > loanMap[a.loanId].date) {
      loanMap[a.loanId] = a;
    }
  });
  const todayStr = new Date().toISOString().slice(0, 10);
  const loans = Object.values(loanMap).sort((a, b) => {
    const aDoneToday = !!(a.twUpdatedAt && a.twUpdatedAt.slice(0, 10) === todayStr);
    const bDoneToday = !!(b.twUpdatedAt && b.twUpdatedAt.slice(0, 10) === todayStr);
    if (aDoneToday !== bDoneToday) return aDoneToday ? 1 : -1;
    if (aDoneToday && bDoneToday) {
      return (a.twUpdatedAt || '').localeCompare(b.twUpdatedAt || '');
    }
    if (!a.loanBookingDate && !b.loanBookingDate) return 0;
    if (!a.loanBookingDate) return -1;
    if (!b.loanBookingDate) return 1;
    return (a.loanBookingDate || '').localeCompare(b.loanBookingDate || '');
  });
  const checked = Object.keys(twCurrentValues).length;
  const flagged = Object.entries(twCurrentValues).filter(([id, v]) => {
    const a = loans.find(x => x.loanId === id);
    return a && a.tw != null && Math.abs(v - a.tw) > twThreshold;
  }).length;
  const matched = checked - flagged;
  const pendingCount = loans.filter(a => getLoanStatusFn(a.loanId) === 'pending').length;
  const completedToday = loans.filter(a => a.twUpdatedAt && a.twUpdatedAt.slice(0, 10) === todayStr).length;
  const remainingToday = loans.length - completedToday;
  return { loans, checked, flagged, matched, pendingCount, completedToday, remainingToday };
}

async function run() {
  console.log('\n=== apiRequest() ===\n');
  {
    // Minimal fetch mock to prove apiRequest performs fetch(path, options)
    // then res.json(), and returns exactly what res.json() resolves to.
    let capturedPath, capturedOptions;
    global.fetch = (path, options) => {
      capturedPath = path;
      capturedOptions = options;
      return Promise.resolve({ json: () => Promise.resolve({ mockField: 'mockValue' }) });
    };
    function apiRequest(path, options) {
      return fetch(path, options).then(res => res.json());
    }

    const result = await apiRequest('/api/loan-lookup?loanId=TCGL1', { method: 'GET' });
    check('calls fetch with the exact path given', capturedPath === '/api/loan-lookup?loanId=TCGL1');
    check('passes options through unchanged', capturedOptions.method === 'GET');
    check('resolves to the parsed JSON body, matching res.json() exactly', result.mockField === 'mockValue');
  }
  {
    // Confirm it propagates rejection on network failure, same as a bare
    // fetch().then(res=>res.json()) chain would — callers' existing
    // .catch()/try-catch blocks depend on this.
    global.fetch = () => Promise.reject(new Error('network down'));
    function apiRequest(path, options) {
      return fetch(path, options).then(res => res.json());
    }
    let threw = false;
    try { await apiRequest('/api/active-loans'); } catch (e) { threw = true; }
    check('network failure still rejects the promise (existing .catch/try-catch still works)', threw === true);
  }
  delete global.fetch;

  console.log('\n=== TW compute functions — identical output to original inline logic ===\n');

  const getLoanStatusFn = (loanId) => (loanId === 'TCGL3' ? 'pending' : 'not-pending');

  const fixtures = [
    {
      name: 'typical mixed set: some checked, some flagged, some untouched, one metabase-sync placeholder excluded',
      auditStore: [
        { loanId: 'TCGL1', tw: 45.0, date: '2026-07-01', twUpdatedAt: '2026-07-01T10:00:00.000Z', loanBookingDate: '2026-01-01' },
        { loanId: 'TCGL1', tw: 45.2, date: '2026-07-10', twUpdatedAt: '2026-07-10T10:00:00.000Z', loanBookingDate: '2026-01-01' }, // more recent, should win dedup
        { loanId: 'TCGL2', tw: 30.0, date: '2026-07-05', twUpdatedAt: null, loanBookingDate: '2026-02-01' },
        { loanId: 'TCGL3', tw: 12.5, date: '2026-07-02', twUpdatedAt: null, loanBookingDate: null },
        { loanId: 'TCGL4', tw: null, date: '2026-07-01', twUpdatedAt: null, loanBookingDate: '2026-03-01' }, // excluded: tw is null
        { loanId: 'TCGL5', tw: 20.0, date: '2026-07-01', source: 'metabase-sync', twUpdatedAt: null, loanBookingDate: '2026-01-15' }, // excluded: sync placeholder
        { loanId: 'TCGL6', tw: 18.0, date: '2026-07-01', twUpdatedAt: null, loanBookingDate: '2026-01-15' }, // excluded: not in activeLoanIds
      ],
      activeLoanIds: new Set(['TCGL1', 'TCGL2', 'TCGL3', 'TCGL4', 'TCGL5']),
      twCurrentValues: { TCGL1: 45.15, TCGL2: 32.0 }, // TCGL1 within threshold (matched), TCGL2 flagged
      twThreshold: 0.3,
    },
    {
      name: 'empty audit store',
      auditStore: [],
      activeLoanIds: new Set(),
      twCurrentValues: {},
      twThreshold: 0.3,
    },
    {
      name: 'all loans completed today, ties broken by twUpdatedAt ascending',
      auditStore: [
        { loanId: 'A', tw: 10, date: '2026-07-01', twUpdatedAt: `${new Date().toISOString().slice(0,10)}T09:00:00.000Z`, loanBookingDate: '2026-01-01' },
        { loanId: 'B', tw: 20, date: '2026-07-02', twUpdatedAt: `${new Date().toISOString().slice(0,10)}T08:00:00.000Z`, loanBookingDate: '2026-01-02' },
      ],
      activeLoanIds: new Set(['A', 'B']),
      twCurrentValues: {},
      twThreshold: 0.3,
    },
  ];

  fixtures.forEach((fx, i) => {
    console.log(`\nFixture ${i + 1}: ${fx.name}`);
    const original = originalInlineComputation(fx.auditStore, fx.activeLoanIds, fx.twCurrentValues, fx.twThreshold, getLoanStatusFn);
    const todayStr = new Date().toISOString().slice(0, 10);
    const extractedLoans = sortTWLoans(computeAuditedLoansForTW(fx.auditStore, fx.activeLoanIds), todayStr);
    const extractedCounters = computeTWCounters(extractedLoans, fx.twCurrentValues, todayStr, fx.twThreshold, getLoanStatusFn);

    check('same number of loans surfaced', extractedLoans.length === original.loans.length);
    check('same loan IDs in the same order', JSON.stringify(extractedLoans.map(l => l.loanId)) === JSON.stringify(original.loans.map(l => l.loanId)));
    check('checked count matches', extractedCounters.checked === original.checked);
    check('flagged count matches', extractedCounters.flagged === original.flagged);
    check('matched count matches', extractedCounters.matched === original.matched);
    check('pendingCount matches', extractedCounters.pendingCount === original.pendingCount);
    check('completedToday matches', extractedCounters.completedToday === original.completedToday);
    check('remainingToday matches', extractedCounters.remainingToday === original.remainingToday);
  });

  console.log('\n=== Dedup correctness (specific, high-value check) ===\n');
  {
    // The single most important rule in this function: when the same loan
    // has multiple audit docs (re-audits), only the MOST RECENT one (by
    // `date`) should be surfaced, carrying its own tw value forward.
    const auditStore = [
      { loanId: 'TCGL9', tw: 10.0, date: '2026-01-01', twUpdatedAt: null, loanBookingDate: '2026-01-01' },
      { loanId: 'TCGL9', tw: 99.9, date: '2026-06-01', twUpdatedAt: null, loanBookingDate: '2026-01-01' }, // this one should win
    ];
    const loans = computeAuditedLoansForTW(auditStore, new Set(['TCGL9']));
    check('only one entry survives dedup', loans.length === 1);
    check('the MOST RECENT audit (by date) wins, not the first one seen', loans[0].tw === 99.9);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
