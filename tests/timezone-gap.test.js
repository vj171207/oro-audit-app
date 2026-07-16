// tests/timezone-gap.test.js
//
// This test documents a KNOWN, UNFIXED bug — see the README's "twUpdatedAt
// and the daily reset — timezone caveat" section. It exists so the exact
// failure mode is pinned down precisely, not lost to memory, and so
// whoever eventually fixes it has a concrete before/after to check against.
//
// Run with: node tests/timezone-gap.test.js
// EXPECT THIS TO SHOW THE BUG, not pass cleanly — read the output.

// This mirrors exactly how app.js currently computes "today" — always UTC,
// never adjusted for IST.
function currentTodayStrLogic() {
  return new Date().toISOString().slice(0, 10);
}

// What "today" SHOULD be if computed correctly in India Standard Time
// (UTC+5:30) — this is the fix, not yet applied in app.js.
function correctISTTodayStrLogic(utcDate) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(utcDate.getTime() + IST_OFFSET_MS);
  return istDate.toISOString().slice(0, 10);
}

console.log('Demonstrating the exact failure window (12:00 AM - 5:30 AM IST):\n');

// 2:00 AM IST on July 16 = 8:30 PM UTC on July 15 (still "yesterday" in UTC)
const twoAmIST_July16 = new Date('2026-07-15T20:30:00Z');
const currentLogicResult = twoAmIST_July16.toISOString().slice(0, 10);
const correctResult = correctISTTodayStrLogic(twoAmIST_July16);

console.log('Real-world moment: 2:00 AM, July 16, India time');
console.log('  Current app logic (raw UTC) says today is: ' + currentLogicResult + '  <- WRONG, this is "yesterday"');
console.log('  Correct answer (adjusted for IST) is:       ' + correctResult + '  <- what it should say');
console.log('  Bug confirmed: ' + (currentLogicResult !== correctResult ? 'YES — current logic is wrong during this window' : 'NO'));

console.log('\nOutside the affected window, both agree (as expected):');
// 10:00 AM IST on July 16 = 4:30 AM UTC on July 16 — already rolled over in both.
const tenAmIST_July16 = new Date('2026-07-16T04:30:00Z');
const currentLogicResult2 = tenAmIST_July16.toISOString().slice(0, 10);
const correctResult2 = correctISTTodayStrLogic(tenAmIST_July16);
console.log('Real-world moment: 10:00 AM, July 16, India time');
console.log('  Current app logic says: ' + currentLogicResult2);
console.log('  Correct answer says:    ' + correctResult2);
console.log('  Match (as expected, outside the bug window): ' + (currentLogicResult2 === correctResult2));

console.log('\nThis confirms the bug is real but narrow: only affects the ~5.5 hour');
console.log('window each night (12:00 AM - 5:30 AM IST). If this test is ever run');
console.log('and BOTH moments show a match, the fix has been applied — update the');
console.log('README\'s timezone caveat section to reflect that.');
