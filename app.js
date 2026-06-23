// ─────────────────────────────────────────────────────
// ORO AUDIT APP — app.js
// Firebase Firestore as central database
// ─────────────────────────────────────────────────────

// ── Firebase config ──
const firebaseConfig = {
  apiKey: "AIzaSyALq2Ss5yq2Kls-J9xB4rr3QSbxiu1cYfM",
  authDomain: "oro-audit.firebaseapp.com",
  projectId: "oro-audit",
  storageBucket: "oro-audit.firebasestorage.app",
  messagingSenderId: "875163871561",
  appId: "1:875163871561:web:be80f9291c72cce4029298"
};

// ── Firebase init (loaded via CDN in index.html) ──
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const COLLECTION = 'audits';

// ── Audit store ──
let auditStore = [];
let twFilter = 'all';
let twCurrentValues = {};
let currentLoanId = null;

// ── Date formatter ──
function formatDate(dateStr) {
  if (!dateStr || dateStr === "—") return "—";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  // DD/MM/YY
  return parts[2] + "/" + parts[1] + "/" + parts[0].slice(-2);
}

// ── Demo loan ──
const DEMO_LOAN_ID = 'DEMO-0000001';
const DEMO_OPS_DATA = {
  date: '2026-06-23', city: 'Hyderabad', branch: 'Demo Branch',
  agent: 'Demo Agent', maker: 'Demo Maker', packet: 'PKT-DEMO-001', amount: '₹1,20,000',
  ornaments: [
    { type: 'Necklace', count: 1, gw: '24.50', stoneDed: '1.20', karat: 22, nw: '23.30', hallmark: 'Yes' },
    { type: 'Finger Ring', count: 2, gw: '6.80', stoneDed: '0.20', karat: 22, nw: '6.60', hallmark: 'No' },
  ]
};

// ────────────────────────────────────────
// FIRESTORE — LOAD ALL AUDITS
// ────────────────────────────────────────
function loadAudits() {
  return db.collection(COLLECTION)
    .orderBy('date', 'desc')
    .get()
    .then(snapshot => {
      auditStore = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return auditStore;
    })
    .catch(err => {
      console.error('Firestore load error:', err);
      return [];
    });
}

// ────────────────────────────────────────
// FIRESTORE — SAVE ONE AUDIT
// ────────────────────────────────────────
function saveAudit(audit) {
  return db.collection(COLLECTION)
    .add(audit)
    .then(ref => {
      audit.id = ref.id;
      auditStore.unshift(audit);
      return audit;
    });
}

// ────────────────────────────
// NAVIGATION
// ────────────────────────────
function switchSection(id, btn) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  if (id === 'tear-weight') {
    showLoadingState('tw-tbody', 8, 'Loading from Firestore...');
    loadAudits().then(() => { renderTWTable(); populateBranchFilter(); });
  }
  if (id === 'all-audits') {
    showLoadingState('reports-tbody', 8, 'Loading from Firestore...');
    loadAudits().then(() => renderAllAudits());
  }
}

function showLoadingState(tbodyId, cols, msg) {
  document.getElementById(tbodyId).innerHTML =
    `<tr class="empty-row"><td colspan="${cols}">${msg}</td></tr>`;
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
  if (id === DEMO_LOAN_ID) { populateOpsCard(id, DEMO_OPS_DATA); return; }

  // ── METABASE LIVE LOOKUP ──
  fetch(`/api/loan-lookup?loanId=${encodeURIComponent(id)}`)
    .then(res => res.json())
    .then(data => {
      if (data.error) {
        hint.textContent = data.error === 'Loan not found'
          ? `No loan found for "${id}" in the database.`
          : `Error fetching data: ${data.error}`;
        hint.className = 'field-hint error';
        hideAuditCards();
        return;
      }
      populateOpsCard(id, {
        date: data.loanDate || '—',
        city: data.city || '—',
        branch: data.branch || '—',
        agent: '—',
        maker: '—',
        packet: '—',
        amount: data.loanAmount || '—',
        ornaments: (data.ornaments || []).map(o => ({
          type: o.type,
          count: o.count,
          gw: o.gw,
          stoneDed: o.stoneDed,
          karat: o.karat,
          nw: o.nw,
          hallmark: '—'
        }))
      });
    })
    .catch(err => {
      hint.textContent = 'Failed to connect to database. Check your connection.';
      hint.className = 'field-hint error';
      console.error(err);
    });
}

function populateOpsCard(loanId, data) {
  currentLoanId = loanId;
  document.getElementById('ops-loan-id').textContent = loanId;
  const hint = document.getElementById('lookup-hint');
  if (!data) {
    hint.textContent = 'Ops data will populate here once the live database is connected.';
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
  if (data && data.ornaments && data.ornaments.length > 0) {
    initOrnamentStepper(data.ornaments);
  }
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
      <td>${o.type}</td><td>${o.count}</td><td>${o.gw}</td>
      <td>${o.stoneDed}</td><td>${o.karat} kt</td>
      <td><strong>${o.nw}</strong></td><td>${o.hallmark || '—'}</td>
    </tr>
  `).join('');
}

// ── Ornament stepper state ──
let currentOrnaments = [];
let currentOrnamentIndex = 0;
let auditedOrnaments = [];

function showAuditCards() {
  ['card-ops','card-audit'].forEach(id => document.getElementById(id).classList.remove('hidden'));
  document.getElementById('card-audit-preview').classList.add('hidden');
  document.getElementById('card-tw').classList.add('hidden');
  document.getElementById('submit-row').classList.add('hidden');
  document.getElementById('success-bar').classList.add('hidden');
}

function hideAuditCards() {
  ['card-ops','card-audit','card-audit-preview','card-tw','submit-row'].forEach(id => document.getElementById(id).classList.add('hidden'));
}

function initOrnamentStepper(ornaments) {
  currentOrnaments = ornaments;
  currentOrnamentIndex = 0;
  auditedOrnaments = [];
  renderOrnamentStep();
}

function renderOrnamentStep() {
  const o = currentOrnaments[currentOrnamentIndex];
  const total = currentOrnaments.length;
  const idx = currentOrnamentIndex;

  // Update label
  document.getElementById('ornament-step-label').textContent =
    `Ornament ${idx + 1} of ${total} — ${o.type}`;

  // Update dots
  document.getElementById('ornament-step-dots').innerHTML = currentOrnaments.map((_, i) =>
    `<div style="width:10px; height:10px; border-radius:50%; background:${i < idx ? 'var(--success)' : i === idx ? 'var(--gold)' : 'var(--border)'};"></div>`
  ).join('');

  // Update reference row
  document.getElementById('ref-type').textContent = o.type || '—';
  document.getElementById('ref-count').textContent = o.count || '—';
  document.getElementById('ref-gw').textContent = o.gw || '—';
  document.getElementById('ref-karat').textContent = (o.karat || '—') + ' kt';
  document.getElementById('ref-nw').textContent = o.nw || '—';

  // Clear fields
  ['aud-gw','aud-stone','aud-karat','aud-nw','aud-packet'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('aud-hallmark').value = '';

  // Update button
  const btn = document.getElementById('ornament-next-btn');
  btn.textContent = idx === total - 1 ? 'Done — review ✓' : `Next ornament (${idx + 2} of ${total}) →`;
}

function nextOrnament() {
  // Save current ornament audit data
  const o = currentOrnaments[currentOrnamentIndex];
  auditedOrnaments.push({
    type: o.type,
    count: o.count,
    // Ops data (from PC)
    gwPC: o.gw,
    stoneDedPC: o.stoneDed,
    karatPC: o.karat,
    nwPC: o.nw,
    // Audit data
    gwAudit: document.getElementById('aud-gw').value,
    stoneDedAudit: document.getElementById('aud-stone').value,
    karatAudit: document.getElementById('aud-karat').value,
    nwAudit: document.getElementById('aud-nw').value,
    hallmark: document.getElementById('aud-hallmark').value,
    newPacketId: document.getElementById('aud-packet').value,
  });

  if (currentOrnamentIndex < currentOrnaments.length - 1) {
    currentOrnamentIndex++;
    renderOrnamentStep();
  } else {
    // All ornaments done — show preview
    showAuditPreview();
  }
}

function showAuditPreview() {
  document.getElementById('card-audit').classList.add('hidden');
  document.getElementById('card-audit-preview').classList.remove('hidden');
  document.getElementById('card-tw').classList.remove('hidden');
  document.getElementById('submit-row').classList.remove('hidden');
  setStep(3);

  const remarks = document.getElementById('audit-remarks')?.value || '';
  const excess = document.getElementById('excess-select')?.value || 'No';
  const excessAmt = document.getElementById('excess-amount-input')?.value || '';
  const spurious = document.getElementById('spurious-select')?.value || 'No';

  document.getElementById('audit-preview-content').innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-3); margin-bottom:12px;">Ornaments audited</div>
      ${auditedOrnaments.map((o, i) => `
        <div style="background:var(--surface-2); border:1px solid var(--border); border-radius:var(--r-sm); padding:12px 16px; margin-bottom:10px;">
          <div style="font-size:13px; font-weight:600; color:var(--gold); margin-bottom:10px;">${o.type} (Ornament ${i+1})</div>
          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">
            <div>
              <div style="font-size:11px; color:var(--text-3); margin-bottom:4px;">GW</div>
              <div style="font-size:12px; display:flex; gap:8px; align-items:center;">
                <span style="color:var(--text-3);">PC: ${o.gwPC}g</span>
                <span style="color:var(--text-1); font-weight:600;">Audit: ${o.gwAudit || '—'}g</span>
                ${o.gwAudit && Math.abs(parseFloat(o.gwAudit) - parseFloat(o.gwPC)) > 0.3 ? '<span style="color:var(--danger); font-size:11px;">⚠ diff</span>' : ''}
              </div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--text-3); margin-bottom:4px;">Karat</div>
              <div style="font-size:12px; display:flex; gap:8px;">
                <span style="color:var(--text-3);">PC: ${o.karatPC}kt</span>
                <span style="color:var(--text-1); font-weight:600;">Audit: ${o.karatAudit || '—'}kt</span>
                ${o.karatAudit && parseInt(o.karatAudit) !== parseInt(o.karatPC) ? '<span style="color:var(--danger); font-size:11px;">⚠ diff</span>' : ''}
              </div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--text-3); margin-bottom:4px;">NW</div>
              <div style="font-size:12px; display:flex; gap:8px;">
                <span style="color:var(--text-3);">PC: ${o.nwPC}g</span>
                <span style="color:var(--text-1); font-weight:600;">Audit: ${o.nwAudit || '—'}g</span>
                ${o.nwAudit && Math.abs(parseFloat(o.nwAudit) - parseFloat(o.nwPC)) > 0.3 ? '<span style="color:var(--danger); font-size:11px;">⚠ diff</span>' : ''}
              </div>
            </div>
          </div>
          ${o.hallmark ? `<div style="margin-top:8px; font-size:12px;"><span style="color:var(--text-3);">Hallmark:</span> ${o.hallmark}</div>` : ''}
          ${o.newPacketId ? `<div style="margin-top:4px; font-size:12px;"><span style="color:var(--text-3);">New packet ID:</span> ${o.newPacketId}</div>` : ''}
        </div>
      `).join('')}
    </div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:12px;">
      <div><div style="font-size:11px; color:var(--text-3);">Excess funding</div><div style="font-size:14px; font-weight:600; color:${excess === 'Yes' ? 'var(--danger)' : 'inherit'}">${excess}${excessAmt ? ' — ₹' + Number(excessAmt).toLocaleString('en-IN') : ''}</div></div>
      <div><div style="font-size:11px; color:var(--text-3);">Spurious</div><div style="font-size:14px; font-weight:600; color:${spurious === 'Yes' ? 'var(--danger)' : 'inherit'}">${spurious}</div></div>
    </div>
    ${remarks ? `<div style="padding:10px 14px; background:var(--surface-2); border:1px solid var(--border); border-radius:var(--r-sm); font-size:13px;">${remarks}</div>` : ''}
    <button class="btn-ghost" style="margin-top:12px; font-size:12px;" onclick="goBackToAudit()">← Edit audit data</button>
  `;
}

function goBackToAudit() {
  document.getElementById('card-audit-preview').classList.add('hidden');
  document.getElementById('card-tw').classList.add('hidden');
  document.getElementById('submit-row').classList.add('hidden');
  document.getElementById('card-audit').classList.remove('hidden');
  currentOrnamentIndex = 0;
  auditedOrnaments = [];
  renderOrnamentStep();
  setStep(2);
}

// ────────────────────────────
// EXCESS FUNDING TOGGLE
// ────────────────────────────
function toggleExcessAmount() {
  const val = document.getElementById('excess-select').value;
  document.getElementById('excess-amount-group').style.display = val === 'Yes' ? 'flex' : 'none';
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
// SUBMIT — SAVES TO FIRESTORE
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
    city: document.getElementById('f-city').textContent,
    branch: document.getElementById('f-branch').textContent,
    loanAmount: document.getElementById('f-amount').textContent,
    remarks: document.getElementById('audit-remarks')?.value || '',
    ornaments: auditedOrnaments,
    submittedAt: new Date().toISOString(),
  };

  const btn = document.querySelector('#submit-row .btn-dark');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  saveAudit(audit)
    .then(() => {
      document.getElementById('submit-row').classList.add('hidden');
      document.getElementById('success-bar').classList.remove('hidden');
      setStep(4);
    })
    .catch(err => {
      alert('Failed to save. Check your connection and try again.');
      console.error(err);
      btn.textContent = 'Submit audit';
      btn.disabled = false;
    });
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
  const btn = document.querySelector('#submit-row .btn-dark');
  if (btn) { btn.textContent = 'Submit audit ✓'; btn.disabled = false; }
  setStep(1);
}

// ────────────────────────────
// TEAR WEIGHT TABLE
// ────────────────────────────
const TW_PAGE_SIZE = 15;
let twCurrentPage = 0;

function renderTWTable(search = '', filter = twFilter) {
  const loans = auditStore;
  const checked = Object.keys(twCurrentValues).length;
  const flagged = Object.entries(twCurrentValues).filter(([id, v]) => {
    const a = loans.find(x => x.loanId === id);
    return a && a.tw != null && Math.abs(v - a.tw) > 0.3;
  }).length;
  const matched = checked - flagged;

  document.getElementById('tw-stat-row').innerHTML = `
    <div class="stat-chip">${loans.length} loan${loans.length !== 1 ? 's' : ''}</div>
    <div class="stat-chip success">${matched} matched</div>
    <div class="stat-chip danger">${flagged} flagged</div>
  `;

  const branchFilter = document.getElementById('tw-branch-filter')?.value || '';
  const dateFrom = document.getElementById('tw-date-from')?.value || '';
  const dateTo = document.getElementById('tw-date-to')?.value || '';

  const filtered = loans.filter(a => {
    const s = search.toLowerCase();
    const matchSearch = !s || a.loanId.toLowerCase().includes(s);
    const matchBranch = !branchFilter || a.branch === branchFilter;
    const matchFrom = !dateFrom || a.date >= dateFrom;
    const matchTo = !dateTo || a.date <= dateTo;
    const cv = twCurrentValues[a.loanId];
    const hasCv = cv !== undefined;
    const isFlagged = hasCv && a.tw != null && Math.abs(cv - a.tw) > 0.3;
    const isMatched = hasCv && !isFlagged;
    if (filter === 'pending') return matchSearch && matchBranch && matchFrom && matchTo && !hasCv;
    if (filter === 'matched') return matchSearch && matchBranch && matchFrom && matchTo && isMatched;
    if (filter === 'flagged') return matchSearch && matchBranch && matchFrom && matchTo && isFlagged;
    return matchSearch && matchBranch && matchFrom && matchTo;
  });

  const tbody = document.getElementById('tw-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">${loans.length === 0 ? 'No audits in database yet.' : 'No loans match this filter.'}</td></tr>`;
    renderTWPagination(0, 0);
    return;
  }

  // Pagination
  const totalPages = Math.ceil(filtered.length / TW_PAGE_SIZE);
  if (twCurrentPage >= totalPages) twCurrentPage = 0;
  const pageStart = twCurrentPage * TW_PAGE_SIZE;
  const pageLoans = filtered.slice(pageStart, pageStart + TW_PAGE_SIZE);

  tbody.innerHTML = pageLoans.map(a => {
    const cv = twCurrentValues[a.loanId];
    const hasCv = cv !== undefined;
    const isFlagged = hasCv && a.tw != null && Math.abs(cv - a.tw) > 0.3;
    const isMatched = hasCv && !isFlagged;
    const diff = hasCv && a.tw != null ? (cv - a.tw).toFixed(2) : '—';
    const diffDisplay = hasCv && a.tw != null
      ? `<span style="color:${isFlagged ? 'var(--danger)' : 'var(--success)'}; font-weight:500">${parseFloat(diff) > 0 ? '+' : ''}${diff}</span>`
      : '<span style="color:var(--text-3)">—</span>';
    let badge = '<span class="badge badge-pending">Pending</span>';
    if (isFlagged) badge = '<span class="badge badge-flag">⚠ Mismatch</span>';
    else if (isMatched) badge = '<span class="badge badge-match">✓ Match</span>';

    const isSubmitted = a._twSubmitted === true;

    return `
      <tr class="${isFlagged ? 'flagged' : isMatched ? 'matched' : ''}" data-lid="${a.loanId}">
        <td><span class="loan-mono">${a.loanId}</span></td>
        <td style="color:var(--text-2)">${a.branch || '—'}</td>
        <td style="color:var(--text-2)">${formatDate(a.date)}</td>
        <td style="color:var(--text-2)">${a.auditor}</td>
        <td><strong>${a.tw != null ? Number(a.tw).toFixed(2) : '—'}</strong></td>
        <td>
          <input class="tw-input-cell ${isFlagged ? 'mismatch' : ''}"
            id="tw-cell-${a.loanId}"
            type="number" step="0.01"
            value="${hasCv ? cv : ''}" placeholder="—"
            onchange="onTWChange('${a.loanId}', this)"
            ${isSubmitted ? 'disabled' : ''} />
        </td>
        <td>${diffDisplay}</td>
        <td>${badge}</td>
        <td>
          ${isSubmitted
            ? '<span style="color:var(--success); font-size:12px; font-weight:500;">✓ Saved</span>'
            : `<button class="btn-ghost" style="height:28px; font-size:12px; padding:0 10px;"
                onclick="submitTW('${a.loanId}')">Save</button>`
          }
        </td>
      </tr>`;
  }).join('');

  renderTWPagination(twCurrentPage, totalPages, filtered.length);
}

function renderTWPagination(page, totalPages, total) {
  const el = document.getElementById('tw-pagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  const start = page * TW_PAGE_SIZE + 1;
  const end = Math.min((page + 1) * TW_PAGE_SIZE, total);
  el.innerHTML = `
    <span>Showing ${start}–${end} of ${total} loans</span>
    <div style="display:flex; gap:6px;">
      <button class="btn-ghost" style="height:30px; font-size:12px; padding:0 12px;"
        onclick="changeTWPage(-1)" ${page === 0 ? 'disabled' : ''}>← Prev</button>
      <span style="display:flex; align-items:center; padding:0 8px; font-weight:500;">Page ${page+1} / ${totalPages}</span>
      <button class="btn-ghost" style="height:30px; font-size:12px; padding:0 12px;"
        onclick="changeTWPage(1)" ${page >= totalPages-1 ? 'disabled' : ''}>Next →</button>
    </div>
  `;
}

function changeTWPage(dir) {
  twCurrentPage += dir;
  applyTWFilters();
}

function onTWChange(loanId, input) {
  const val = parseFloat(input.value);
  if (!isNaN(val) && val > 0) twCurrentValues[loanId] = val;
  else delete twCurrentValues[loanId];
  // Re-render just the diff/status without full re-render
  applyTWFilters();
}

function submitTW(loanId) {
  const newTW = twCurrentValues[loanId];
  if (!newTW || isNaN(newTW) || newTW <= 0) {
    alert('Please enter a tare weight value before saving.');
    return;
  }

  const audit = auditStore.find(a => a.loanId === loanId);
  if (!audit || !audit.id) { alert('Loan not found.'); return; }

  const btn = document.querySelector(`tr[data-lid="${loanId}"] button`);
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  db.collection('audits').doc(audit.id)
    .update({ tw: newTW, twUpdatedAt: new Date().toISOString() })
    .then(() => {
      audit.tw = newTW;
      audit._twSubmitted = true;
      delete twCurrentValues[loanId];
      applyTWFilters();
    })
    .catch(err => {
      console.error('Failed to save TW:', err);
      alert('Failed to save. Check your connection.');
      if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
    });
}

function applyTWFilters(resetPage = false) {
  if (resetPage) twCurrentPage = 0;
  const search = document.getElementById('tw-search-input')?.value || '';
  renderTWTable(search, twFilter);
}

function filterTW(val) { renderTWTable(val, twFilter); }

function clearTWFilters() {
  const branchSel = document.getElementById('tw-branch-filter');
  const dateFrom = document.getElementById('tw-date-from');
  const dateTo = document.getElementById('tw-date-to');
  const searchInput = document.getElementById('tw-search-input');
  if (branchSel) branchSel.value = '';
  if (dateFrom) dateFrom.value = '';
  if (dateTo) dateTo.value = '';
  if (searchInput) searchInput.value = '';
  renderTWTable('', twFilter);
}

function setTWFilter(f, btn) {
  twFilter = f;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyTWFilters();
}

function populateBranchFilter() {
  const branches = [...new Set(auditStore.map(a => a.branch).filter(b => b && b !== "—"))].sort();
  const sel = document.getElementById('tw-branch-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="">All branches</option>' +
    branches.map(b => '<option value="' + b + '">' + b + '</option>').join('');
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
    !s || a.loanId.toLowerCase().includes(s) ||
    (a.branch || '').toLowerCase().includes(s) ||
    (a.auditor || '').toLowerCase().includes(s)
  );

  const tbody = document.getElementById('reports-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${total === 0 ? 'No audits in database yet.' : 'No results.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(a => {
    const excessBadge = a.excessFunding === 'Yes'
      ? `<span class="badge badge-excess">Yes${a.excessAmount ? ' — ₹' + Number(a.excessAmount).toLocaleString('en-IN') : ''}</span>`
      : `<span class="badge-no">No</span>`;
    const spurBadge = a.spurious === 'Yes'
      ? `<span class="badge badge-flag">Yes</span>`
      : `<span class="badge-no">No</span>`;

    return `
      <tr class="row-clickable" onclick="openModal('${a.id}')">
        <td><span class="loan-mono">${a.loanId}</span></td>
        <td style="color:var(--text-2)">${a.branch || '—'}</td>
        <td style="color:var(--text-2)">${formatDate(a.date)}</td>
        <td style="color:var(--text-2)">${a.auditor}</td>
        <td>${a.loanAmount || '—'}</td>
        <td>${excessBadge}</td>
        <td>${spurBadge}</td>
        <td><strong>${a.tw != null ? Number(a.tw).toFixed(2) : '—'}</strong></td>
      </tr>`;
  }).join('');
}

function filterReports(val) { renderAllAudits(val); }

// ────────────────────────────
// MODAL
// ────────────────────────────
function openModal(docId) {
  const a = auditStore.find(x => x.id === docId);
  if (!a) return;
  document.getElementById('modal-loan-id').textContent = a.loanId;
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-section">Audit summary</div>
    <div class="modal-grid">
      <div><div class="mfl">Loan ID</div><div class="mfv" style="font-family:monospace">${a.loanId}</div></div>
      <div><div class="mfl">Audit date</div><div class="mfv">${a.date}</div></div>
      <div><div class="mfl">Auditor</div><div class="mfv">${a.auditor}</div></div>
      <div><div class="mfl">Branch</div><div class="mfv">${a.branch || '—'}</div></div>
      <div><div class="mfl">City</div><div class="mfv">${a.city || '—'}</div></div>
      <div><div class="mfl">Loan amount</div><div class="mfv">${a.loanAmount || '—'}</div></div>
    </div>
    <div class="modal-section">Findings</div>
    <div class="modal-grid">
      <div><div class="mfl">Tear weight</div><div class="mfv">${a.tw != null ? Number(a.tw).toFixed(2) + ' g' : '—'}</div></div>
      <div><div class="mfl">Excess funding</div><div class="mfv" style="color:${a.excessFunding === 'Yes' ? 'var(--danger)' : 'inherit'}">${a.excessFunding}${a.excessAmount ? ' — ₹' + Number(a.excessAmount).toLocaleString('en-IN') : ''}</div></div>
      <div><div class="mfl">Spurious</div><div class="mfv" style="color:${a.spurious === 'Yes' ? 'var(--danger)' : 'inherit'}">${a.spurious}</div></div>
    </div>
    ${a.remarks ? `<div class="modal-section">Remarks</div><div class="remarks-block">${a.remarks}</div>` : ''}
  `;
  document.getElementById('audit-modal').classList.remove('hidden');
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('audit-modal')) {
    document.getElementById('audit-modal').classList.add('hidden');
  }
}
