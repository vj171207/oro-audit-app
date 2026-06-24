// api/fetch-sheet.js
// Fetches the audit sheet server-side to avoid CORS issues

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { sheetId, sheetName } = req.query;
  if (!sheetId || !sheetName) {
    return res.status(400).json({ error: 'sheetId and sheetName are required' });
  }

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}&headers=2`;

  try {
    const response = await fetch(url);
    const text = await response.text();
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1) {
      return res.status(500).json({ error: 'Could not parse sheet response' });
    }
    const json = JSON.parse(text.substring(jsonStart, jsonEnd + 1));
    return res.status(200).json(json);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
