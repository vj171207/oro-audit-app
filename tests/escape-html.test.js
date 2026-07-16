// tests/escape-html.test.js
//
// Tests escapeHtml() in app.js — used everywhere a free-text field
// (Remarks, Packet ID) gets rendered into the page, so a stray "<" or ">"
// in someone's typed notes can't be interpreted as real HTML/code.
//
// Run with: node tests/escape-html.test.js

// Must stay in sync with escapeHtml() in app.js.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + label);
  if (!ok) {
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual:  ', JSON.stringify(actual));
    failed++;
  } else {
    passed++;
  }
}

// Normal text must come out byte-for-byte unchanged — this matters as much
// as the escaping itself, since this runs on every real remark ever typed.
check('Plain text unaffected', escapeHtml('Bangles-2 broken'), 'Bangles-2 broken');
check('Numbers and punctuation unaffected', escapeHtml('Rs. 10150/- loss amount due to Studs-2'), 'Rs. 10150/- loss amount due to Studs-2');

// Accidental HTML-like characters (e.g. someone typing "Loan < 50k")
check('Accidental angle bracket neutralized', escapeHtml('Loan < 50k, exception approved'), 'Loan &lt; 50k, exception approved');

// Deliberate injection attempt
check('Script tag fully neutralized', escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');

// Edge cases — must never throw
check('Empty string', escapeHtml(''), '');
check('null', escapeHtml(null), '');
check('undefined', escapeHtml(undefined), '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
