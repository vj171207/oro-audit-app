// api/browse-loans.js
// Returns all loans disbursed within a date range from Tenmark Prod

const METABASE_URL = 'https://oro.metabaseapp.com';
const METABASE_DB_ID = 103;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to dates are required' });
  }

  const METABASE_SESSION = process.env.METABASE_SESSION_TOKEN;
  if (!METABASE_SESSION) {
    return res.status(500).json({ error: 'Metabase session token not configured' });
  }

  const query = `
    SELECT
      l.loan_number,
      l.disbursed_amount,
      l.loan_booking_date::date AS loan_date,
      b.name AS branch_name,
      c.name AS city_name
    FROM loan l
    JOIN branch b ON b.id = l.branch_id
    JOIN city c ON c.id = l.city_id
    JOIN gold g ON g.loan_id = l.id
    WHERE g.is_active = true
    AND g.is_deleted = false
    AND l.loan_number IS NOT NULL
    AND l.status IN ('GOLD_STORED', 'LOAN_AMOUNT_TRANSFERRED')
    AND l.loan_booking_date::date BETWEEN '${from}' AND '${to}'
    GROUP BY l.loan_number, l.disbursed_amount, l.loan_booking_date, b.name, c.name
    ORDER BY l.loan_booking_date DESC;
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
    } catch (e) {
      return res.status(500).json({ error: 'Metabase returned non-JSON: ' + rawText.slice(0, 200) });
    }

    if (data.error) {
      return res.status(500).json({ error: data.error });
    }

    const rows = data.data?.rows || [];
    const loans = rows.map(r => ({
      loanNumber: String(r[0]),
      loanAmount: parseFloat(r[1]) || 0,
      loanDate: r[2] ? String(r[2]).split('T')[0] : '—',
      branch: r[3] || '—',
      city: r[4] || '—'
    }));

    return res.status(200).json({ loans });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
