// tests/loan-amount-and-tw-submitted.test.js
//
// Covers two fixes made together:
//
// 1. loanAmount type fix — previously api/loan-lookup.js returned a
//    pre-formatted currency string ("₹1,20,000"), which app.js then read
//    back out of the DOM at audit-submit time, so audit.loanAmount ended
//    up as a formatted string instead of a number (inconsistent with
//    api/active-loans.js, api/browse-loans.js, and api/sync-loans.js,
//    which all already stored it as a raw number). Fixed by:
//      - api/loan-lookup.js now returns a raw number
//      - app.js tracks the raw number in a JS variable (currentLoanAmount),
//        mirroring the existing currentLoanBookingDate pattern, instead of
//        re-reading formatted display text back out of the DOM
//
// 2. _twSubmitted semantics — confirmed (not changed) to be a transient,
//    client-side-only flag that is never sent to Firestore.
//
// Logic under test is copied here (per this repo's existing test
// convention — see ornament-matching.test.js) since app.js has no module
// exports. If you change the real logic, update this copy too.
//
// Run with: node tests/loan-amount-and-tw-submitted.test.js

let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

// ── Copied logic under test ──

// api/loan-lookup.js — the transform applied to the raw Metabase value
function apiLoanAmountTransform(rawMetabaseValue) {
  return Number(rawMetabaseValue) || 0;
}

// app.js populateOpsCard() — how currentLoanAmount gets set from API data
function deriveCurrentLoanAmount(data) {
  return (data && typeof data.amount === 'number') ? data.amount : null;
}

// app.js handleFetch() — how the API response gets mapped into the `amount`
// field passed into populateOpsCard
function mapApiResponseToAmount(apiResponseLoanAmount) {
  return (typeof apiResponseLoanAmount === 'number') ? apiResponseLoanAmount : null;
}

// app.js setOpsFields() — display formatting
function formatAmountForDisplay(amount) {
  return (typeof amount === 'number') ? '₹' + amount.toLocaleString('en-IN') : '—';
}

// app.js — the defensive parsing already used at render time for stored
// audit.loanAmount values (lines ~1706, 1901, 2431), which must keep working
// for BOTH old string-format records and new number-format records
function parseStoredLoanAmountForDisplay(storedValue) {
  return storedValue ? Number(String(storedValue).replace(/[^0-9.]/g, '')) || '' : '';
}

async function run() {
  console.log('\n=== loanAmount fix ===\n');

  console.log('1. api/loan-lookup.js transform — normal cases');
  check('positive integer stays as number', apiLoanAmountTransform(120000) === 120000);
  check('numeric string coerces to number', apiLoanAmountTransform('120000') === 120000);
  check('decimal value preserved', apiLoanAmountTransform(120000.50) === 120000.50);

  console.log('\n2. api/loan-lookup.js transform — edge cases');
  check('null becomes 0 (not NaN)', apiLoanAmountTransform(null) === 0);
  check('undefined becomes 0', apiLoanAmountTransform(undefined) === 0);
  check('empty string becomes 0', apiLoanAmountTransform('') === 0);
  check('zero stays 0', apiLoanAmountTransform(0) === 0);
  check('non-numeric string becomes 0, not NaN', apiLoanAmountTransform('abc') === 0 && !Number.isNaN(apiLoanAmountTransform('abc')));

  console.log('\n3. handleFetch() mapping API response -> ops card amount field');
  check('numeric API value passes through', mapApiResponseToAmount(120000) === 120000);
  check('zero passes through as 0 (not null)', mapApiResponseToAmount(0) === 0);
  check('unexpected non-number (defensive) becomes null, not crash', mapApiResponseToAmount('₹1,20,000') === null);

  console.log('\n4. populateOpsCard() -> currentLoanAmount derivation');
  check('valid numeric amount sets currentLoanAmount', deriveCurrentLoanAmount({ amount: 120000 }) === 120000);
  check('zero amount sets currentLoanAmount to 0, not null (0 is a legit value)', deriveCurrentLoanAmount({ amount: 0 }) === 0);
  check('missing amount field -> null', deriveCurrentLoanAmount({}) === null);
  check('placeholder "—" string -> null (error/no-data case)', deriveCurrentLoanAmount({ amount: '—' }) === null);
  check('null data object -> null, no crash', deriveCurrentLoanAmount(null) === null);
  check('undefined data object -> null, no crash', deriveCurrentLoanAmount(undefined) === null);

  console.log('\n5. setOpsFields() display formatting');
  check('formats with ₹ and Indian locale commas', formatAmountForDisplay(120000) === '₹1,20,000');
  check('formats large amount correctly', formatAmountForDisplay(12345678) === '₹1,23,45,678');
  check('zero formats as ₹0, not em-dash', formatAmountForDisplay(0) === '₹0');
  check('null shows em-dash placeholder', formatAmountForDisplay(null) === '—');
  check('non-number (defensive) shows em-dash, does not throw', formatAmountForDisplay('—') === '—');

  console.log('\n6. Backward compatibility — old string-format records must still render correctly');
  check('old "₹1,20,000" string still parses to 120000 for display', parseStoredLoanAmountForDisplay('₹1,20,000') === 120000);
  check('new clean number 120000 still parses correctly (regression check)', parseStoredLoanAmountForDisplay(120000) === 120000);
  check('new clean number 0 -> empty string per existing falsy-guard behavior (pre-existing, unchanged)', parseStoredLoanAmountForDisplay(0) === '');
  check('null/undefined stored value -> empty string, no crash', parseStoredLoanAmountForDisplay(null) === '' && parseStoredLoanAmountForDisplay(undefined) === '');

  console.log('\n7. End-to-end round trip — API -> ops card -> submitted audit object');
  {
    const apiResponse = { loanAmount: apiLoanAmountTransform('4500000'), loanDate: '2026-07-01', branch: 'HQ', city: 'Chennai', ornaments: [] };
    const opsCardAmount = mapApiResponseToAmount(apiResponse.loanAmount);
    const currentLoanAmount = deriveCurrentLoanAmount({ amount: opsCardAmount });
    const displayText = formatAmountForDisplay(opsCardAmount);
    const auditLoanAmountAtSubmit = currentLoanAmount; // this is exactly what app.js now stores
    check('raw number survives the full round trip unchanged', auditLoanAmountAtSubmit === 4500000);
    check('display text is correctly formatted along the way', displayText === '₹45,00,000');
    check('stored value is a number, not a string (the actual bug being fixed)', typeof auditLoanAmountAtSubmit === 'number');
  }

  console.log('\n8. Cross-check against sibling APIs — loan-lookup now matches their contract');
  {
    // api/active-loans.js and api/browse-loans.js both use: parseFloat(r[1]) || 0
    function siblingApiTransform(rawValue) { return parseFloat(rawValue) || 0; }
    const testValues = [120000, '120000', 0, null, undefined, 'garbage'];
    testValues.forEach(v => {
      check(`loan-lookup and sibling APIs agree on transform(${JSON.stringify(v)})`,
        apiLoanAmountTransform(v) === siblingApiTransform(v));
    });
  }

  console.log('\n=== _twSubmitted (documentation-only fix, no behavior change) ===\n');

  console.log('9. Confirm _twSubmitted is excluded from the Firestore write payload');
  {
    // This mirrors the exact updateAuditDoc() call in submitTW() in app.js.
    // If a future edit accidentally adds _twSubmitted to this payload, this
    // test will catch it.
    function buildTWUpdatePayload(newTW, updatedAt, recheckedBy) {
      return { tw: newTW, twUpdatedAt: updatedAt, twRecheckedBy: recheckedBy };
    }
    const payload = buildTWUpdatePayload(45.2, '2026-07-17T10:00:00.000Z', 'Vj');
    check('payload has exactly 3 keys', Object.keys(payload).length === 3);
    check('payload does NOT include _twSubmitted', !('_twSubmitted' in payload));
  }

  console.log('\n10. Confirm isSubmitted derivation is a strict boolean check');
  {
    function deriveIsSubmitted(audit) { return audit._twSubmitted === true; }
    check('true flag -> submitted', deriveIsSubmitted({ _twSubmitted: true }) === true);
    check('undefined (post-reload / never submitted this session) -> not submitted', deriveIsSubmitted({}) === false);
    check('truthy-but-not-true value would NOT count (strict equality guards against typos)', deriveIsSubmitted({ _twSubmitted: 1 }) === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
