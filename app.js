// ─────────────────────────────────────────────────────
// ORO AUDIT APP — app.js
//
// All data fetching and storage are stubbed.
// Replace the two marked sections when integrating:
//   1. fetchOpsData()  → Google Sheets API call
//   2. auditStore      → Firebase Firestore reads/writes
// ─────────────────────────────────────────────────────

// ── Audit store (replace with Firestore in production) ──
let auditStore = [];

// ── Demo loan (for presentation only — not real customer data) ──
const DEMO_LOAN_ID = 'DEMO-0000001';
const DEMO_OPS_DATA = {
  date: '2026-06-22',
  city: 'Hyderabad',
  branch: 'Demo Branch',
  agent: 'Demo Agent',
  maker: 'Demo Maker',
  packet: 'PKT-DEMO-001',
  amount: '₹1,20,000',
  ornaments: [
    { type: 'Necklace', count: 1, gw: '24.50', stoneDed: '1.20', karat: 22, nw: '23.30', hallmark: 'Yes' },
    { type: 'Finger Ring', count: 2, gw: '6.80', stoneDed: '0.20', karat: 22, nw: '6.60', hallmark: 'No' },
  ]
};

// ── State ──
let currentLoanId = null;
let twFilter = 'all';

// ────────────────────────────
// NAVIGATION
// ────────────────────────────
function switchSection(id, btn) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  if (id === 'tear-weight') renderTWTable();
  if (id === 'all-audits') renderAllAudits();
}

// ────────────────────────────
// NEW AUDIT — LOAN LOOKUP
// ────────────────────────────
document.getElementById('loan-id-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleFetch();
});

function handleFetch() {
  const id = document.getElementById('loan-id-input').value.trim().toUpperCase();
  const hint = document.getElementById('lookup-hint');

  if (!id) {
    hint.textContent = 'Please enter a loan ID.';
    hint.className = 'field-hint error';
    return;
  }

  hint.textContent = 'Loading ops data...';
  hint.className = 'field-hint';

  // Demo loan for presentation only
  if (id === DEMO_LOAN_ID) { populateOpsCard(id, DEMO_OPS_DATA); return; }

  // ── REPLACE THIS BLOCK WITH GOOGLE SHEETS API CALL ──
  // fetchOpsData(id).then(data => populateOpsCard(id, data)).catch(...)
  populateOpsCard(id, null);
}

function populateOpsCard(loanId, data) {
  currentLoanId = loanId;
  document.getElementById('ops-loan-id').textContent = loanId;

  const hint = document.getElementById('lookup-hint');
  if (!data) {
    // No live data yet — show empty ops card with placeholder message
    hint.textContent = 'Ops data will populate here once the Google Sheets API is connected.';
    hint.className = 'field-hint';
    setOpsFields({ date: '—', city: '—', branch: '—', agent: '—', maker: '—', packet: '—', amount: '—' });
    document.getElementById('ornament-tbody').innerHTML =
      '<tr class="empty-row"><td colspan="7">Ornament data will appear here once the database is connected.</td></tr>';
  } else {
    hint.textContent = '';
    setOpsFields(data);
    renderOrnamentTable(data.ornaments || []);
  }

  showAuditCards();
  setStep(2);
}

function setOpsFields(d) {
  document.getElementById('f-date').textContent = d.date || '—';
  document.getElementById('f-city').textContent = d.city || '—';
  document.getElementById('f-branch').textContent = d.branch || '—';
  document.getElementById('f-agent').textContent = d.agent || '—';
  document.getElementById('f-maker').textContent = d.maker || '—';
  document.getElementById('f-packet').textContent = d.packet || '—';
  document.getElementById('f-amount').textContent = d.amount || '—';
}

function renderOrnamentTable(ornaments) {
  const tbody = document.getElementById('ornament-tbody');
  if (!ornaments.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No ornament data returned.</td></tr>';
    return;
  }
  tbody.innerHTML = ornaments.map(o => `
    <tr>
      <td>${o.type}</td>
      <td>${o.count}</td>
      <td>${o.gw}</td>
      <td>${o.stoneDed}</td>
      <td>${o.karat} kt</td>
      <td><strong>${o.nw}</strong></td>
      <td>${o.hallmark || '—'}</td>
    </tr>
  `).join('');
}

function showAuditCards() {
  document.getElementById('card-ops').classList.remove('hidden');
  document.getElementById('card-audit').classList.remove('hidden');
  document.getElementById('card-tw').classList.remove('hidden');
  document.getElementById('submit-row').classList.remove('hidden');
  document.getElementById('success-bar').classList.add('hidden');
}

function hideAuditCards() {
  document.getElementById('card-ops').classList.add('hidden');
  document.getElementById('card-audit').classList.add('hidden');
  document.getElementById('card-tw').classList.add('hidden');
  document.getElementById('submit-row').classList.add('hidden');
}

// ────────────────────────────
// EXCESS FUNDING TOGGLE
// ────────────────────────────
function toggleExcessAmount() {
  const val = document.getElementById('excess-select').value;
  const grp = document.getElementById('excess-amount-group');
  grp.style.display = val === 'Yes' ? 'flex' : 'none';
}

// ────────────────────────────
// STEP INDICATOR
// ────────────────────────────
function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById('step-' + i);
    el.className = 'step';
    if (i < n) el.classList.add('done');
    else if (i === n) el.classList.add('active');
  }
}

// ────────────────────────────
// SUBMIT
// ────────────────────────────
function handleSubmit() {
  const tw = parseFloat(document.getElementById('tw-input').value);
  if (!currentLoanId) { alert('No loan loaded.'); return; }
  if (isNaN(tw) || tw <= 0) { alert('Please enter a valid tear weight before submitting.'); return; }

  const audit = {
    loanId: currentLoanId,
    date: new Date().toISOString().split('T')[0],
    auditor: document.getElementById('auditor-name-display').textContent || 'Auditor',
    tw,
    excessFunding: document.getElementById('excess-select').value,
    excessAmount: parseFloat(document.getElementById('excess-amount-input')?.value) || 0,
    spurious: document.getElementById('spurious-select').value,
    // Ops fields populated by API in production:
    city: document.getElementById('f-city').textContent,
    branch: document.getElementById('f-branch').textContent,
    loanAmount: document.getElementById('f-amount').textContent,
  };

  // ── REPLACE WITH FIRESTORE WRITE IN PRODUCTION ──
  auditStore.unshift(audit);

  document.getElementById('submit-row').classList.add('hidden');
  document.getElementById('success-bar').classList.remove('hidden');
  setStep(4);
}

function clearForm() {
  currentLoanId = null;
  document.getElementById('loan-id-input').value = '';
  document.getElementById('tw-input').value = '';
  document.getElementById('excess-select').value = 'No';
  document.getElementById('spurious-select').value = 'No';
  document.getElementById('excess-amount-group').style.display = 'none';
  const hint = document.getElementById('lookup-hint');
  hint.textContent = 'Press Enter or click Fetch to load ops data for this loan.';
  hint.className = 'field-hint';
  hideAuditCards();
  document.getElementById('success-bar').classList.add('hidden');
  setStep(1);
}

// ────────────────────────────
// TEAR WEIGHT TABLE
// ────────────────────────────
let twCurrentValues = {};

function renderTWTable(search = '', filter = twFilter) {
  const loans = auditStore;

  const total = loans.length;
  const checked = Object.keys(twCurrentValues).length;
  const flagged = Object.entries(twCurrentValues).filter(([id, v]) => {
    const a = loans.find(x => x.loanId === id);
    return a && Math.abs(v - a.tw) > 0.3;
  }).length;
  const matched = checked - flagged;

  document.getElementById('tw-stat-row').innerHTML = `
    <div class="stat-chip">${total} loan${total !== 1 ? 's' : ''}</div>
    <div class="stat-chip success">${matched} matched</div>
    <div class="stat-chip danger">${flagged} flagged</div>
  `;

  const filtered = loans.filter(a => {
    const s = search.toLowerCase();
    const matchSearch = !s || a.loanId.toLowerCase().includes(s) || (a.branch || '').toLowerCase().includes(s);
    const cv = twCurrentValues[a.loanId];
    const hasCv = cv !== undefined;
    const isFlagged = hasCv && Math.abs(cv - a.tw) > 0.3;
    const isMatched = hasCv && !isFlagged;
    if (filter === 'pending') return matchSearch && !hasCv;
    if (filter === 'matched') return matchSearch && isMatched;
    if (filter === 'flagged') return matchSearch && isFlagged;
    return matchSearch;
  });

  const tbody = document.getElementById('tw-tbody');

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${total === 0 ? 'No audits submitted yet. Complete a new audit to see loans here.' : 'No loans match this filter.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(a => {
    const cv = twCurrentValues[a.loanId];
    const hasCv = cv !== undefined;
    const isFlagged = hasCv && Math.abs(cv - a.tw) > 0.3;
    const isMatched = hasCv && !isFlagged;
    const diff = hasCv ? (cv - a.tw).toFixed(2) : '—';
    const diffDisplay = hasCv
      ? `<span style="color:${isFlagged ? 'var(--danger)' : 'var(--success)'}; font-weight:500">${parseFloat(diff) > 0 ? '+' : ''}${diff}</span>`
      : '<span style="color:var(--text-3)">—</span>';

    let badge = '<span class="badge badge-pending">Pending</span>';
    if (isFlagged) badge = '<span class="badge badge-flag">⚠ Mismatch</span>';
    else if (isMatched) badge = '<span class="badge badge-match">✓ Match</span>';

    return `
      <tr class="${isFlagged ? 'flagged' : isMatched ? 'matched' : ''}" data-lid="${a.loanId}">
        <td><span class="loan-mono">${a.loanId}</span></td>
        <td style="color:var(--text-2)">${a.branch || '—'}</td>
        <td style="color:var(--text-2)">${a.date}</td>
        <td style="color:var(--text-2)">${a.auditor}</td>
        <td><strong>${a.tw.toFixed(2)}</strong></td>
        <td>
          <input class="tw-input-cell ${isFlagged ? 'mismatch' : ''}"
            type="number" step="0.01"
            value="${hasCv ? cv : ''}"
            placeholder="—"
            onchange="onTWChange('${a.loanId}', this)" />
        </td>
        <td>${diffDisplay}</td>
        <td>${badge}</td>
      </tr>`;
  }).join('');
}

function onTWChange(loanId, input) {
  const val = parseFloat(input.value);
  if (!isNaN(val) && val > 0) twCurrentValues[loanId] = val;
  else delete twCurrentValues[loanId];
  renderTWTable(document.querySelector('#tear-weight .search-input')?.value || '');
}

function filterTW(val) {
  renderTWTable(val, twFilter);
}

function setTWFilter(f, btn) {
  twFilter = f;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderTWTable(document.querySelector('#tear-weight .search-input')?.value || '');
}

// ────────────────────────────
// ALL AUDITS
// ────────────────────────────
function renderAllAudits(search = '') {
  const total = auditStore.length;
  const excess = auditStore.filter(a => a.excessFunding === 'Yes').length;
  const spurious = auditStore.filter(a => a.spurious === 'Yes').length;
  const clean = auditStore.filter(a => a.excessFunding === 'No' && a.spurious === 'No').length;

  const cards = document.getElementById('summary-grid').querySelectorAll('.sc-value');
  cards[0].textContent = total;
  cards[1].textContent = excess;
  cards[2].textContent = spurious;
  cards[3].textContent = clean;

  const s = search.toLowerCase();
  const filtered = auditStore.filter(a =>
    !s || a.loanId.toLowerCase().includes(s) || (a.branch || '').toLowerCase().includes(s) || (a.auditor || '').toLowerCase().includes(s)
  );

  const tbody = document.getElementById('reports-tbody');

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${total === 0 ? 'No audits submitted yet.' : 'No results for this search.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((a, i) => {
    const excessBadge = a.excessFunding === 'Yes'
      ? `<span class="badge badge-excess">Yes${a.excessAmount ? ' — ₹' + Number(a.excessAmount).toLocaleString('en-IN') : ''}</span>`
      : `<span class="badge-no">No</span>`;
    const spurBadge = a.spurious === 'Yes'
      ? `<span class="badge badge-flag">Yes</span>`
      : `<span class="badge-no">No</span>`;

    return `
      <tr class="row-clickable" onclick="openModal(${auditStore.indexOf(a)})">
        <td><span class="loan-mono">${a.loanId}</span></td>
        <td style="color:var(--text-2)">${a.branch || '—'}</td>
        <td style="color:var(--text-2)">${a.date}</td>
        <td style="color:var(--text-2)">${a.auditor}</td>
        <td>${a.loanAmount || '—'}</td>
        <td>${excessBadge}</td>
        <td>${spurBadge}</td>
        <td><strong>${a.tw.toFixed(2)}</strong></td>
      </tr>`;
  }).join('');
}

function filterReports(val) {
  renderAllAudits(val);
}

// ────────────────────────────
// AUDIT DETAIL MODAL
// ────────────────────────────
function openModal(index) {
  const a = auditStore[index];
  document.getElementById('modal-loan-id').textContent = a.loanId;
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-section">Audit summary</div>
    <div class="modal-grid">
      <div><div class="mfl">Loan ID</div><div class="mfv" style="font-family:monospace">${a.loanId}</div></div>
      <div><div class="mfl">Date</div><div class="mfv">${a.date}</div></div>
      <div><div class="mfl">Auditor</div><div class="mfv">${a.auditor}</div></div>
      <div><div class="mfl">Branch</div><div class="mfv">${a.branch || '—'}</div></div>
      <div><div class="mfl">City</div><div class="mfv">${a.city || '—'}</div></div>
      <div><div class="mfl">Loan amount</div><div class="mfv">${a.loanAmount || '—'}</div></div>
    </div>
    <div class="modal-section">Findings</div>
    <div class="modal-grid">
      <div><div class="mfl">Tear weight</div><div class="mfv">${a.tw.toFixed(2)} g</div></div>
      <div><div class="mfl">Excess funding</div><div class="mfv" style="color:${a.excessFunding === 'Yes' ? 'var(--danger)' : 'inherit'}">${a.excessFunding}${a.excessAmount ? ' — ₹' + Number(a.excessAmount).toLocaleString('en-IN') : ''}</div></div>
      <div><div class="mfl">Spurious</div><div class="mfv" style="color:${a.spurious === 'Yes' ? 'var(--danger)' : 'inherit'}">${a.spurious}</div></div>
    </div>
  `;
  document.getElementById('audit-modal').classList.remove('hidden');
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('audit-modal')) {
    document.getElementById('audit-modal').classList.add('hidden');
  }
}
