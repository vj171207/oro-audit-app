// Vercel serverless function — api/tw-gross-weight.js
//
// Returns total gross weight per loan, for the Tare Weight report's GW-vs-TW
// tally column. Built to scale from a handful of loans up to 10,000+ without
// changing behavior:
//
//   - Accepts a POST body with a `loanIds` array (not a query string — a GET
//     with 10,000 loan IDs in the URL would break long before that).
//   - Splits the list into fixed-size batches (BATCH_SIZE) so no single
//     Metabase query ever has an oversized IN clause, regardless of how many
//     loans are requested.
//   - The SUM happens in SQL, not in JS after fetching every ornament row —
//     the response is one number per loan, not one row per ornament. This
//     keeps the payload small and stays cheap even at 10,000 loans (each of
//     which might have 2-3 ornament rows in `gold`).
//   - IMPORTANT: gross_weight is the total weight recorded for that ornament
//     line on the pledge card ("PC" = Pledge Card, not "per piece") — it is
//     NOT a per-piece figure. It must be summed as-is, never multiplied by
//     quantity, or the total gets double-counted for any line with quantity
//     greater than 1.
//   - Uses the same is_active/is_deleted/original_gold_id filter as the fixed
//     loan-lookup.js query, so it benefits from the ornament-clubbing fix —
//     no risk of silently under-counting duplicate-type-same-quantity items.
//
// Failure is explicit: if a batch fails, that batch's loans are reported in
// `failed`, not silently given a wrong or zero weight.

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;
const BATCH_SIZE = 500;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const loanIds = Array.isArray(req.body?.loanIds) ? req.body.loanIds : null;
  if (!loanIds || !loanIds.length) {
    return res.status(400).json({ error: 'loanIds array is required in the request body' });
  }

  // Same sanitisation as loan-lookup.js — strip anything that isn't
  // alphanumeric or a dash before it goes anywhere near the SQL string.
  const safeIds = [...new Set(loanIds.map(id => String(id).replace(/[^A-Za-z0-9\-]/g, '')))].filter(Boolean);

  const METABASE_SESSION = process.env.METABASE_SESSION_TOKEN;
  const gwByLoanId = {};
  const failedBatches = [];

  for (let i = 0; i < safeIds.length; i += BATCH_SIZE) {
    const batch = safeIds.slice(i, i + BATCH_SIZE);
    const inClause = batch.map(id => `'${id}'`).join(',');

    const query = `
      SELECT l.loan_number, SUM(g.gross_weight) AS total_gw
      FROM loan l
      JOIN gold g ON g.loan_id = l.id
      WHERE l.loan_number IN (${inClause})
      AND g.is_active = true
      AND g.is_deleted = false
      AND g.original_gold_id IS NULL
      GROUP BY l.loan_number;
    `;

    try {
      const mbRes = await fetch(`${METABASE_URL}/api/dataset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Metabase-Session': METABASE_SESSION,
          'Cookie': `metabase.SESSION=${METABASE_SESSION}`
        },
        body: JSON.stringify({
          database: METABASE_DB_ID,
          type: 'native',
          native: { query }
        })
      });

      const data = await mbRes.json();
      if (data.error) throw new Error(data.error);

      (data.data?.rows || []).forEach(row => {
        gwByLoanId[row[0]] = row[1];
      });
    } catch (err) {
      failedBatches.push({ batchStart: i, batchSize: batch.length, error: err.message });
    }
  }

  return res.status(200).json({
    gwByLoanId,
    requested: safeIds.length,
    matched: Object.keys(gwByLoanId).length,
    failedBatches: failedBatches.length ? failedBatches : undefined
  });
}
