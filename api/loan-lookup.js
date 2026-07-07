// Vercel serverless function — api/loan-lookup.js
// Queries Tenmark Prod via Metabase API for a given loan ID

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const loanId = req.query.loanId;
  if (!loanId) {
    return res.status(400).json({ error: 'loanId is required' });
  }

  // Sanitise input
  const safeLoanId = loanId.replace(/[^A-Za-z0-9\-]/g, '');

  const METABASE_SESSION = process.env.METABASE_SESSION_TOKEN;
  if (!METABASE_SESSION) {
    return res.status(500).json({ error: 'Metabase session token not configured' });
  }

  const query = `
    SELECT DISTINCT ON (go_type.name, g.quantity)
      l.loan_number,
      l.disbursed_amount,
      l.loan_booking_date,
      b.name AS branch_name,
      c.name AS city_name,
      go_type.name AS ornament_type,
      g.quantity AS count,
      g.gross_weight,
      g.stone_deduction,
      g.actual_quality AS karat,
      g.net_weight
    FROM loan l
    JOIN gold g ON g.loan_id = l.id
    JOIN gold_ornament go_type ON go_type.id = g.gold_ornament_type_id
    JOIN branch b ON b.id = l.branch_id
    JOIN city c ON c.id = l.city_id
    // A loan can have TWO gold records per ornament: the original AP
    // (Appraisal Partner) valuation, and a later Maker valuation entered
    // when the gold is stored. The Maker record always has original_gold_id
    // set, pointing back to its AP counterpart; the AP record itself has
    // original_gold_id = NULL. Rijin wants AP valuation shown here, so we
    // explicitly exclude Maker records rather than relying on which one
    // happened to be entered most recently.
    WHERE l.loan_number = '${safeLoanId}'
    AND g.is_active = true
    AND g.is_deleted = false
    AND g.original_gold_id IS NULL
    ORDER BY go_type.name, g.quantity, g.id DESC;
  `;

  try {
    const response = await fetch(`${METABASE_URL}/api/dataset`, {
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

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      return res.status(500).json({ error: 'Metabase returned non-JSON: ' + rawText.slice(0, 200) });
    }

    if (data.error) {
      return res.status(500).json({ error: data.error });
    }

    const rows = data.data?.rows || [];
    if (!rows.length) {
      return res.status(404).json({ error: 'Loan not found' });
    }

    const first = rows[0];
    const result = {
      loanNumber: first[0],
      loanAmount: '₹' + Number(first[1]).toLocaleString('en-IN'),
      loanDate: first[2],
      branch: first[3],
      city: first[4],
      ornaments: rows.map(r => ({
        type: r[5],
        count: r[6],
        gw: r[7],
        stoneDed: r[8],
        karat: r[9],
        nw: r[10]
      }))
    };

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
