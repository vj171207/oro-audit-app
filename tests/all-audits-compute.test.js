// tests/all-audits-compute.test.js
//
// Proves computeDedupedAudits / computeAllAuditsSummaryCounts /
// filterAllAudits — extracted out of renderAllAudits() — produce IDENTICAL
// output to the original inline logic, using realistic audit fixtures.
// Mirrors the same proof structure used in tw-counters-and-apirequest.test.js
// for the equivalent Tare Weight extraction.
//
// Logic under test is copied here per this repo's existing test convention.
// If you change the real logic, update this copy too.
//
// Run with: node tests/all-audits-compute.test.js

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// ── Copied extracted logic under test ──

function computeDedupedAudits(auditStore) {
  const loanMapAll = {};
  auditStore.forEach(a => {
    if (a.source === 'metabase-sync') return;
    if (!loanMapAll[a.loanId] || (a.date || '') > (loanMapAll[a.loanId].date || '')) {
      loanMapAll[a.loanId] = a;
    }
  });
  return Object.values(loanMapAll);
}

function computeAllAuditsSummaryCounts(deduped, activeLoanIds) {
  const total = deduped.length;
  const excess = deduped.filter(a => a.excessFunding === 'Yes' && activeLoanIds.has(a.loanId)).length;
  const spurious = deduped.filter(a => a.spurious === 'Yes' && activeLoanIds.has(a.loanId)).length;
  const clean = deduped.filter(a => a.excessFunding === 'No' && a.spurious === 'No').length;
  const activeAudited = deduped.filter(a => activeLoanIds.has(a.loanId)).length;
  return { total, excess, spurious, clean, activeAudited };
}

function hasDeviation(audit, type) {
  switch (type) {
    case 'excess':  return audit.excessFunding === 'Yes';
    case 'spurious': return audit.spurious === 'Yes';
    case 'any':     return audit.excessFunding === 'Yes' || audit.spurious === 'Yes';
    case 'none':    return audit.excessFunding !== 'Yes' && audit.spurious !== 'Yes';
    default:        return true;
  }
}

function filterAllAudits(deduped, filters, activeLoanIds) {
  return deduped.filter(a => {
    if (filters.loanIdFilter && !a.loanId.toLowerCase().includes(filters.loanIdFilter)) return false;
    if (filters.branchFilter && a.branch !== filters.branchFilter) return false;
    if (filters.auditorFilter && a.auditor !== filters.auditorFilter) return false;
    if (filters.deviationFilter && !hasDeviation(a, filters.deviationFilter)) return false;
    if (filters.loanStatusFilter === 'active' && !activeLoanIds.has(a.loanId)) return false;
    if (filters.loanStatusFilter === 'inactive' && activeLoanIds.has(a.loanId)) return false;
    if (filters.dateFrom && a.date < filters.dateFrom) return false;
    if (filters.dateTo && a.date > filters.dateTo) return false;
    return true;
  });
}

// ── ORIGINAL inline logic, reproduced verbatim, to diff against the
// extracted version above using identical fixtures ──
function originalInlineComputation(auditStore, activeLoanIds, filterInputs) {
  const loanMapAll = {};
  auditStore.forEach(a => {
    if (a.source === 'metabase-sync') return;
    if (!loanMapAll[a.loanId] || (a.date || '') > (loanMapAll[a.loanId].date || '')) {
      loanMapAll[a.loanId] = a;
    }
  });
  const deduped = Object.values(loanMapAll);
  const total = deduped.length;
  const excess = deduped.filter(a => a.excessFunding === 'Yes' && activeLoanIds.has(a.loanId)).length;
  const spurious = deduped.filter(a => a.spurious === 'Yes' && activeLoanIds.has(a.loanId)).length;
  const clean = deduped.filter(a => a.excessFunding === 'No' && a.spurious === 'No').length;
  const activeAudited = deduped.filter(a => activeLoanIds.has(a.loanId)).length;

  const { loanIdFilter, branchFilter, auditorFilter, deviationFilter, loanStatusFilter, dateFrom, dateTo } = filterInputs;
  const filtered = deduped.filter(a => {
    if (loanIdFilter && !a.loanId.toLowerCase().includes(loanIdFilter)) return false;
    if (branchFilter && a.branch !== branchFilter) return false;
    if (auditorFilter && a.auditor !== auditorFilter) return false;
    if (deviationFilter && !hasDeviation(a, deviationFilter)) return false;
    if (loanStatusFilter === 'active' && !activeLoanIds.has(a.loanId)) return false;
    if (loanStatusFilter === 'inactive' && activeLoanIds.has(a.loanId)) return false;
    if (dateFrom && a.date < dateFrom) return false;
    if (dateTo && a.date > dateTo) return false;
    return true;
  });

  return { deduped, total, excess, spurious, clean, activeAudited, filtered };
}

async function run() {
  console.log('\n=== computeDedupedAudits / computeAllAuditsSummaryCounts / filterAllAudits — identical to original ===\n');

  const fixtures = [
    {
      name: 'typical mixed set: excess, spurious, clean, one metabase-sync placeholder excluded, one re-audited loan',
      auditStore: [
        { loanId: 'TCGL1', date: '2026-07-01', excessFunding: 'Yes', excessAmount: 5000, spurious: 'No', branch: 'HQ', auditor: 'Vj' },
        { loanId: 'TCGL1', date: '2026-07-10', excessFunding: 'No', excessAmount: 0, spurious: 'No', branch: 'HQ', auditor: 'Vj' }, // more recent, should win dedup
        { loanId: 'TCGL2', date: '2026-07-05', excessFunding: 'No', spurious: 'Yes', branch: 'Branch2', auditor: 'Rijin' },
        { loanId: 'TCGL3', date: '2026-07-02', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
        { loanId: 'TCGL4', date: '2026-07-01', source: 'metabase-sync', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: '—' }, // excluded
      ],
      activeLoanIds: new Set(['TCGL1', 'TCGL2', 'TCGL3']),
      filters: { loanIdFilter: '', branchFilter: '', auditorFilter: '', deviationFilter: '', loanStatusFilter: '', dateFrom: '', dateTo: '' },
    },
    {
      name: 'empty audit store',
      auditStore: [],
      activeLoanIds: new Set(),
      filters: { loanIdFilter: '', branchFilter: '', auditorFilter: '', deviationFilter: '', loanStatusFilter: '', dateFrom: '', dateTo: '' },
    },
    {
      name: 'branch + date range + deviation filters combined',
      auditStore: [
        { loanId: 'TCGL10', date: '2026-06-01', excessFunding: 'Yes', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
        { loanId: 'TCGL11', date: '2026-06-15', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
        { loanId: 'TCGL12', date: '2026-07-01', excessFunding: 'Yes', spurious: 'No', branch: 'Branch2', auditor: 'Rijin' },
      ],
      activeLoanIds: new Set(['TCGL10', 'TCGL11', 'TCGL12']),
      filters: { loanIdFilter: '', branchFilter: 'HQ', auditorFilter: '', deviationFilter: 'excess', loanStatusFilter: '', dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    },
    {
      name: 'loan status filter — active only',
      auditStore: [
        { loanId: 'TCGL20', date: '2026-07-01', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
        { loanId: 'TCGL21', date: '2026-07-01', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
      ],
      activeLoanIds: new Set(['TCGL20']), // TCGL21 is inactive
      filters: { loanIdFilter: '', branchFilter: '', auditorFilter: '', deviationFilter: '', loanStatusFilter: 'active', dateFrom: '', dateTo: '' },
    },
    {
      name: 'loan ID text search',
      auditStore: [
        { loanId: 'TCGL31241368', date: '2026-07-01', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
        { loanId: 'TCGL31290410', date: '2026-07-01', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
        { loanId: 'TCGL99999999', date: '2026-07-01', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' },
      ],
      activeLoanIds: new Set(['TCGL31241368', 'TCGL31290410', 'TCGL99999999']),
      filters: { loanIdFilter: '3124', branchFilter: '', auditorFilter: '', deviationFilter: '', loanStatusFilter: '', dateFrom: '', dateTo: '' },
    },
  ];

  fixtures.forEach((fx, i) => {
    console.log(`\nFixture ${i + 1}: ${fx.name}`);
    const original = originalInlineComputation(fx.auditStore, fx.activeLoanIds, fx.filters);
    const extractedDeduped = computeDedupedAudits(fx.auditStore);
    const extractedCounts = computeAllAuditsSummaryCounts(extractedDeduped, fx.activeLoanIds);
    const extractedFiltered = filterAllAudits(extractedDeduped, fx.filters, fx.activeLoanIds);

    check('same deduped count', extractedDeduped.length === original.deduped.length);
    check('same loan IDs surfaced after dedup, same order', JSON.stringify(extractedDeduped.map(a => a.loanId)) === JSON.stringify(original.deduped.map(a => a.loanId)));
    check('total matches', extractedCounts.total === original.total);
    check('excess matches', extractedCounts.excess === original.excess);
    check('spurious matches', extractedCounts.spurious === original.spurious);
    check('clean matches', extractedCounts.clean === original.clean);
    check('activeAudited matches', extractedCounts.activeAudited === original.activeAudited);
    check('filtered result count matches', extractedFiltered.length === original.filtered.length);
    check('filtered loan IDs match exactly, same order', JSON.stringify(extractedFiltered.map(a => a.loanId)) === JSON.stringify(original.filtered.map(a => a.loanId)));
  });

  console.log('\n=== Dedup correctness (specific, high-value check) ===\n');
  {
    // The most important rule: when a loan has multiple audit docs
    // (re-audits), only the MOST RECENT one should be surfaced — and its
    // excessFunding/spurious values (which may have changed on re-audit)
    // must be the ones that count toward the summary numbers.
    const auditStore = [
      { loanId: 'TCGL50', date: '2026-01-01', excessFunding: 'Yes', spurious: 'Yes', branch: 'HQ', auditor: 'Vj' },
      { loanId: 'TCGL50', date: '2026-06-01', excessFunding: 'No', spurious: 'No', branch: 'HQ', auditor: 'Vj' }, // corrected on re-audit, should win
    ];
    const deduped = computeDedupedAudits(auditStore);
    const counts = computeAllAuditsSummaryCounts(deduped, new Set(['TCGL50']));
    check('only one entry survives dedup', deduped.length === 1);
    check('the MOST RECENT audit wins (excessFunding corrected to No)', deduped[0].excessFunding === 'No');
    check('summary counts reflect the corrected re-audit, not the stale first pass', counts.excess === 0 && counts.clean === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
