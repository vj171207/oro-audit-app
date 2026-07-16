# Tests

Plain Node scripts, no framework, no dependencies, no test runner. Each one is self-contained — copy-pasted logic from `app.js` where a function can't be directly imported (this codebase has no module system; everything in `app.js` runs as one plain browser script).

**Run any of them with:** `node tests/<filename>`

## What's here

- `ornament-matching.test.js` — the re-audit reference matching logic (`matchPreviousOrnament()`). The most complex, most failure-prone logic in the app — covers exact matches, ambiguous duplicates, renamed ornament types, and the "refuse to guess" cases. **Run this one first if you ever touch anything related to re-audits or ornament matching.**
- `escape-html.test.js` — confirms free-text fields (Remarks, Packet ID) display normal text unchanged while neutralizing anything that looks like HTML/script.
- `tare-weight-batching.test.js` — the Firestore batching and merge logic behind Tare Weight's performance fix. Confirms loans are never dropped or duplicated across batches.
- `timezone-gap.test.js` — **this one is different: it documents a known, unfixed bug**, not a passing check. It demonstrates the exact ~5.5 hour window each night where "today" gets calculated wrong. Read the README's main timezone section before touching this.

## Why these exist, specifically

Every one of these covers a piece of logic that was genuinely non-obvious to get right the first time — not routine code, the kind of thing where a future edit could easily reintroduce a bug that already cost real time to find and fix once. Keeping these means the next person touching this code has something concrete to check against, instead of relying on memory or re-discovering the same edge cases from scratch.

## What this is *not*

This isn't a comprehensive test suite, and there's no CI pipeline running these automatically on every change. If that's ever worth setting up, these four are a ready-made starting point — but for now, the expectation is: run the relevant one manually before and after touching related code, the same way they were used while building each fix in the first place.
