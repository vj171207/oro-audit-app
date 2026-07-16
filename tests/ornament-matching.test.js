// tests/ornament-matching.test.js
//
// Tests the re-audit reference matching logic — see the README's
// "The re-audit reference system" section for why this exists and what
// each fallback level is for. This is the single trickiest piece of logic
// in the app; if you ever touch matchPreviousOrnament() in app.js, run this
// first and after.
//
// Run with: node tests/ornament-matching.test.js
// No framework, no dependencies — just plain assertions that print PASS/FAIL.

function closeEnoughWeight(a, b) {
  const x = parseFloat(a), y = parseFloat(b);
  return !isNaN(x) && !isNaN(y) && Math.abs(x - y) < 0.001;
}

// This must stay in sync with matchPreviousOrnament() in app.js — copied
// here rather than imported since app.js has no module exports (plain
// browser script). If you change the real function, update this copy too.
function matchPreviousOrnament(currentOrnament, previousOrnaments) {
  if (!previousOrnaments || !previousOrnaments.length) return { mode: 'none' };

  if (currentOrnament.goldId != null) {
    const exact = previousOrnaments.find(p => p.goldId != null && String(p.goldId) === String(currentOrnament.goldId));
    if (exact) return { mode: 'exact', matched: exact };
  }

  const sameType = previousOrnaments.filter(p => p.type === currentOrnament.type);
  if (sameType.length === 1) return { mode: 'unambiguous', matched: sameType[0] };
  if (sameType.length > 1) return { mode: 'ambiguous', candidates: sameType };

  const weightMatches = previousOrnaments.filter(p => closeEnoughWeight(p.gwPC, currentOrnament.gw));
  if (weightMatches.length === 1) return { mode: 'renamed', matched: weightMatches[0] };
  if (weightMatches.length > 1) return { mode: 'ambiguous', candidates: weightMatches };

  return { mode: 'none' };
}

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + label);
  if (!ok) {
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual:  ', JSON.stringify(actual));
    failed++;
  } else {
    passed++;
  }
}

// 1. Real case: TCGL31136183's "Studs" — old record says "Stud", no goldId,
// but weight uniquely matches. Confirmed against real production data.
check(
  'Renamed type (Stud -> Studs), resolved by weight',
  matchPreviousOrnament({ type: 'Studs', gw: 1.19, goldId: 295 }, [{ type: 'Stud', gwPC: '1.19' }]),
  { mode: 'renamed', matched: { type: 'Stud', gwPC: '1.19' } }
);

// 2. Real case: TCGL30986860's two Lockets — genuinely ambiguous, must
// never be guessed even though goldId is present on the CURRENT side.
check(
  'Duplicate type, no goldId on old records -> ambiguous, not guessed',
  matchPreviousOrnament({ type: 'Lockets', goldId: 252 }, [
    { type: 'Lockets', gwPC: '1.49' },
    { type: 'Lockets', gwPC: '4.94' }
  ]),
  { mode: 'ambiguous', candidates: [{ type: 'Lockets', gwPC: '1.49' }, { type: 'Lockets', gwPC: '4.94' }] }
);

// 3. Post-backfill case: goldId present on both sides -> exact, regardless
// of how many other same-type ornaments exist.
check(
  'Exact goldId match resolves duplicates with total confidence',
  matchPreviousOrnament({ type: 'Lockets', goldId: 253 }, [
    { type: 'Lockets', goldId: 252 },
    { type: 'Lockets', goldId: 253 }
  ]),
  { mode: 'exact', matched: { type: 'Lockets', goldId: 253 } }
);

// 4. Simple case: only one of a type, no goldId needed to be confident.
check(
  'Single ornament of a type is unambiguous even without goldId',
  matchPreviousOrnament({ type: 'Finger Ring', goldId: 251 }, [{ type: 'Finger Ring', gwPC: '0.80' }]),
  { mode: 'unambiguous', matched: { type: 'Finger Ring', gwPC: '0.80' } }
);

// 5. Genuinely nothing to reference — first-ever audit of this ornament type.
check(
  'No prior data and no weight match -> none',
  matchPreviousOrnament({ type: 'Chain', gw: 99.9, goldId: 1 }, [{ type: 'Finger Ring', gwPC: '0.8' }]),
  { mode: 'none' }
);

// 6. Edge case: even the weight-fallback must refuse to guess if it's ALSO
// ambiguous (two different old items coincidentally sharing a weight).
check(
  'Weight-based fallback still refuses to guess on a collision',
  matchPreviousOrnament({ type: 'Studs', gw: 2.0 }, [
    { type: 'Stud', gwPC: '2.0' },
    { type: 'OtherThing', gwPC: '2.0' }
  ]),
  { mode: 'ambiguous', candidates: [{ type: 'Stud', gwPC: '2.0' }, { type: 'OtherThing', gwPC: '2.0' }] }
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
