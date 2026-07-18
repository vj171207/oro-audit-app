// ─────────────────────────────────────────────────────
// ORO AUDIT APP — app.js
// Firebase Firestore as central database
// ─────────────────────────────────────────────────────

// ── Global error logging ──
// Catches any error that would otherwise fail silently: uncaught exceptions,
// unhandled promise rejections (e.g. a fetch().then() chain with no .catch()).
// Purely observational — does not change any existing behavior. Logs a
// consistent, readable block to the console with timestamp, what the user
// was doing, and the full error detail, so a failure is easy to spot and
// diagnose instead of just vanishing.

function logAppError(kind, detail) {
  const context = {
    time: new Date().toISOString(),
    kind,                                   // 'uncaught-error' | 'unhandled-promise-rejection'
    section: typeof getCurrentSection === 'function' ? getCurrentSection() : (document.querySelector('.section.active')?.id || 'unknown'),
    user: typeof currentUser !== 'undefined' && currentUser ? currentUser.email : 'not signed in',
    role: typeof currentUserRole !== 'undefined' ? currentUserRole : 'unknown',
    ...detail
  };

  console.error(
    `%c[Tenmark Audit App error] ${kind}`,
    'color:#fff; background:#B83232; padding:2px 6px; border-radius:3px; font-weight:600;',
    context
  );

  // Optional next step: send `context` to a logging endpoint (e.g. a
  // lightweight /api/log-error function) so errors are visible without
  // needing to have the browser console open. Not wired up yet —
  // console logging alone is the safe, zero-risk first step.

  showErrorPopup(
    'Something went wrong',
    'An unexpected error occurred. Try again, and if it keeps happening, let Rijin or Vivek know.',
    JSON.stringify(context, null, 2)
  );
}

// ── apiRequest: single choke point for all /api/* calls ──
// Drop-in replacement for the fetch(url, options).then(res => res.json())
// pattern used everywhere in this file. Behavior is IDENTICAL to what every
// call site already did — same request, same JSON parsing, same promise
// shape (resolves to parsed JSON, rejects on network/parse failure exactly
// like fetch()/res.json() would have). No error-handling logic was moved
// here; every call site keeps its own .then()/.catch() or try/catch exactly
// as before, so nothing about current behavior changes.
//
// Why this exists: today every call site independently calls fetch()
// directly against a hardcoded relative path like '/api/loan-lookup'. When
// this app is integrated elsewhere (e.g. base URL changes, or auth headers
// like a JWT need to be attached to every request), there is currently no
// single place to make that change — it would mean editing 9 separate call
// sites. Routing every call through this one function means that future
// change happens in exactly one place.
function apiRequest(path, options) {
  return fetch(path, options).then(res => res.json());
}

// ── Error popup (toast) ──
// Shows a small, dismissible notice in the top-right corner. Multiple
// errors stack rather than replace each other. Auto-dismisses after 10s,
// or the user can close it manually. Technical detail is tucked behind
// an optional "Show details" toggle so auditors aren't shown a wall of
// stack trace, but the detail is one click away when debugging.
function showErrorPopup(title, message, technicalDetail) {
  let stack = document.getElementById('error-toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'error-toast-stack';
    stack.className = 'error-toast-stack';
    document.body.appendChild(stack);
  }

  const toast = document.createElement('div');
  toast.className = 'error-toast';

  const detailsHtml = technicalDetail
    ? `<details class="error-toast-details">
         <summary>Show technical details</summary>
         <pre>${String(technicalDetail).replace(/</g, '&lt;')}</pre>
       </details>`
    : '';

  toast.innerHTML = `
    <div class="error-toast-head">
      <span class="error-toast-title">⚠ ${title}</span>
      <button class="error-toast-close" aria-label="Dismiss">✕</button>
    </div>
    <div class="error-toast-msg">${message}</div>
    ${detailsHtml}
  `;

  toast.querySelector('.error-toast-close').onclick = () => toast.remove();
  stack.appendChild(toast);

  setTimeout(() => { if (toast.isConnected) toast.remove(); }, 10000);
}

window.addEventListener('error', (event) => {
  logAppError('uncaught-error', {
    message: event.message,
    file: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack || 'no stack available'
  });
});

window.addEventListener('unhandledrejection', (event) => {
  logAppError('unhandled-promise-rejection', {
    reason: event.reason?.message || String(event.reason),
    stack: event.reason?.stack || 'no stack available'
  });
});

// ── Firebase config, init, db, auth: moved to auditDataService.js ──
// (loaded via <script> tag before this file in index.html, so `db`,
// `auth`, and `COLLECTION` are still available here as globals, exactly
// as before — only the location of the init code changed.)

// ── Current user state ──
let currentUser = null;
let currentUserRole = 'auditor';

// ── Audit store ──
let auditStore = [];
let twFilter = 'all';
let twCurrentValues = {};
let currentLoanId = null;
let currentLoanBookingDate = null; // raw ISO date, kept separate from the
                                    // formatted display text in #f-date so
                                    // submission always stores a clean,
                                    // sortable ISO value, not a display string
let currentLoanAmount = null; // raw number, kept separate from the
                               // formatted "₹1,20,000" display text in
                               // #f-amount so submission always stores a
                               // clean number, not a currency-formatted string

// ── All Audits table pagination ──
// The summary cards (Total/Excess/Spurious/Active) need every audit loaded
// anyway, to correctly deduplicate by loan (a loan can have more than one
// audit doc — only the most recent should count). Since that full data is
// already sitting in memory regardless, "pagination" here is specifically
// about how many rows get drawn into the DOM at once, not about reducing
// what's fetched — rendering thousands of table rows is genuinely slow and
// memory-heavy in a browser, independent of how fast the data arrived.
// Set ALL_AUDITS_PAGINATION_ENABLED to false to revert to rendering every
// matching row at once, exactly as the app behaved before this was added —
// a single, deliberate switch rather than something that could silently
// rot from disuse.
const ALL_AUDITS_PAGINATION_ENABLED = true;
const ALL_AUDITS_PAGE_SIZE = 100;
let allAuditsRenderedCount = ALL_AUDITS_PAGE_SIZE;

// ── Active loans cache (fetched from Metabase on load) ──
let activeLoanIds = new Set();

function loadActiveLoans() {
  return apiRequest('/api/active-loans')
    .then(data => {
      if (data.error) throw new Error(data.error);
      activeLoanIds = new Set((data.loans || []).map(l => l.loanNumber));
      return activeLoanIds;
    })
    .catch(err => {
      console.error('Failed to load active loans:', err);
      showErrorPopup(
        'Couldn\'t load loan data',
        'The list of active loans failed to load from Metabase. This may mean the Metabase API token is missing or invalid. Try refreshing — if it keeps happening, flag it to Vivek.',
        err.message
      );
      // Re-throw rather than returning an empty Set — see loadAudits() for
      // why: callers need to actually see this failure to show a proper
      // retry state instead of silently treating "0 active loans" as real.
      throw err;
    });
}

// ── Settings (loaded from Firestore, with defaults) ──
let PENDING_DAYS = 30;
let TW_THRESHOLD = 0.3;
let SETTINGS_PASSWORD = 'oro-sync-2026';
let registeredBranches = []; // Manager-registered branches from Firestore

async function loadSettings() {
  try {
    const d = await getAppSettingsDoc();
    if (d) {
      if (d.pendingDays) PENDING_DAYS = d.pendingDays;
      if (d.twThreshold) TW_THRESHOLD = d.twThreshold;
      if (d.settingsPassword) SETTINGS_PASSWORD = d.settingsPassword;
      if (d.branches) registeredBranches = d.branches;

      // Surface last night's sync failures right when the app opens, rather
      // than requiring anyone to go looking in Vercel logs. This keeps
      // showing on every login until the next sync succeeds and overwrites
      // lastSyncStatus back to 'success' — so it can't be missed, but also
      // can't nag forever once it's actually resolved. Managers only, since
      // auditors/guests have no way to act on this anyway.
      if (currentUserRole === 'manager' && d.lastSyncStatus === 'completed_with_errors') {
        const when = d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'the last sync';
        showErrorPopup(
          'Daily sync had errors',
          `${d.lastSyncFailureCount || 'Some'} loan(s) failed to sync from Metabase at ${when}. Check Vercel logs (api/sync-loans) for details — some new loans may be missing from New Audit until this is resolved.`,
          `lastSyncAt: ${d.lastSyncAt}\nfailureCount: ${d.lastSyncFailureCount}`
        );
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
    showErrorPopup(
      'Couldn\'t load settings',
      'App settings (thresholds, branches, etc.) failed to load from Firestore. Defaults are being used instead.',
      err.message
    );
  }
}

function getLoanStatus(loanId) {
  if (!activeLoanIds.has(loanId)) return 'inactive';
  const firestoreRecords = auditStore.filter(a => a.loanId === loanId && a.source !== 'metabase-sync');
  if (firestoreRecords.length === 0) return 'pending';
  const mostRecent = firestoreRecords.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  const daysSince = Math.floor((new Date() - new Date(mostRecent.date)) / (1000 * 60 * 60 * 24));
  return daysSince <= PENDING_DAYS ? 'audited' : 'pending';
}


// ────────────────────────────
// DARK MODE
// ────────────────────────────
function initDarkMode() {
  const saved = localStorage.getItem('oro-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    const btn = document.getElementById('dark-toggle-btn');
    if (btn) btn.textContent = '☀️';
  }
}

function toggleDarkMode() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const btn = document.getElementById('dark-toggle-btn');
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('oro-theme', 'light');
    if (btn) btn.textContent = '🌙';
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('oro-theme', 'dark');
    if (btn) btn.textContent = '☀️';
  }
}

// ── Audit date ──
// Password is now managed via SETTINGS_PASSWORD (loaded from Firestore)

function initAuditDate() {
  const today = new Date().toISOString().split('T')[0];
  const field = document.getElementById('audit-date-field');
  if (field) field.value = today;
  // Show Edit button and hint only for managers
  const lockBtn = document.getElementById('audit-date-lock-btn');
  const hint = document.getElementById('audit-date-hint');
  if (lockBtn) lockBtn.style.display = currentUserRole === 'manager' ? '' : 'none';
  if (hint) hint.style.display = currentUserRole === 'manager' ? '' : 'none';
}

function unlockAuditDate() {
  if (currentUserRole !== 'manager') return;

  document.getElementById('audit-date-modal').classList.remove('hidden');
  document.getElementById('audit-date-password').value = '';
  document.getElementById('audit-date-modal-error').textContent = '';
  setTimeout(() => document.getElementById('audit-date-password').focus(), 100);
}

function closeAuditDateModal(e) {
  if (!e || e.target === document.getElementById('audit-date-modal')) {
    document.getElementById('audit-date-modal').classList.add('hidden');
  }
}

function confirmAuditDateUnlock() {
  const pwd = document.getElementById('audit-date-password').value.trim();
  if (pwd !== SETTINGS_PASSWORD) {
    document.getElementById('audit-date-modal-error').textContent = '❌ Incorrect password.';
    return;
  }
  // Unlock the date field
  const field = document.getElementById('audit-date-field');
  field.removeAttribute('readonly');
  field.style.borderColor = 'var(--gold)';
  document.getElementById('audit-date-lock-btn').innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><line x1="12" y1="15" x2="12" y2="17"/></svg>
    Unlocked
  `;
  document.getElementById('audit-date-lock-btn').style.color = 'var(--gold)';
  document.getElementById('audit-date-lock-btn').style.borderColor = 'var(--gold)';
  document.getElementById('audit-date-hint').textContent = 'Date is now editable';
  document.getElementById('audit-date-hint').style.color = 'var(--gold)';
  document.getElementById('audit-date-modal').classList.add('hidden');
}

// ── Date formatter ──
// Escapes free-text before it's inserted into rendered HTML (Remarks,
// Packet ID) — anything an auditor typed could otherwise contain characters
// like < or > that a browser would try to interpret as HTML/code rather
// than display as plain text. Normal text (letters, numbers, punctuation
// without < > & " ') displays completely unchanged; only those five
// characters get converted to their safe equivalents.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
  agent: 'Demo Agent', maker: 'Demo Maker', packet: 'PKT-DEMO-001', amount: 120000,
  ornaments: [
    { type: 'Necklace', count: 1, gw: '24.50', stoneDed: '1.20', karat: 22, nw: '23.30', hallmark: 'Yes' },
    { type: 'Finger Ring', count: 2, gw: '6.80', stoneDed: '0.20', karat: 22, nw: '6.60', hallmark: 'No' },
  ]
};

// ────────────────────────────────────────
// FIRESTORE — LOAD ALL AUDITS / SAVE ONE AUDIT
// (loadAudits() and saveAudit() are now defined in auditDataService.js,
// loaded before this file — unchanged behavior, just relocated.)
// ────────────────────────────────────────

// ────────────────────────────
// MANUAL SYNC
// ────────────────────────────
function triggerManualSync() {
  document.getElementById('sync-modal').classList.remove('hidden');
  document.getElementById('sync-password-input').value = '';
  document.getElementById('sync-result').innerHTML = '';
  const btn = document.getElementById('sync-run-btn');
  btn.textContent = 'Run sync';
  btn.disabled = false;
  setTimeout(() => document.getElementById('sync-password-input').focus(), 100);
}

function closeSyncModal(e) {
  if (!e || e.target === document.getElementById('sync-modal')) {
    document.getElementById('sync-modal').classList.add('hidden');
  }
}

function runSync() {
  if (currentUserRole === 'guest') return;

  const password = document.getElementById('sync-password-input').value.trim();
  if (!password) {
    document.getElementById('sync-result').innerHTML = '<span style="color:var(--danger);">Please enter the sync password.</span>';
    return;
  }

  const btn = document.getElementById('sync-run-btn');
  btn.textContent = 'Syncing...';
  btn.disabled = true;
  document.getElementById('sync-result').innerHTML = '<span style="color:var(--text-3);">Querying Metabase for new loans...</span>';

  apiRequest('/api/sync-loans', {
    headers: { 'Authorization': `Bearer ${password}` }
  })
    .then(data => {
      if (data.error === 'Unauthorized') {
        document.getElementById('sync-result').innerHTML = '<span style="color:var(--danger);">❌ Incorrect password.</span>';
        btn.textContent = 'Run sync';
        btn.disabled = false;
        return;
      }
      if (data.error) {
        document.getElementById('sync-result').innerHTML = `<span style="color:var(--danger);">❌ Error: ${data.error}</span>`;
        btn.textContent = 'Run sync';
        btn.disabled = false;
        return;
      }
      document.getElementById('sync-result').innerHTML = `
        <span style="color:var(--success);">✓ Sync complete</span><br>
        <span style="color:var(--text-2); font-size:12px;">
          ${data.newLoansAdded} new loan${data.newLoansAdded !== 1 ? 's' : ''} added &nbsp;·&nbsp;
          ${data.totalActive} total active in Metabase &nbsp;·&nbsp;
          ${data.existingInFirestore} already in app
        </span>
      `;
      btn.textContent = 'Done ✓';
      // Reload audits if on tear weight
      if (data.newLoansAdded > 0) {
        loadAudits().then(() => {
          if (document.getElementById('tare-weight').classList.contains('active')) {
            renderTWTable();
            populateBranchFilter();
          }
        }).catch(() => {}); // loadAudits() already showed its own toast; sync itself succeeded regardless
      }
    })
    .catch(err => {
      document.getElementById('sync-result').innerHTML = `<span style="color:var(--danger);">❌ Failed to connect. Check your network.</span>`;
      btn.textContent = 'Run sync';
      btn.disabled = false;
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
  if (id === 'new-audit') {
    loadUnauditedLoans();
  }
  if (id === 'tare-weight') {
    loadTareWeightSection();
  }
  if (id === 'all-audits') {
    loadAllAuditsSection();
  }
  if (id === 'settings') {
    document.getElementById('settings-locked').style.display = 'block';
    document.getElementById('settings-content').style.display = 'none';
    document.getElementById('settings-password-input').value = '';
    document.getElementById('settings-password-error').textContent = '';
  }
}

// Firestore's `in` operator accepts at most 30 values per query — this
// splits the active loan ID list into batches that size and runs them,
// merging every result into the shared auditStore by document ID (updating
// existing entries, adding new ones). Nothing is ever removed from
// auditStore here, and no other feature reading from it (All Audits, the
// re-audit reference lookup, branch/auditor dropdowns) is affected — they
// keep seeing exactly the same shared data, just kept fresh for whichever
// loans are currently active.
const FIRESTORE_IN_QUERY_LIMIT = 30;

async function loadActiveTareWeightAudits() {
  const loanIds = [...activeLoanIds];
  if (!loanIds.length) return;

  for (let i = 0; i < loanIds.length; i += FIRESTORE_IN_QUERY_LIMIT) {
    const batch = loanIds.slice(i, i + FIRESTORE_IN_QUERY_LIMIT);
    const freshAudits = await queryAuditsByLoanIdBatch(batch);
    freshAudits.forEach(fresh => {
      const idx = auditStore.findIndex(a => a.id === fresh.id);
      if (idx >= 0) auditStore[idx] = fresh;
      else auditStore.unshift(fresh);
    });
  }
}

// Named + exported to the global scope (not nested) specifically so the
// Retry button built by showSectionLoadError can call it back by name.
//
// This deliberately does NOT call the full loadAudits() (which downloads
// every audit ever written) — Tare Weight only ever displays currently
// active loans (~150 today), so re-downloading the entire, ever-growing
// history on every single visit to this tab was pure waste. loadActiveLoans()
// must resolve first since it's what determines which loan IDs the targeted
// query below actually needs to ask for.
function loadTareWeightSection() {
  showLoadingState('tw-tbody', 11, 'Loading from Firestore...');
  loadActiveLoans()
    .then(() => loadActiveTareWeightAudits())
    .then(() => { renderTWTable(); populateBranchFilter(); })
    .catch(err => showSectionLoadError(err, 'tw-tbody', 11, 'loadTareWeightSection'));
}

function loadAllAuditsSection() {
  allAuditsRenderedCount = ALL_AUDITS_PAGE_SIZE;
  showLoadingState('reports-tbody', 8, 'Loading from Firestore...');
  Promise.all([loadAudits(), loadActiveLoans()])
    .then(() => { renderAllAudits(); populateReportFilters(); })
    .catch(err => showSectionLoadError(err, 'reports-tbody', 8, 'loadAllAuditsSection'));
}

function showLoadingState(tbodyId, cols, msg) {
  document.getElementById(tbodyId).innerHTML =
    `<tr class="empty-row"><td colspan="${cols}">${msg}</td></tr>`;
}

// Used when a section's data fails to load. loadAudits()/loadActiveLoans()
// already show their own specific toast (Firestore vs Metabase) before
// rejecting — this does NOT show a second, generic one on top of that. Its
// job is the part that was actually missing: a persistent retry row
// replacing the stuck loading skeleton, so even someone who missed the
// toast (it auto-dismisses after 10s) isn't left staring at "0 results"
// that looks like real data but is actually a silent failure.
function showSectionLoadError(err, tbodyId, cols, retryFnName) {
  console.error(`Failed to load data for #${tbodyId}:`, err);
  const tbody = document.getElementById(tbodyId);
  if (tbody) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}" style="text-align:center; padding:40px 20px;">
      <div style="color:var(--danger); margin-bottom:12px; font-size:13px;">⚠ Couldn't load this data — check your connection.</div>
      <button class="btn-ghost" onclick="${retryFnName}()">↻ Retry</button>
    </td></tr>`;
  }
}

// ────────────────────────────
// NEW AUDIT — LOAN LOOKUP
// ────────────────────────────
document.getElementById('loan-id-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleFetch();
});

// ── Load unaudited loans — queries Metabase live ──
function loadUnauditedLoans() {
  document.getElementById('unaudited-loading').style.display = 'block';
  document.getElementById('unaudited-results').style.display = 'none';

  // Get all loan IDs that have been properly audited in Firestore
  const auditedIds = new Set(
    auditStore
      .filter(a => a.source !== 'metabase-sync' && a.auditor && a.auditor !== '—')
      .map(a => a.loanId)
  );

  // Query Metabase live for all active loans
  apiRequest('/api/active-loans')
    .then(data => {
      document.getElementById('unaudited-loading').style.display = 'none';

      if (data.error) {
        document.getElementById('unaudited-count').textContent = 'Error loading loans: ' + data.error;
        document.getElementById('unaudited-results').style.display = 'block';
        showErrorPopup(
          'Couldn\'t load loan data',
          'The list of active loans failed to load from Metabase. This may mean the Metabase API token is missing or invalid. Try refreshing — if it keeps happening, flag it to Vivek.',
          data.error
        );
        return;
      }

      // Only show loans that have never been audited through the app
      const unaudited = (data.loans || []).filter(l => !auditedIds.has(l.loanNumber));

      if (!unaudited.length) {
        document.getElementById('unaudited-count').textContent = 'All active loans have been audited.';
        document.getElementById('unaudited-tbody').innerHTML =
          '<tr class="empty-row"><td colspan="6">No unaudited loans found.</td></tr>';
        document.getElementById('unaudited-results').style.display = 'block';
        return;
      }

      document.getElementById('unaudited-count').textContent =
        unaudited.length + ' unaudited loan' + (unaudited.length !== 1 ? 's' : '') + ' — click any to begin audit';

      document.getElementById('unaudited-tbody').innerHTML = unaudited.map(l => `
        <tr class="row-clickable" onclick="selectBrowsedLoan('${l.loanNumber}')">
          <td><span class="loan-mono">${l.loanNumber}</span></td>
          <td style="color:var(--text-2)">${l.branch || '—'}</td>
          <td style="color:var(--text-2)">${l.city || '—'}</td>
          <td style="color:var(--text-2)">${l.loanDate ? formatDate(l.loanDate) : '—'}</td>
          <td>${l.loanAmount ? '₹' + Number(l.loanAmount).toLocaleString('en-IN') : '—'}</td>
          <td><span style="color:var(--gold); font-size:12px; font-weight:500;">Start audit →</span></td>
        </tr>
      `).join('');

      document.getElementById('unaudited-results').style.display = 'block';
    })
    .catch(err => {
      document.getElementById('unaudited-loading').style.display = 'none';
      document.getElementById('unaudited-count').textContent = 'Failed to load. Check your connection.';
      document.getElementById('unaudited-results').style.display = 'block';
      showErrorPopup(
        'Couldn\'t load loan data',
        'The list of active loans failed to load — check your internet connection and try refreshing.',
        err.message
      );
    });
}

// ── Lookup tab switcher ──
function switchLookupTab(tab) {
  const browse = document.getElementById('lookup-browse');
  const direct = document.getElementById('lookup-direct');
  const tabBrowse = document.getElementById('tab-browse');
  const tabDirect = document.getElementById('tab-direct');

  if (tab === 'browse') {
    browse.style.display = 'block';
    direct.style.display = 'none';
    tabBrowse.style.borderBottomColor = 'var(--gold)';
    tabBrowse.style.color = 'var(--gold)';
    tabDirect.style.borderBottomColor = 'transparent';
    tabDirect.style.color = 'var(--text-3)';
  } else {
    browse.style.display = 'none';
    direct.style.display = 'block';
    tabBrowse.style.borderBottomColor = 'transparent';
    tabBrowse.style.color = 'var(--text-3)';
    tabDirect.style.borderBottomColor = 'var(--gold)';
    tabDirect.style.color = 'var(--gold)';
    setTimeout(() => document.getElementById('loan-id-input').focus(), 100);
  }
}

// ── Browse loans by date range ──
function browseLoans() {
  const from = document.getElementById('browse-from').value;
  const to = document.getElementById('browse-to').value;
  const hint = document.getElementById('browse-hint');

  if (!from || !to) {
    hint.textContent = 'Please select both a from and to date.';
    hint.style.color = 'var(--danger)';
    return;
  }
  if (from > to) {
    hint.textContent = 'From date cannot be after To date.';
    hint.style.color = 'var(--danger)';
    return;
  }

  hint.textContent = 'Loading loans from Metabase...';
  hint.style.color = 'var(--text-3)';

  // Query Metabase via loan-lookup API for loans in date range
  apiRequest(`/api/browse-loans?from=${from}&to=${to}`)
    .then(data => {
      if (data.error) {
        hint.textContent = 'Error: ' + data.error;
        hint.style.color = 'var(--danger)';
        showErrorPopup(
          'Couldn\'t load loans',
          'Failed to fetch loans for this date range from Metabase. This may mean the Metabase API token is missing or invalid.',
          data.error
        );
        return;
      }

      const loans = data.loans || [];
      hint.textContent = '';

      if (!loans.length) {
        document.getElementById('browse-results').style.display = 'block';
        document.getElementById('browse-count').textContent = 'No loans found in this date range.';
        document.getElementById('browse-tbody').innerHTML =
          '<tr class="empty-row"><td colspan="5">No new pledge cards in this period.</td></tr>';
        return;
      }

      document.getElementById('browse-count').textContent = loans.length + ' loan' + (loans.length !== 1 ? 's' : '') + ' found';
      document.getElementById('browse-tbody').innerHTML = loans.map(l => `
        <tr class="row-clickable" onclick="selectBrowsedLoan('${l.loanNumber}')">
          <td><span class="loan-mono">${l.loanNumber}</span></td>
          <td style="color:var(--text-2)">${l.branch || '—'}</td>
          <td style="color:var(--text-2)">${l.loanDate ? formatDate(l.loanDate) : '—'}</td>
          <td>₹${Number(l.loanAmount).toLocaleString('en-IN')}</td>
          <td><span style="color:var(--gold); font-size:12px; font-weight:500;">Select →</span></td>
        </tr>
      `).join('');
      document.getElementById('browse-results').style.display = 'block';
    })
    .catch(err => {
      hint.textContent = 'Failed to load. Check your connection.';
      hint.style.color = 'var(--danger)';
      showErrorPopup(
        'Couldn\'t load loans',
        'Failed to fetch loans for this date range — check your internet connection and try again.',
        err.message
      );
    });
}

function selectBrowsedLoan(loanId) {
  if (currentUserRole === 'guest') return;
  // Switch to direct tab and populate loan ID, then fetch
  switchLookupTab('direct');
  document.getElementById('loan-id-input').value = loanId;
  handleFetch();
}

function handleFetch() {
  if (currentUserRole === 'guest') return;
  const id = document.getElementById('loan-id-input').value.trim().toUpperCase();
  const hint = document.getElementById('lookup-hint');
  if (!id) {
    hint.textContent = 'Please enter a loan ID.';
    hint.className = 'field-hint error';
    return;
  }

  // Wipe every loan-level field from whatever the previous audit left behind
  // BEFORE loading the new loan's data. This runs for every lookup — direct
  // entry or picking from the incremental/browse list — since both funnel
  // through this function. Deliberately does NOT touch loan-id-input (which
  // was just read above) or the audit date lock (session-wide, not per-loan).
  const twInput = document.getElementById('tw-input');
  if (twInput) twInput.value = '';
  const excessSel = document.getElementById('excess-select');
  if (excessSel) excessSel.value = 'No';
  const spuriousSel = document.getElementById('spurious-select');
  if (spuriousSel) spuriousSel.value = 'No';
  const excessAmt = document.getElementById('excess-amount-input');
  if (excessAmt) excessAmt.value = '';
  const excessGroup = document.getElementById('excess-amount-group');
  if (excessGroup) excessGroup.style.display = 'none';
  const remarksField = document.getElementById('audit-remarks');
  if (remarksField) remarksField.value = '';
  const packetIdField = document.getElementById('loan-packet-id');
  if (packetIdField) packetIdField.value = '';
  auditedOrnaments = [];

  hint.textContent = 'Loading ops data...';
  hint.className = 'field-hint';
  if (id === DEMO_LOAN_ID) { populateOpsCard(id, DEMO_OPS_DATA); return; }

  // ── METABASE LIVE LOOKUP ──
  apiRequest(`/api/loan-lookup?loanId=${encodeURIComponent(id)}`)
    .then(data => {
      if (data.error) {
        hint.textContent = data.error === 'Loan not found'
          ? `No loan found for "${id}" in the database.`
          : `Error fetching data: ${data.error}`;
        hint.className = 'field-hint error';
        hideAuditCards();
        if (data.error !== 'Loan not found') {
          showErrorPopup(
            'Couldn\'t fetch loan data',
            'The loan lookup failed to reach Metabase. This may mean the Metabase API token is missing or invalid.',
            data.error
          );
        }
        return;
      }
      populateOpsCard(id, {
        date: data.loanDate || '—',
        city: data.city || '—',
        branch: data.branch || '—',
        agent: '—',
        maker: '—',
        packet: '—',
        amount: (typeof data.loanAmount === 'number') ? data.loanAmount : null,
        ornaments: (data.ornaments || []).map(o => ({
          type: o.type,
          count: o.count,
          gw: o.gw,
          stoneDed: o.stoneDed,
          karat: o.karat,
          nw: o.nw,
          hallmark: '—',
          goldId: o.goldId
        }))
      });
    })
    .catch(err => {
      hint.textContent = 'Failed to connect to database. Check your connection.';
      hint.className = 'field-hint error';
      console.error(err);
      showErrorPopup(
        'Couldn\'t fetch loan data',
        'The loan lookup failed — check your internet connection and try again.',
        err.message
      );
    });
}

function populateOpsCard(loanId, data) {
  currentLoanId = loanId;
  currentLoanBookingDate = (data && data.date && data.date !== '—') ? data.date : null;
  currentLoanAmount = (data && typeof data.amount === 'number') ? data.amount : null;
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
  document.getElementById('f-date').textContent = formatDate(d.date) || '—';
  document.getElementById('f-city').textContent = d.city || '—';
  document.getElementById('f-branch').textContent = d.branch || '—';
  document.getElementById('f-agent').textContent = d.agent || '—';
  document.getElementById('f-maker').textContent = d.maker || '—';
  document.getElementById('f-packet').textContent = d.packet || '—';
  document.getElementById('f-amount').textContent =
    (typeof d.amount === 'number') ? '₹' + d.amount.toLocaleString('en-IN') : '—';
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
  renderAllOrnamentCards();
}

// ── Re-audit reference matching ──
// Finds the most recent PAST audit of this exact loan (there may be more
// than one if it's been re-audited before) — excludes metabase-sync
// placeholders, which aren't real audits.
function getPreviousAuditForLoan(loanId) {
  const past = auditStore.filter(a =>
    a.loanId === loanId && a.source !== 'metabase-sync' && a.auditor && a.auditor !== '—'
  );
  if (!past.length) return null;
  return past.reduce((latest, a) => (!latest || a.date > latest.date) ? a : latest, null);
}

// Matches one CURRENT ornament against the previous audit's ornament list.
//   'exact'       — previous record has the same goldId. Checked FIRST,
//                    across ALL previous ornaments regardless of type name —
//                    goldId is a stable database identifier even if Metabase's
//                    type naming drifts over time (e.g. an old record says
//                    "Stud" while a live fetch now returns "Studs" — a real
//                    case found in production). Type name is only used as a
//                    fallback signal, never as a gate that blocks a real
//                    goldId match from being found.
//   'unambiguous' — no goldId on the old record (it predates this feature),
//                    but only one past entry shares this ornament's type
//                    name, so there's nothing to actually be ambiguous about.
//   'renamed'     — no goldId, and no past entry shares this exact type
//                    name — but exactly one past entry has the same
//                    Pledge Card weight (a fixed physical measurement that
//                    doesn't change even if a type label gets renamed).
//                    Treated the same as 'unambiguous' for autofill purposes,
//                    just labeled differently so it's clear what happened.
//   'ambiguous'   — multiple past entries share this type name (or weight)
//                    and none carry a goldId to disambiguate with.
//                    Deliberately NOT resolved by guessing — a wrong guess
//                    dressed up as authoritative is worse than no autofill
//                    at all. All candidates are surfaced instead.
//   'none'        — no past audit, or genuinely nothing comparable found.
function closeEnoughWeight(a, b) {
  const x = parseFloat(a), y = parseFloat(b);
  return !isNaN(x) && !isNaN(y) && Math.abs(x - y) < 0.001;
}
function matchPreviousOrnament(currentOrnament, previousOrnaments) {
  if (!previousOrnaments || !previousOrnaments.length) return { mode: 'none' };

  if (currentOrnament.goldId != null) {
    const exact = previousOrnaments.find(p => p.goldId != null && String(p.goldId) === String(currentOrnament.goldId));
    if (exact) return { mode: 'exact', matched: exact };
  }

  const sameType = previousOrnaments.filter(p => p.type === currentOrnament.type);
  if (sameType.length === 1) return { mode: 'unambiguous', matched: sameType[0] };
  if (sameType.length > 1) return { mode: 'ambiguous', candidates: sameType };

  // No past entry shares this exact type name at all — try matching by
  // Pledge Card weight across ALL past entries instead, in case the type
  // label itself has been renamed since the old audit.
  const weightMatches = previousOrnaments.filter(p => closeEnoughWeight(p.gwPC, currentOrnament.gw));
  if (weightMatches.length === 1) return { mode: 'renamed', matched: weightMatches[0] };
  if (weightMatches.length > 1) return { mode: 'ambiguous', candidates: weightMatches };

  return { mode: 'none' };
}

function renderAllOrnamentCards() {
  const container = document.getElementById('ornament-cards-container');
  if (!container) return;

  const prevAudit = currentLoanId ? getPreviousAuditForLoan(currentLoanId) : null;
  const prevOrnaments = prevAudit ? prevAudit.ornaments : null;

  container.innerHTML = currentOrnaments.map((o, i) => {
    const match = matchPreviousOrnament(o, prevOrnaments);
    const m = match.matched;

    // Values to prefill — only for exact/unambiguous matches. Ambiguous and
    // none leave every field genuinely blank, exactly as before this feature.
    const preCount = m ? (m.countAudit ?? m.count ?? '') : '';
    const preGw = m ? (m.gwAudit || '') : '';
    const preStone = m ? (m.stoneDedAudit || '') : '';
    const preKarat = m ? (m.karatAudit || '') : '';
    const preHallmark = m ? (m.hallmark || '') : '';

    let referenceBanner = '';
    if (match.mode === 'exact' || match.mode === 'unambiguous') {
      referenceBanner = `
        <div style="background:rgba(201,149,42,0.08); border:1px solid var(--gold); border-radius:var(--r-sm); padding:8px 12px; margin-bottom:14px; font-size:12px; color:var(--text-2);">
          ↻ Carried over from previous audit (${formatDate(prevAudit.date)}) — verify against today's measurement, edit if it's changed.
        </div>`;
    } else if (match.mode === 'renamed') {
      referenceBanner = `
        <div style="background:rgba(201,149,42,0.08); border:1px solid var(--gold); border-radius:var(--r-sm); padding:8px 12px; margin-bottom:14px; font-size:12px; color:var(--text-2);">
          ↻ Carried over from previous audit (${formatDate(prevAudit.date)}) — matched by weight, since this was recorded as "${m.type}" last time (now "${o.type}"). Verify against today's measurement, edit if it's changed.
        </div>`;
    } else if (match.mode === 'ambiguous') {
      referenceBanner = `
        <div style="background:rgba(220,60,60,0.08); border:1px solid var(--danger-border); border-radius:var(--r-sm); padding:8px 12px; margin-bottom:14px; font-size:12px; color:var(--text-2);">
          ⚠ ${match.candidates.length} previous "${o.type}" entries found from ${formatDate(prevAudit.date)} — not auto-filled since it's unclear which matches which physical piece. Compare manually:
          <div style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
            ${match.candidates.map((c, ci) => `
              <div style="font-size:11.5px; color:var(--text-3);">
                #${ci + 1} — GW: ${c.gwAudit || '—'}g, Stone: ${c.stoneDedAudit || '—'}g, Karat: ${c.karatAudit || '—'}kt, Hallmark: ${c.hallmark || '—'}
              </div>
            `).join('')}
          </div>
        </div>`;
    }

    return `
    <div style="border:1px solid var(--border); border-radius:var(--r-sm); padding:16px 20px; margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
        <div style="font-size:15px; font-weight:600; color:var(--text-1);">${o.type}</div>
        <div style="display:flex; align-items:center; gap:6px;">
          <label style="font-size:12px; color:var(--text-3); white-space:nowrap;">Count</label>
          <input type="number" min="1" step="1" class="fi" id="aud-count-${i}" placeholder="—" value="${preCount}"
            style="width:64px; height:28px; font-size:13px; text-align:center;" />
        </div>
      </div>
      ${referenceBanner}
      <div class="form-grid-3">
        <div class="fg"><label class="fl">GW as per audit (g)</label>
          <input type="number" step="0.01" class="fi" id="aud-gw-${i}" placeholder="0.00" value="${preGw}"
            oninput="autoCalcNWi(${i})" /></div>
        <div class="fg"><label class="fl">Stone deduction (g)</label>
          <input type="number" step="0.01" class="fi" id="aud-stone-${i}" placeholder="0.00" value="${preStone}"
            oninput="autoCalcNWi(${i})" /></div>
        <div class="fg"><label class="fl">Karat</label>
          <input type="number" step="1" class="fi" id="aud-karat-${i}" placeholder="e.g. 22" value="${preKarat}"
            oninput="autoCalcNWi(${i})" /></div>
        <div class="fg">
          <label class="fl">NW (g) <span style="font-size:10px; color:var(--gold); font-weight:500;">Auto-calculated</span></label>
          <input type="number" step="0.01" class="fi" id="aud-nw-${i}" placeholder="0.00" readonly
            style="background:var(--surface-2); cursor:not-allowed; font-weight:600;" /></div>
        <div class="fg"><label class="fl">Hallmark</label>
          <select class="fs" id="aud-hallmark-${i}">
            <option value="" ${preHallmark === '' ? 'selected' : ''}>Select</option>
            <option ${preHallmark === 'Yes' ? 'selected' : ''}>Yes</option>
            <option ${preHallmark === 'No' ? 'selected' : ''}>No</option>
          </select></div>
        <div class="fg"><label class="fl">Spurious</label>
          <select class="fs" id="aud-spurious-${i}">
            <option value="No">No</option><option value="Yes">Yes</option>
          </select></div>
      </div>
    </div>
  `;
  }).join('');

  // NW needs recalculating for any card that was just prefilled, same as if
  // the auditor had typed those values in by hand.
  currentOrnaments.forEach((o, i) => autoCalcNWi(i));
}

function autoCalcNWi(i) {
  const gw = parseFloat(document.getElementById('aud-gw-' + i)?.value) || 0;
  const stone = parseFloat(document.getElementById('aud-stone-' + i)?.value) || 0;
  const karatRaw = document.getElementById('aud-karat-' + i)?.value;
  const nwEl = document.getElementById('aud-nw-' + i);
  if (!nwEl) return;

  // Net Weight = (Gross Weight − Stone Deduction) × (Actual Karat ÷ 22)
  // Deliberately left blank until the auditor actually enters a karat value —
  // no default/fallback, since a silently-assumed karat was confusing auditors
  // into thinking a value had been calculated when it hadn't really been.
  const karat = parseFloat(karatRaw);
  if (karatRaw === '' || karatRaw == null || isNaN(karat) || karat <= 0) {
    nwEl.value = '';
    return;
  }

  // Below 18kt, Net Weight is forced to 0 regardless of GW/Stone.
  if (karat < 18) {
    nwEl.value = '0.00';
    return;
  }

  const answer = gw - stone;
  nwEl.value = Math.max(0, answer * (karat / 22)).toFixed(2);
}

function collectAndReview() {
  // Mandatory-fields check — every ornament's count, audited GW, stone
  // deduction, karat, and hallmark must be filled in before moving on.
  // "New/old packet ID" and "Remarks" are deliberately excluded: the packet
  // ID field's own placeholder says "Leave blank if unchanged", and remarks
  // are freeform notes that are legitimately often blank — forcing those
  // would fight their own designed purpose. Stone deduction of "0" is a
  // valid, filled value; only a genuinely empty field fails this check.
  for (let i = 0; i < currentOrnaments.length; i++) {
    const count = document.getElementById('aud-count-' + i)?.value;
    const gw = document.getElementById('aud-gw-' + i)?.value;
    const stone = document.getElementById('aud-stone-' + i)?.value;
    const karat = document.getElementById('aud-karat-' + i)?.value;
    const hallmark = document.getElementById('aud-hallmark-' + i)?.value;
    if (count === '' || count == null || gw === '' || gw == null || stone === '' || stone == null || karat === '' || karat == null || !hallmark) {
      showErrorPopup('All parameters must be filled', `Every field for "${currentOrnaments[i].type}" (Ornament ${i + 1}) — count, GW, stone deduction, karat, and hallmark — must be filled in before continuing.`);
      return;
    }
  }

  // Excess amount is only mandatory when excess funding is marked "Yes".
  const excessVal = document.getElementById('excess-select')?.value;
  const excessAmt = document.getElementById('excess-amount-input')?.value;
  if (excessVal === 'Yes' && (excessAmt === '' || excessAmt == null)) {
    showErrorPopup('All parameters must be filled', 'Excess funding is marked "Yes" — the excess amount must be entered before continuing.');
    return;
  }

  auditedOrnaments = currentOrnaments.map((o, i) => ({
    type: o.type,
    count: o.count,
    goldId: o.goldId ?? null,
    gwPC: o.gw,
    stoneDedPC: o.stoneDed,
    karatPC: o.karat,
    nwPC: o.nw,
    gwAudit: document.getElementById('aud-gw-' + i)?.value || '',
    stoneDedAudit: document.getElementById('aud-stone-' + i)?.value || '',
    karatAudit: document.getElementById('aud-karat-' + i)?.value || '',
    nwAudit: document.getElementById('aud-nw-' + i)?.value || '',
    hallmark: document.getElementById('aud-hallmark-' + i)?.value || '',
    countAudit: parseInt(document.getElementById('aud-count-' + i)?.value) || null,
    spurious: document.getElementById('aud-spurious-' + i)?.value || 'No',
  }));
  showAuditPreview();
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
  const packetId = document.getElementById('loan-packet-id')?.value || '';

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
                ${o.gwAudit && Math.abs(parseFloat(o.gwAudit) - parseFloat(o.gwPC)) > TW_THRESHOLD ? '<span style="color:var(--danger); font-size:11px;">⚠ diff</span>' : ''}
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
                ${o.nwAudit && Math.abs(parseFloat(o.nwAudit) - parseFloat(o.nwPC)) > TW_THRESHOLD ? '<span style="color:var(--danger); font-size:11px;">⚠ diff</span>' : ''}
              </div>
            </div>
          </div>
          ${o.hallmark ? `<div style="margin-top:8px; font-size:12px;"><span style="color:var(--text-3);">Hallmark:</span> ${o.hallmark}</div>` : ''}
          ${o.spurious === 'Yes' ? `<div style="margin-top:4px; font-size:12px; color:var(--danger); font-weight:500;">⚠ Spurious</div>` : ''}
        </div>
      `).join('')}
    </div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:12px;">
      <div><div style="font-size:11px; color:var(--text-3);">Excess funding</div><div style="font-size:14px; font-weight:600; color:${excess === 'Yes' ? 'var(--danger)' : 'inherit'}">${excess}${excessAmt ? ' — ₹' + Number(excessAmt).toLocaleString('en-IN') : ''}</div></div>
      <div><div style="font-size:11px; color:var(--text-3);">Spurious</div><div style="font-size:14px; font-weight:600; color:${spurious === 'Yes' ? 'var(--danger)' : 'inherit'}">${spurious}</div></div>
      <div><div style="font-size:11px; color:var(--text-3);">New / old packet ID</div><div style="font-size:14px; font-weight:600;">${escapeHtml(packetId) || '—'}</div></div>
    </div>
    ${remarks ? `<div style="padding:10px 14px; background:var(--surface-2); border:1px solid var(--border); border-radius:var(--r-sm); font-size:13px;">${escapeHtml(remarks)}</div>` : ''}
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
  renderAllOrnamentCards();
  setStep(2);
}

// ────────────────────────────
// AUTO CALCULATE NW
// ────────────────────────────
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
  if (currentUserRole === 'guest') return;

  const tw = parseFloat(document.getElementById('tw-input').value);
  if (!currentLoanId) { showErrorPopup('No loan loaded', 'Please look up a loan before submitting an audit.'); return; }
  if (isNaN(tw) || tw <= 0) { showErrorPopup('Tare weight required', 'Please enter a valid tare weight before submitting.'); return; }

  // Tare weight (the whole sealed packet, gold + packaging) can physically
  // never weigh less than the gold alone. gwAudit values are already totals
  // per ornament line (Pledge Card convention — not per-piece), so they're
  // summed directly, never multiplied by count.
  const totalAuditedGW = auditedOrnaments.reduce((sum, o) => {
    const gw = parseFloat(o.gwAudit);
    return sum + (isNaN(gw) ? 0 : gw);
  }, 0);
  if (tw < totalAuditedGW) {
    showErrorPopup('TW cannot be lesser than GW', `Tare weight (${tw}g) is less than the total gross weight audited (${totalAuditedGW.toFixed(2)}g). A sealed packet can never weigh less than the gold inside it — please recheck the tare weight or the audited GW values.`);
    return;
  }

  const audit = {
    loanId: currentLoanId,
    date: document.getElementById('audit-date-field')?.value || new Date().toISOString().split('T')[0],
    auditor: currentUser ? (currentUser.email.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase())) : (document.getElementById('auditor-name-display').textContent || 'Auditor'),
    tw,
    excessFunding: document.getElementById('excess-select').value,
    excessAmount: parseFloat(document.getElementById('excess-amount-input')?.value) || 0,
    spurious: auditedOrnaments.some(o => o.spurious === 'Yes') ? 'Yes' : 'No',
    spuriousOrnaments: auditedOrnaments.filter(o => o.spurious === 'Yes').map(o => o.type),
    city: document.getElementById('f-city').textContent,
    branch: document.getElementById('f-branch').textContent,
    loanAmount: currentLoanAmount,
    loanBookingDate: currentLoanBookingDate || null,
    remarks: document.getElementById('audit-remarks')?.value || '',
    newPacketId: document.getElementById('loan-packet-id')?.value || '',
    ornaments: auditedOrnaments,
    submittedAt: new Date().toISOString(),
  };

  const btn = document.getElementById('submit-audit-btn');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  saveAudit(audit)
    .then(() => {
      document.getElementById('submit-row').classList.add('hidden');
      document.getElementById('success-bar').classList.remove('hidden');
      setStep(4);
      // Refresh All Audits in background so it's up to date when navigated to
      populateReportFilters();
      renderAllAudits();
      // Delete the metabase-sync placeholder for this loan (no longer needed)
      const pendingDocId = currentLoanId + '_pending';
      deleteAuditDoc(pendingDocId)
        .then(() => console.log('Cleaned up placeholder:', pendingDocId))
        .catch(() => {}); // Silent — placeholder may not exist, that's fine
    })
    .catch(err => {
      showErrorPopup(
        'Audit not saved',
        'The audit could not be saved to Firestore. Check your connection and try submitting again — your entered data is still on this page.',
        err.message
      );
      console.error(err);
      btn.innerHTML = 'Submit audit <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      btn.disabled = false;
    });
}

function clearForm() {
  if (currentUserRole === 'guest') return;

  // Reset state
  currentLoanId = null;
  currentLoanBookingDate = null;
  currentLoanAmount = null;
  currentOrnaments = [];
  currentOrnamentIndex = 0;
  auditedOrnaments = [];

  // Reset audit date
  initAuditDate();
  document.getElementById('audit-date-field').setAttribute('readonly', true);
  document.getElementById('audit-date-field').style.borderColor = '';
  document.getElementById('audit-date-lock-btn').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Edit';
  document.getElementById('audit-date-lock-btn').style.color = '';
  document.getElementById('audit-date-lock-btn').style.borderColor = '';
  document.getElementById('audit-date-hint').textContent = 'Locked — click Edit to change';
  document.getElementById('audit-date-hint').style.color = '';

  // Reset loan lookup
  const loanInput = document.getElementById('loan-id-input');
  if (loanInput) loanInput.value = '';
  const hint = document.getElementById('lookup-hint');
  if (hint) { hint.textContent = 'Press Enter or click Fetch to load ops data for this loan.'; hint.className = 'field-hint'; }

  // Reset tare weight + loan level fields
  const twInput = document.getElementById('tw-input');
  if (twInput) twInput.value = '';
  const excessSel = document.getElementById('excess-select');
  if (excessSel) excessSel.value = 'No';
  const spuriousSel = document.getElementById('spurious-select');
  if (spuriousSel) spuriousSel.value = 'No';
  const excessGroup = document.getElementById('excess-amount-group');
  if (excessGroup) excessGroup.style.display = 'none';
  const remarksField = document.getElementById('audit-remarks');
  if (remarksField) remarksField.value = '';
  const packetIdField = document.getElementById('loan-packet-id');
  if (packetIdField) packetIdField.value = '';

  // Clear ornament cards container
  const container = document.getElementById('ornament-cards-container');
  if (container) container.innerHTML = '';

  // Reset submit button
  const btn = document.getElementById('submit-audit-btn');
  if (btn) {
    btn.innerHTML = 'Submit audit <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.disabled = false;
  }

  // Hide all cards and go back to step 1
  hideAuditCards();
  document.getElementById('success-bar').classList.add('hidden');
  setStep(1);
}

// Used by the "Start next audit →" button after a successful submission.
// Fully resets the form (same as clearForm), then — instead of leaving the
// auditor on whichever tab they last used (often the blank "Enter loan ID"
// screen) — switches to the incremental "Browse by date" list and reloads
// it immediately, so the loan just audited is already gone without needing
// a manual page refresh.
function startNextAudit() {
  clearForm();
  switchLookupTab('browse');
  loadUnauditedLoans();
}

// ────────────────────────────
// TEAR WEIGHT TABLE
// ────────────────────────────
const TW_PAGE_SIZE = 15;
let twCurrentPage = 0;

// ── Pure compute functions for the Tare Weight table ──
// Extracted from renderTWTable() below with NO change in behavior — same
// inputs produce the exact same outputs as before. This separates "what
// loans to show, in what order, and what the summary counts are" (pure
// logic, no DOM) from "how to draw that on screen" (renderTWTable itself).
// Two direct benefits: these functions can now be unit-tested on their own
// (see tests/tw-counters-compute.test.js), and if the UI is ever rebuilt in
// a different framework, only the rendering needs to be redone — these
// rules don't need to be re-derived or re-verified from scratch.

function computeAuditedLoansForTW(auditStore, activeLoanIds) {
  // Only show loans that have a tare weight recorded — properly audited.
  // Deduplicate by loan ID — keep most recent audit per loan.
  const audited = auditStore.filter(a => a.tw !== null && a.tw !== undefined && a.source !== 'metabase-sync' && activeLoanIds.has(a.loanId));
  const loanMap = {};
  audited.forEach(a => {
    if (!loanMap[a.loanId] || a.date > loanMap[a.loanId].date) {
      loanMap[a.loanId] = a;
    }
  });
  return Object.values(loanMap);
}

function sortTWLoans(loans, todayStr) {
  // Loans whose tare weight was already re-checked TODAY sink to the very
  // bottom of the list, below everything else — regardless of original
  // audit date. This uses twUpdatedAt, which is saved to Firestore the
  // moment "Save" succeeds, so it survives a refresh, a crash, or logging
  // back in later — not just an in-memory flag that would reset and
  // confuse the auditor if the browser hiccups mid-session.
  return [...loans].sort((a, b) => {
    const aDoneToday = !!(a.twUpdatedAt && a.twUpdatedAt.slice(0, 10) === todayStr);
    const bDoneToday = !!(b.twUpdatedAt && b.twUpdatedAt.slice(0, 10) === todayStr);
    if (aDoneToday !== bDoneToday) return aDoneToday ? 1 : -1;
    if (aDoneToday && bDoneToday) {
      // Both saved today — order by WHEN they were saved (ascending), so the
      // most recently saved loan is always the true last item overall, not
      // just "somewhere in today's block" based on its original audit date.
      return (a.twUpdatedAt || '').localeCompare(b.twUpdatedAt || '');
    }
    // Not yet checked today — sort by LOAN BOOKING DATE (when the loan
    // actually entered Oro's system), OLDEST first, newest last. This is
    // deliberately different from audit date (when the team happened to
    // audit it) per Rijin's request — page 1 shows the oldest loans in the
    // system, later pages progressively newer ones. Loans with no booking
    // date on record (rare, mostly historical) sort to the very FRONT of
    // this group, ahead of even the oldest known date.
    if (!a.loanBookingDate && !b.loanBookingDate) return 0;
    if (!a.loanBookingDate) return -1;
    if (!b.loanBookingDate) return 1;
    return (a.loanBookingDate || '').localeCompare(b.loanBookingDate || '');
  });
}

function computeTWCounters(loans, twCurrentValues, todayStr, twThreshold, getLoanStatusFn) {
  const checked = Object.keys(twCurrentValues).length;
  const flagged = Object.entries(twCurrentValues).filter(([id, v]) => {
    const a = loans.find(x => x.loanId === id);
    return a && a.tw != null && Math.abs(v - a.tw) > twThreshold;
  }).length;
  const matched = checked - flagged;
  const pendingCount = loans.filter(a => getLoanStatusFn(a.loanId) === 'pending').length;
  // Progress counter — deliberately NOT a manual "start/end session" toggle.
  // completedToday/remainingToday are derived fresh from twUpdatedAt every
  // single render, straight from Firestore-backed data (loaded via
  // loadAudits() on page load) — not from any in-memory "session" flag. That
  // means a refresh, a dropped connection, or a break mid-day changes
  // nothing: reopening the page recomputes the exact same true numbers,
  // because nothing was ever being "remembered" client-side to lose.
  const completedToday = loans.filter(a => a.twUpdatedAt && a.twUpdatedAt.slice(0, 10) === todayStr).length;
  const remainingToday = loans.length - completedToday;
  return { checked, flagged, matched, pendingCount, completedToday, remainingToday };
}

function renderTWTable(search = '', filter = twFilter) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const loans = sortTWLoans(computeAuditedLoansForTW(auditStore, activeLoanIds), todayStr);
  const { checked, flagged, matched, pendingCount, completedToday, remainingToday } =
    computeTWCounters(loans, twCurrentValues, todayStr, TW_THRESHOLD, getLoanStatus);

  document.getElementById('tw-stat-row').innerHTML = `
    <div class="stat-chip">${loans.length} loan${loans.length !== 1 ? 's' : ''}</div>
    <div class="stat-chip gold">${remainingToday} remaining today</div>
    <div class="stat-chip success">${completedToday} completed today</div>
    <div class="stat-chip" style="background:var(--warning-bg); border-color:var(--warning-border); color:var(--warning);">${pendingCount} pending</div>
    <div class="stat-chip success">${matched} matched</div>
    <div class="stat-chip danger">${flagged} flagged</div>
  `;

  const branchFilter = document.getElementById('tw-branch-filter')?.value || '';

  const filtered = loans.filter(a => {
    const s = search.toLowerCase();
    const matchSearch = !s || a.loanId.toLowerCase().includes(s);
    const matchBranch = !branchFilter || a.branch === branchFilter;
    const cv = twCurrentValues[a.loanId];
    const hasCv = cv !== undefined;
    const isFlagged = hasCv && a.tw != null && Math.abs(cv - a.tw) > TW_THRESHOLD;
    const isMatched = hasCv && !isFlagged;
    const loanSt = getLoanStatus(a.loanId);
    if (filter === 'pending') return matchSearch && matchBranch && loanSt === 'pending';
    if (filter === 'matched') return matchSearch && matchBranch && isMatched;
    if (filter === 'flagged') return matchSearch && matchBranch && isFlagged;
    return matchSearch && matchBranch;
  });

  const tbody = document.getElementById('tw-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:40px 20px; color:var(--text-3); font-size:13px;">${loans.length === 0 ? '📋 No tare weight records yet — audits with tare weight will appear here.' : '🔍 No loans match the current filter. Try adjusting the branch or status filter.'}</td></tr>`;
    renderTWPagination(0, 0);
    return;
  }

  // Pagination
  window._lastFilteredTW = filtered;
  const totalPages = Math.ceil(filtered.length / TW_PAGE_SIZE);
  if (twCurrentPage >= totalPages) twCurrentPage = 0;
  const pageStart = twCurrentPage * TW_PAGE_SIZE;
  const pageLoans = filtered.slice(pageStart, pageStart + TW_PAGE_SIZE);

  tbody.innerHTML = pageLoans.map(a => {
    const cv = twCurrentValues[a.loanId];
    const hasCv = cv !== undefined;
    const isFlagged = hasCv && a.tw != null && Math.abs(cv - a.tw) > TW_THRESHOLD;
    const isMatched = hasCv && !isFlagged;
    const diff = hasCv && a.tw != null ? (cv - a.tw).toFixed(2) : '—';
    const diffDisplay = hasCv && a.tw != null
      ? `<span style="color:${isFlagged ? 'var(--danger)' : 'var(--success)'}; font-weight:500">${parseFloat(diff) > 0 ? '+' : ''}${diff}</span>`
      : '<span style="color:var(--text-3)">—</span>';
    let badge = '';
    if (isFlagged) badge = '<span style="color:var(--danger); font-weight:500;">⚠ Mismatch</span>';
    else if (isMatched) badge = '<span style="color:var(--success); font-weight:500;">✓ Match</span>';
    if ((isFlagged || isMatched) && a.twRecheckedBy) {
      badge += `<div style="font-size:11px; color:var(--text-3); margin-top:2px;">by ${a.twRecheckedBy}</div>`;
    }

    // _twSubmitted is a transient, client-side-only flag — it is NEVER
    // written to Firestore (see submitTW below: the updateAuditDoc() call
    // only persists tw / twUpdatedAt / twRecheckedBy). It exists purely to
    // disable this row's input and show "✓ Saved" for the rest of the
    // CURRENT session immediately after a successful save, preventing an
    // accidental double-submit. It is expected to reset (become undefined)
    // on page reload by design — twUpdatedAt/twRecheckedBy remain the real,
    // persistent record of a completed recheck (see the rightmost column).
    const isSubmitted = a._twSubmitted === true;

    const loanStatus = getLoanStatus(a.loanId);
    const statusBadgeMap = {
      pending: '<span style="color:var(--warning); font-weight:500;">⏳ Pending</span>',
      audited: ''
    };

    return `
      <tr class="${isFlagged ? 'flagged' : isMatched ? 'matched' : ''}" data-lid="${a.loanId}">
        <td><span class="loan-mono">${a.loanId}</span> ${statusBadgeMap[loanStatus] || ''}</td>
        <td style="color:var(--text-2)">${a.branch || '—'}</td>
        <td style="color:var(--text-2)">${formatDate(a.date)}</td>
        <td style="color:var(--text-2)">${a.loanBookingDate ? formatDate(a.loanBookingDate) : '—'}</td>
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
        <td style="border-left:2px solid var(--border-2); background:rgba(255,255,255,0.02); padding-left:16px; color:var(--text-2);">
          ${a.twUpdatedAt ? formatDate(a.twUpdatedAt.slice(0, 10)) : '—'}
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
  // Update just this row's diff/status display in place — NOT a full table
  // re-render. Rebuilding the whole table here (via applyTWFilters) destroys
  // and recreates every row's DOM, including the Save button the auditor is
  // often mid-click on (since clicking Save first blurs this input) — which
  // is exactly why Save previously required two clicks to register.
  updateTWRowDisplay(loanId);
}

function updateTWRowDisplay(loanId) {
  const row = document.querySelector(`tr[data-lid="${loanId}"]`);
  if (!row) return;
  const audit = auditStore.find(a => a.loanId === loanId);
  if (!audit) return;

  const cv = twCurrentValues[loanId];
  const hasCv = cv !== undefined;
  const isFlagged = hasCv && audit.tw != null && Math.abs(cv - audit.tw) > TW_THRESHOLD;
  const isMatched = hasCv && !isFlagged;
  const diff = hasCv && audit.tw != null ? (cv - audit.tw).toFixed(2) : '—';
  const diffDisplay = hasCv && audit.tw != null
    ? `<span style="color:${isFlagged ? 'var(--danger)' : 'var(--success)'}; font-weight:500">${parseFloat(diff) > 0 ? '+' : ''}${diff}</span>`
    : '<span style="color:var(--text-3)">—</span>';
  let badge = '';
  if (isFlagged) badge = '<span style="color:var(--danger); font-weight:500;">⚠ Mismatch</span>';
  else if (isMatched) badge = '<span style="color:var(--success); font-weight:500;">✓ Match</span>';

  row.className = isFlagged ? 'flagged' : isMatched ? 'matched' : '';
  const cells = row.querySelectorAll('td');
  if (cells[7]) cells[7].innerHTML = diffDisplay;
  if (cells[8]) cells[8].innerHTML = badge;
  const inputEl = document.getElementById('tw-cell-' + loanId);
  if (inputEl) inputEl.classList.toggle('mismatch', isFlagged);
}

function submitTW(loanId) {
  if (currentUserRole === 'guest') return;

  const newTW = twCurrentValues[loanId];
  if (!newTW || isNaN(newTW) || newTW <= 0) {
    showErrorPopup('Tare weight required', 'Please enter a tare weight value before saving.');
    return;
  }

  const audit = auditStore.find(a => a.loanId === loanId);
  if (!audit || !audit.id) { showErrorPopup('Loan not found', 'This loan could not be found in the audit records.'); return; }

  const btn = document.querySelector(`tr[data-lid="${loanId}"] button`);
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  const updatedAt = new Date().toISOString();
  const recheckedBy = currentUser
    ? currentUser.email.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : (document.getElementById('auditor-name-display')?.textContent || 'Auditor');
  updateAuditDoc(audit.id, { tw: newTW, twUpdatedAt: updatedAt, twRecheckedBy: recheckedBy })
    .then(() => {
      audit.tw = newTW;
      audit.twUpdatedAt = updatedAt;
      audit.twRecheckedBy = recheckedBy;
      audit._twSubmitted = true;
      delete twCurrentValues[loanId];
      applyTWFilters();
    })
    .catch(err => {
      console.error('Failed to save TW:', err);
      showErrorPopup(
        'Tare weight not saved',
        'The tare weight could not be saved to Firestore. Check your connection and try again.',
        err.message
      );
      if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
    });
}

function applyTWFilters(resetPage = false) {
  if (resetPage) twCurrentPage = 0;
  const search = document.getElementById('tw-search-input')?.value || '';
  renderTWTable(search, twFilter);
}

function clearTWFilters() {
  const branchSel = document.getElementById('tw-branch-filter');
  const searchInput = document.getElementById('tw-search-input');
  if (branchSel) branchSel.value = '';
  if (searchInput) searchInput.value = '';
  renderTWTable('', twFilter);
}

function setTWFilter(f, btn) {
  twFilter = f;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyTWFilters();
}

function getAllBranches() {
  const fromAudits = auditStore.map(a => a.branch).filter(b => b && b !== '—');
  return [...new Set([...registeredBranches, ...fromAudits])].sort();
}

function populateBranchFilter() {
  const branches = getAllBranches();
  const sel = document.getElementById('tw-branch-filter');
  if (!sel) return;
  sel.innerHTML = '<option value="">All branches</option>' +
    branches.map(b => '<option value="' + b + '">' + b + '</option>').join('');
}

// ────────────────────────────
// DEVIATION HELPERS
// ────────────────────────────
function hasWeightMismatch(audit) {
  if (!audit.ornaments || !audit.ornaments.length) return false;
  return audit.ornaments.some(o => {
    const gwPc = parseFloat(o.gwPC);
    const gwAudit = parseFloat(o.gwAudit);
    if (isNaN(gwPc) || isNaN(gwAudit)) return false;
    return Math.abs(gwPc - gwAudit) > 0.03;
  });
}

function hasCountMismatch(audit) {
  if (!audit.ornaments || !audit.ornaments.length) return false;
  return audit.ornaments.some(o => {
    if (o.countAudit === null || o.countAudit === undefined) return false;
    return o.countAudit !== o.count;
  });
}

function hasDeviation(audit, type) {
  switch (type) {
    case 'excess':  return audit.excessFunding === 'Yes';
    case 'spurious': return audit.spurious === 'Yes';
    case 'weight':  return hasWeightMismatch(audit);
    case 'count':   return hasCountMismatch(audit);
    case 'any':     return audit.excessFunding === 'Yes' || audit.spurious === 'Yes' || hasWeightMismatch(audit) || hasCountMismatch(audit);
    case 'none':    return audit.excessFunding !== 'Yes' && audit.spurious !== 'Yes' && !hasWeightMismatch(audit) && !hasCountMismatch(audit);
    default:        return true;
  }
}

// ────────────────────────────
// ALL AUDITS
// ────────────────────────────
// ── Pure compute functions for the All Audits table ──
// Extracted from renderAllAudits() below with NO change in behavior — same
// inputs produce the exact same outputs as before. Mirrors the same split
// already done for the Tare Weight table (see computeAuditedLoansForTW /
// sortTWLoans / computeTWCounters above): "which audits to show and what
// the summary counts are" (pure logic, no DOM) is now separate from "how to
// draw that on screen" (renderAllAudits itself). Testable on its own (see
// tests/all-audits-compute.test.js), and reusable as-is if the UI is ever
// rebuilt in a different framework.

function computeDedupedAudits(auditStore) {
  // Deduplicate by loan ID — keep most recent audit per loan. Metabase-sync
  // placeholder docs (not yet actually audited) are excluded entirely.
  const loanMapAll = {};
  auditStore.forEach(a => {
    if (a.source === 'metabase-sync') return;
    if (!loanMapAll[a.loanId] || (a.date || '') > (loanMapAll[a.loanId].date || '')) {
      loanMapAll[a.loanId] = a;
    }
  });
  return Object.values(loanMapAll);
}

function computeAllAuditsSummaryCounts(deduped, activeLoanIds) {
  const total = deduped.length;
  const excess = deduped.filter(a => a.excessFunding === 'Yes' && activeLoanIds.has(a.loanId)).length;
  const spurious = deduped.filter(a => a.spurious === 'Yes' && activeLoanIds.has(a.loanId)).length;
  const clean = deduped.filter(a => a.excessFunding === 'No' && a.spurious === 'No').length;
  const activeAudited = deduped.filter(a => activeLoanIds.has(a.loanId)).length;
  return { total, excess, spurious, clean, activeAudited };
}

function filterAllAudits(deduped, filters, activeLoanIds) {
  return deduped.filter(a => {
    if (filters.loanIdFilter && !a.loanId.toLowerCase().includes(filters.loanIdFilter)) return false;
    if (filters.branchFilter && a.branch !== filters.branchFilter) return false;
    if (filters.auditorFilter && a.auditor !== filters.auditorFilter) return false;
    if (filters.deviationFilter && !hasDeviation(a, filters.deviationFilter)) return false;
    if (filters.loanStatusFilter === 'active' && !activeLoanIds.has(a.loanId)) return false;
    if (filters.loanStatusFilter === 'inactive' && activeLoanIds.has(a.loanId)) return false;
    if (filters.dateFrom && a.date < filters.dateFrom) return false;
    if (filters.dateTo && a.date > filters.dateTo) return false;
    return true;
  });
}

function renderAllAudits(search = '') {
  const deduped = computeDedupedAudits(auditStore);
  const { total, excess, spurious, clean, activeAudited } = computeAllAuditsSummaryCounts(deduped, activeLoanIds);
  const cards = document.getElementById('summary-grid').querySelectorAll('.sc-value');
  cards[0].textContent = total;
  cards[1].textContent = excess;
  cards[2].textContent = spurious;
  cards[3].textContent = clean;
  if (cards[4]) cards[4].textContent = activeAudited;

  // Read filter values
  const filters = {
    loanIdFilter: (document.getElementById('rf-loanid')?.value || '').toLowerCase(),
    branchFilter: document.getElementById('rf-branch')?.value || '',
    auditorFilter: document.getElementById('rf-auditor')?.value || '',
    deviationFilter: document.getElementById('rf-deviation')?.value || '',
    loanStatusFilter: document.getElementById('rf-loanstatus')?.value || '',
    dateFrom: document.getElementById('rf-date-from')?.value || '',
    dateTo: document.getElementById('rf-date-to')?.value || '',
  };

  const filtered = filterAllAudits(deduped, filters, activeLoanIds);

  // Update result count and wire up report button
  const countEl = document.getElementById('rf-result-count');
  if (countEl) countEl.textContent = filtered.length !== total ? filtered.length + ' of ' + total + ' results' : total + ' results';
  // Store filtered data for report generation
  window._lastFilteredAudits = filtered;

  const tbody = document.getElementById('reports-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:40px 20px; color:var(--text-3); font-size:13px;">${total === 0 ? '📋 No audits submitted yet.' : '🔍 No audits match the current filters. Try clearing some filters and searching again.'}</td></tr>`;
    return;
  }

  const visibleRows = ALL_AUDITS_PAGINATION_ENABLED ? filtered.slice(0, allAuditsRenderedCount) : filtered;

  tbody.innerHTML = visibleRows.map(a => {
    const excessBadge = a.excessFunding === 'Yes'
      ? `<span class="badge badge-excess">Yes${a.excessAmount ? ' — ₹' + Number(a.excessAmount).toLocaleString('en-IN') : ''}</span>`
      : `<span style="color:var(--success); font-weight:500;">No</span>`;
    const spurBadge = a.spurious === 'Yes'
      ? `<span class="badge badge-flag">Yes</span>`
      : `<span style="color:var(--success); font-weight:500;">No</span>`;

    const isActive = activeLoanIds.has(a.loanId);
    const loanStatusBadge = isActive
      ? '<span style="background:#EDFAF3; color:#1A7A4A; border:1px solid #A3E0BF; border-radius:20px; font-size:10px; font-weight:600; padding:2px 8px;">Active</span>'
      : '<span style="background:#F5F5F5; color:#777; border:1px solid #DDD; border-radius:20px; font-size:10px; font-weight:600; padding:2px 8px;">Inactive</span>';

    return `
      <tr class="row-clickable" onclick="openModal('${a.id}')">
        <td><span class="loan-mono">${a.loanId}</span></td>
        <td style="color:var(--text-2)">${a.branch || '—'}</td>
        <td style="color:var(--text-2)">${formatDate(a.date)}</td>
        <td style="color:var(--text-2)">${a.auditor}</td>
        <td>${a.loanAmount ? '₹' + Number(String(a.loanAmount).replace(/[^0-9.]/g, '')).toLocaleString('en-IN') : '—'}</td>
        <td>${excessBadge}</td>
        <td>${spurBadge}</td>
        <td><strong>${a.tw != null ? Number(a.tw).toFixed(2) : '—'}</strong></td>
        <td>${loanStatusBadge}</td>
      </tr>`;
  }).join('');

  if (ALL_AUDITS_PAGINATION_ENABLED && filtered.length > visibleRows.length) {
    tbody.innerHTML += `
      <tr class="empty-row">
        <td colspan="9" style="text-align:center; padding:16px;">
          <button class="btn-ghost" onclick="loadMoreAllAudits()">
            ↓ Load 100 more (showing ${visibleRows.length} of ${filtered.length})
          </button>
        </td>
      </tr>`;
  }
}

// Reveals the next batch of already-loaded, already-filtered rows — no new
// network request, since renderAllAudits() already has everything it needs
// in memory (see the pagination note near allAuditsRenderedCount above).
function loadMoreAllAudits() {
  allAuditsRenderedCount += ALL_AUDITS_PAGE_SIZE;
  renderAllAudits();
}

// ── Quick range dropdown (All Audits date filter) ──
function toggleQuickRangeMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('quick-range-menu');
  if (!menu) return;
  const opening = menu.style.display === 'none';
  menu.style.display = opening ? 'block' : 'none';
  if (opening) {
    // Close on next outside click — one-shot listener, re-armed each time it opens.
    document.addEventListener('click', closeQuickRangeMenuOnce, { once: true });
  }
}
function closeQuickRangeMenuOnce() {
  const menu = document.getElementById('quick-range-menu');
  if (menu) menu.style.display = 'none';
}
function applyQuickRange(months) {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  const toISO = d => d.toISOString().slice(0, 10);
  const fromEl = document.getElementById('rf-date-from');
  const toEl = document.getElementById('rf-date-to');
  if (fromEl) fromEl.value = toISO(from);
  if (toEl) toEl.value = toISO(to);
  closeQuickRangeMenuOnce();
  applyReportFilters();
}

function applyReportFilters() {
  allAuditsRenderedCount = ALL_AUDITS_PAGE_SIZE;
  renderAllAudits();
}

function clearReportFilters() {
  ['rf-loanid'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['rf-branch','rf-auditor','rf-deviation','rf-loanstatus'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['rf-date-from','rf-date-to'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  allAuditsRenderedCount = ALL_AUDITS_PAGE_SIZE;
  renderAllAudits();
}

function populateReportFilters() {
  const branches = getAllBranches();
  const auditors = [...new Set(auditStore.map(a => a.auditor).filter(a => a && a !== '—'))].sort();
  const branchSel = document.getElementById('rf-branch');
  const auditorSel = document.getElementById('rf-auditor');
  if (branchSel) branchSel.innerHTML = '<option value="">All branches</option>' + branches.map(b => '<option value="' + b + '">' + b + '</option>').join('');
  if (auditorSel) auditorSel.innerHTML = '<option value="">All auditors</option>' + auditors.map(a => '<option value="' + a + '">' + a + '</option>').join('');
}

async function generateTWReport() {
  const data = window._lastFilteredTW || [];
  if (!data.length) { showErrorPopup('Nothing to export', 'No tare weight records match the current filter.'); return; }

  function val(v) { return (v == null || v === 'null') ? '' : String(v); }

  const btn = document.getElementById('tw-report-btn');
  const originalBtnHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching gross weight…'; }

  // Gross weight is fetched LIVE from Metabase rather than read off each
  // audit's saved ornament snapshot. Snapshots taken before the ornament-
  // clubbing fix (loan-lookup.js) can permanently under-count duplicate-
  // type-same-quantity ornaments, which would silently carry a wrong GW
  // into every future report for that loan. One batched request handles
  // any number of loans — the endpoint itself chunks internally, so this
  // is safe whether the report covers 15 loans or 15,000.
  let gwByLoanId = {};
  let gwFetchFailed = false;
  try {
    const loanIds = data.map(a => a.loanId);
    const result = await apiRequest('/api/tw-gross-weight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loanIds })
    });
    if (result.error) throw new Error(result.error);
    gwByLoanId = result.gwByLoanId || {};
    if (result.failedBatches) {
      console.warn('Some gross weight batches failed:', result.failedBatches);
      gwFetchFailed = true;
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = originalBtnHTML; }
    showErrorPopup(
      'Couldn\'t fetch gross weight',
      'The report needs live gross weight data from Metabase, which failed to load. No report was generated, so you don\'t end up with silently missing GW figures — try again in a moment.',
      err.message
    );
    return;
  }

  const headers = ['Loan ID', 'Branch', 'Audit Date', 'Loan Booking Date', 'Original Auditor', 'Gross Weight (g)', 'Stored TW (g)', 'Rechecked By', 'Rechecked At'];

  const rows = data.map(a => {
    const rechecked = a.twUpdatedAt
      ? (a.twUpdatedAt.toDate ? a.twUpdatedAt.toDate().toLocaleString('en-GB') : new Date(a.twUpdatedAt).toLocaleString('en-GB'))
      : '';

    const gw = gwByLoanId[a.loanId];

    return [
      val(a.loanId),
      val(a.branch),
      formatDate(a.date),
      a.loanBookingDate ? formatDate(a.loanBookingDate) : '',
      val(a.auditor),
      gw != null ? Number(gw).toFixed(2) : '',
      a.tw != null ? Number(a.tw).toFixed(2) : '',
      val(a.twRecheckedBy),
      rechecked
    ];
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  ws['!cols'] = [
    { wch: 18 }, { wch: 22 }, { wch: 12 }, { wch: 16 },
    { wch: 18 }, { wch: 15 }, { wch: 14 },
    { wch: 18 }, { wch: 20 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Tare Weight Report');
  const today = new Date().toLocaleDateString('en-GB').replace(/\//g, '-');
  XLSX.writeFile(wb, 'Oro_TareWeight_Report_' + today + '.xlsx');

  if (btn) { btn.disabled = false; btn.innerHTML = originalBtnHTML; }
  if (gwFetchFailed) {
    showErrorPopup('Report downloaded, with a note', 'Gross weight couldn\'t be fetched for some loans (check console for details) — those rows will show a blank Gross Weight value.');
  }
}


// ────────────────────────────
// MODAL
// ────────────────────────────
function generateReport() {
  const data = window._lastFilteredAudits || [];
  if (!data.length) { showErrorPopup('Nothing to export', 'No audits match the current filter.'); return; }

  function fmtDate(d) {
    if (!d) return '';
    const parts = d.split('-');
    if (parts.length !== 3) return d;
    return parts[2] + '/' + parts[1] + '/' + String(parts[0]).slice(-2);
  }

  function val(v) { return (v == null || v === 'null') ? '' : String(v); }

  const headers = ['Loan ID', 'Branch', 'City', 'Audit Date', 'Loan Booking Date', 'Auditor', 'Loan Amount (Rs)', 'Excess Funding', 'Excess Amount (Rs)', 'Spurious', 'Spurious Ornaments', 'Weight Mismatch', 'Count Mismatch', 'Tare Weight (g)', 'Loan Status', 'Remarks', 'Submitted At'];

  const rows = data.map(a => {
    const weightMismatch = hasWeightMismatch(a) ? 'Yes' : 'No';
    const countMismatch = hasCountMismatch(a) ? 'Yes' : 'No';
    const submittedAt = a.submittedAt
      ? (a.submittedAt.toDate ? a.submittedAt.toDate().toLocaleString('en-GB') : new Date(a.submittedAt).toLocaleString('en-GB'))
      : '';
    return [
      val(a.loanId),
      val(a.branch),
      val(a.city),
      fmtDate(a.date),
      fmtDate(a.loanBookingDate),
      val(a.auditor),
      a.loanAmount ? Number(String(a.loanAmount).replace(/[^0-9.]/g, '')) || '' : '',
      val(a.excessFunding),
      a.excessAmount || 0,
      val(a.spurious),
      (a.spuriousOrnaments || []).join(', ') || '',
      weightMismatch,
      countMismatch,
      a.tw != null ? Number(a.tw).toFixed(2) : '',
      activeLoanIds.has(a.loanId) ? 'Active' : 'Inactive',
      val(a.remarks),
      submittedAt
    ];
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  ws['!cols'] = [
    { wch: 18 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 18 },
    { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 10 },
    { wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    { wch: 35 }, { wch: 22 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Audit Report');
  const today = new Date().toLocaleDateString('en-GB').replace(/\//g, '-');
  XLSX.writeFile(wb, 'Oro_Audit_Report_' + today + '.xlsx');
}



// ────────────────────────────
// AUTH — LOGIN / LOGOUT
// ────────────────────────────
function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  if (!email || !password) { errorEl.textContent = 'Please enter your email and password.'; return; }

  btn.textContent = 'Signing in...';
  btn.disabled = true;
  errorEl.textContent = '';

  auth.signInWithEmailAndPassword(email, password)
    .then(userCred => {
      currentUser = userCred.user;
      // Look up own record by UID (not email) — this is what lets the
      // Firestore rule allow "read your own document" without opening the
      // whole users collection to every logged-in account.
      return getUserDoc(currentUser.uid);
    })
    .then(userData => {
      if (!userData) {
        auth.signOut();
        throw new Error('Access denied. Your account is not authorised for this app.');
      }
      currentUserRole = userData.role || 'auditor';
      onLoginSuccess();
    })
    .catch(err => {
      let msg = err.message;
      if (msg.includes('wrong-password') || msg.includes('user-not-found') || msg.includes('invalid-credential')) {
        msg = 'Incorrect email or password.';
      }
      errorEl.textContent = msg;
      btn.textContent = 'Sign in';
      btn.disabled = false;
    });
}

// Shared by both onLoginSuccess and handleGuestLogin — was previously
// duplicated identically in both places with no error handling at all. If
// this fails, there's no single "retry button" target the way there is for
// Tare Weight/All Audits (multiple sections could be affected at once), so
// the most reliable recovery is a straightforward page refresh — Firebase
// auth persists across it, so the person doesn't need to log in again.
function loadInitialAppData() {
  return Promise.all([loadAudits(), loadActiveLoans(), loadSettings()])
    .then(() => {
      if (document.getElementById('all-audits').classList.contains('active')) renderAllAudits();
      if (document.getElementById('tare-weight').classList.contains('active')) renderTWTable();
      loadUnauditedLoans();
    })
    .catch(err => {
      // loadAudits()/loadActiveLoans() already showed their own specific
      // toast before rejecting — no second, generic one needed here. Just
      // log it; there's no single retry-button target for a full initial
      // load failure the way there is for one section's table, so the
      // specific toasts' own "try refreshing" guidance is the real recovery
      // path here.
      console.error('Failed to load initial app data:', err);
    });
}

function onLoginSuccess() {
  initDarkMode();
  // A real, authenticated login is happening — make sure the guest view-only
  // banner isn't still showing from a previous guest session in this tab.
  document.getElementById('guest-banner').style.display = 'none';

  // Update sidebar with user info
  const email = currentUser.email;
  const name = email.split('@')[0].replace(/\./g, ' ').replace(/\w/g, c => c.toUpperCase());
  document.getElementById('auditor-name-display').textContent = name;
  document.getElementById('auditor-initials').textContent = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  document.getElementById('auditor-role-display').textContent = currentUserRole === 'manager' ? 'Manager' : 'Auditor';

  // Hide settings nav for auditors
  const settingsBtn = document.querySelector("[onclick=\"switchSection('settings', this)\"]");
  if (settingsBtn) settingsBtn.style.display = currentUserRole === 'manager' ? '' : 'none';

  // Hide login, show app
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = '';

  // Load app data
  initAuditDate();
  loadInitialAppData();
}


async function handleGuestLogin() {
  // Guest access now requires a real (anonymous) Firebase session rather than
  // bypassing auth entirely — this lets Firestore rules require request.auth != null
  // on every read, closing off access to anyone with no session at all.
  try {
    await auth.signInAnonymously();
  } catch (err) {
    showErrorPopup(
      'Guest access unavailable',
      'Could not start a guest session. If this keeps happening, let Vivek or Rijin know.',
      err.message
    );
    return;
  }

  initDarkMode();
  currentUser = null;
  currentUserRole = 'guest';

  // Update sidebar
  document.getElementById('auditor-name-display').textContent = 'Guest';
  document.getElementById('auditor-initials').textContent = 'G';
  document.getElementById('auditor-role-display').textContent = 'View only';

  // Hide settings nav
  const settingsBtn = document.querySelector("[onclick=\"switchSection('settings', this)\"]");
  if (settingsBtn) settingsBtn.style.display = 'none';

  // Show guest banner, offset app shell
  document.getElementById('guest-banner').style.display = 'block';
  document.getElementById('app-shell').style.paddingTop = '30px';

  // Hide login, show app
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display = '';

  // Load app data (read-only)
  initAuditDate();
  loadInitialAppData();
}

function handleSignOut() {
  auth.signOut().then(() => {
    currentUser = null;
    currentUserRole = 'auditor';
    document.getElementById('guest-banner').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('login-error').textContent = '';
    document.getElementById('login-btn').textContent = 'Sign in';
    document.getElementById('login-btn').disabled = false;
    // Reset to new audit tab
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('new-audit').classList.add('active');
    document.querySelector("[onclick=\"switchSection('new-audit', this)\"]").classList.add('active');
  });
}

// ────────────────────────────
// USER MANAGEMENT (Settings)
// ────────────────────────────
async function loadUsersList() {
  const listEl = document.getElementById('users-list');
  if (!listEl) return;
  try {
    const users = await getAllUsersSnapshot();
    if (!users.length) { listEl.innerHTML = '<div style="font-size:13px; color:var(--text-3);">No users yet.</div>'; return; }
    listEl.innerHTML = users.map(d => {
      return `<div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:var(--surface-2); border:1px solid var(--border); border-radius:var(--r-sm); margin-bottom:8px;">
        <div>
          <div style="font-size:13px; font-weight:500;">${d.email}</div>
          <div style="font-size:11px; color:var(--text-3); margin-top:2px;">${d.role === 'manager' ? 'Manager' : 'Auditor'}</div>
        </div>
        ${d.uid !== currentUser?.uid
          ? `<div style="display:flex; gap:6px;">
              <button class="btn-ghost" onclick="resetUserPassword('${d.email}')" style="height:28px; font-size:12px;">Reset pwd</button>
              <button class="btn-ghost" onclick="removeUser('${d.id}', '${d.email}')" style="height:28px; font-size:12px; color:var(--danger); border-color:var(--danger);">Remove</button>
             </div>`
          : '<span style="font-size:11px; color:var(--text-3);">You</span>'}
      </div>`;
    }).join('');
  } catch(err) {
    listEl.innerHTML = '<div style="font-size:13px; color:var(--danger);">Failed to load users.</div>';
    showErrorPopup('Couldn\'t load users', 'The user list failed to load from Firestore.', err.message);
  }
}

async function addUser() {
  if (currentUserRole === 'guest') return;

  const email = document.getElementById('new-user-email').value.trim();
  const password = document.getElementById('new-user-password').value.trim();
  const role = document.getElementById('new-user-role').value;
  const statusEl = document.getElementById('user-mgmt-status');

  if (!email) { statusEl.textContent = '❌ Please enter an email.'; statusEl.style.color = 'var(--danger)'; return; }
  if (!password || password.length < 6) { statusEl.textContent = '❌ Password must be at least 6 characters.'; statusEl.style.color = 'var(--danger)'; return; }

  statusEl.textContent = 'Creating user...';
  statusEl.style.color = 'var(--text-3)';

  try {
    const callerToken = await auth.currentUser.getIdToken();
    const data = await apiRequest('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, role, callerToken })
    });

    if (data.error) {
      statusEl.textContent = '❌ ' + data.error;
      statusEl.style.color = 'var(--danger)';
      return;
    }

    document.getElementById('new-user-email').value = '';
    document.getElementById('new-user-password').value = '';
    statusEl.textContent = '✓ User created. They can now log in with the provided password.';
    statusEl.style.color = 'var(--success)';
    setTimeout(() => statusEl.textContent = '', 5000);
    loadUsersList();
  } catch(err) {
    statusEl.textContent = '❌ Failed: ' + err.message;
    statusEl.style.color = 'var(--danger)';
    showErrorPopup('Couldn\'t create user', 'Something went wrong creating the new user account.', err.message);
  }
}

async function removeUser(docId, email) {
  if (currentUserRole === 'guest') return;

  if (!confirm(`Remove ${email}? They will lose app access.`)) return;
  try {
    const callerToken = await auth.currentUser.getIdToken();
    const data = await apiRequest('/api/remove-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId, callerToken })
    });
    if (data.error) throw new Error(data.error);
    loadUsersList();
  } catch(err) {
    showErrorPopup('Couldn\'t remove user', `Failed to remove ${email}.`, err.message);
  }
}

// ────────────────────────────
// SETTINGS
// ────────────────────────────
function unlockSettings() {
  if (currentUserRole === 'guest') return;

  const pwd = document.getElementById('settings-password-input').value.trim();
  if (pwd !== SETTINGS_PASSWORD) {
    document.getElementById('settings-password-error').textContent = '❌ Incorrect password.';
    return;
  }
  // Hide user management for non-managers
  const userMgmt = document.getElementById('user-mgmt-card');
  if (userMgmt) userMgmt.style.display = currentUserRole === 'manager' ? 'block' : 'none';
  document.getElementById('settings-locked').style.display = 'none';
  document.getElementById('settings-content').style.display = 'block';
  loadSettingsPanel();
  loadUsersList();
}

// ────────────────────────────
// BRANCH MANAGEMENT
// ────────────────────────────
function renderBranchesList() {
  const el = document.getElementById('branches-list');
  if (!el) return;
  const allBranches = getAllBranches();
  if (!allBranches.length) {
    el.innerHTML = '<span style="font-size:12px; color:var(--text-3);">No branches registered yet.</span>';
    return;
  }
  el.innerHTML = allBranches.map(b => {
    const isRegistered = registeredBranches.includes(b);
    return `<div style="display:flex; align-items:center; gap:6px; background:var(--surface-2); border:1px solid var(--border); border-radius:20px; padding:4px 12px 4px 14px; font-size:13px;">
      <span>${b}</span>
      ${isRegistered
        ? `<span onclick="removeBranch('${b}')" style="cursor:pointer; color:var(--text-3); font-size:16px; line-height:1; margin-left:4px;" title="Remove">×</span>`
        : `<span style="font-size:10px; color:var(--text-3); margin-left:4px;">(auto)</span>`
      }
    </div>`;
  }).join('');
}

async function addBranch() {
  if (currentUserRole !== 'manager') return;
  const input = document.getElementById('new-branch-input');
  const statusEl = document.getElementById('branch-mgmt-status');
  const name = input.value.trim();
  if (!name) { statusEl.textContent = '❌ Enter a branch name.'; statusEl.style.color = 'var(--danger)'; return; }
  if (registeredBranches.includes(name)) { statusEl.textContent = '❌ Branch already registered.'; statusEl.style.color = 'var(--danger)'; return; }
  try {
    registeredBranches = [...registeredBranches, name].sort();
    await mergeAppSettings({ branches: registeredBranches });
    input.value = '';
    renderBranchesList();
    populateBranchFilter();
    populateReportFilters();
    statusEl.textContent = '✓ Branch added';
    statusEl.style.color = 'var(--success)';
    setTimeout(() => statusEl.textContent = '', 3000);
  } catch (err) {
    statusEl.textContent = '❌ Failed to save.';
    statusEl.style.color = 'var(--danger)';
    showErrorPopup('Couldn\'t add branch', 'Failed to save the new branch to Firestore.', err.message);
  }
}

async function removeBranch(name) {
  if (currentUserRole !== 'manager') return;
  const statusEl = document.getElementById('branch-mgmt-status');
  try {
    registeredBranches = registeredBranches.filter(b => b !== name);
    await mergeAppSettings({ branches: registeredBranches });
    renderBranchesList();
    populateBranchFilter();
    populateReportFilters();
    statusEl.textContent = '✓ Branch removed';
    statusEl.style.color = 'var(--success)';
    setTimeout(() => statusEl.textContent = '', 3000);
  } catch (err) {
    statusEl.textContent = '❌ Failed to remove.';
    statusEl.style.color = 'var(--danger)';
    showErrorPopup('Couldn\'t remove branch', 'Failed to remove the branch in Firestore.', err.message);
  }
}

function loadSettingsPanel() {
  renderBranchesList();
  document.getElementById('setting-pending-days').value = PENDING_DAYS;
  document.getElementById('setting-tw-threshold').value = TW_THRESHOLD;
  const uniqueAudited = new Set(
    auditStore
      .filter(a => a.source !== 'metabase-sync' && a.auditor && a.auditor !== '—')
      .map(a => a.loanId)
  ).size;
  document.getElementById('info-total-records').textContent = uniqueAudited;
  document.getElementById('info-active-loans').textContent = activeLoanIds.size;
  document.getElementById('info-pending-days').textContent = PENDING_DAYS + ' days';
  document.getElementById('info-tw-threshold').textContent = TW_THRESHOLD + 'g';
  getAppSettingsDocThenable().then(d => {
    if (d && d.lastSyncAt) {
      const dt = new Date(d.lastSyncAt);
      document.getElementById('info-last-sync').textContent = dt.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'});
    } else {
      document.getElementById('info-last-sync').textContent = 'No sync on record';
    }
  }).catch(() => {
    document.getElementById('info-last-sync').textContent = '—';
  });
}

async function saveAuditSettings() {
  if (currentUserRole === 'guest') return;

  const pendingDays = parseInt(document.getElementById('setting-pending-days').value);
  const twThreshold = parseFloat(document.getElementById('setting-tw-threshold').value);
  const statusEl = document.getElementById('audit-settings-status');
  if (isNaN(pendingDays) || pendingDays < 1) { statusEl.textContent = '❌ Invalid pending days.'; statusEl.style.color = 'var(--danger)'; return; }
  if (isNaN(twThreshold) || twThreshold < 0.1) { statusEl.textContent = '❌ Invalid threshold.'; statusEl.style.color = 'var(--danger)'; return; }
  try {
    await mergeAppSettings({ pendingDays, twThreshold, settingsPassword: SETTINGS_PASSWORD, updatedAt: new Date().toISOString() });
    PENDING_DAYS = pendingDays;
    TW_THRESHOLD = twThreshold;
    document.getElementById('info-pending-days').textContent = PENDING_DAYS + ' days';
    document.getElementById('info-tw-threshold').textContent = TW_THRESHOLD + 'g';
    statusEl.textContent = '✓ Saved';
    statusEl.style.color = 'var(--success)';
    setTimeout(() => statusEl.textContent = '', 3000);
  } catch (err) {
    statusEl.textContent = '❌ Failed to save.';
    statusEl.style.color = 'var(--danger)';
    showErrorPopup('Couldn\'t save settings', 'Failed to save audit settings to Firestore.', err.message);
  }
}

async function changeMyPassword() {
  if (currentUserRole === 'guest') return;

  const current = document.getElementById('setting-current-password').value.trim();
  const newPwd = document.getElementById('setting-new-password').value.trim();
  const statusEl = document.getElementById('password-change-status');
  if (!current) { statusEl.textContent = '❌ Enter your current password.'; statusEl.style.color = 'var(--danger)'; return; }
  if (!newPwd || newPwd.length < 6) { statusEl.textContent = '❌ New password must be at least 6 characters.'; statusEl.style.color = 'var(--danger)'; return; }
  try {
    // Re-authenticate first, then update password
    const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, current);
    await auth.currentUser.reauthenticateWithCredential(credential);
    await auth.currentUser.updatePassword(newPwd);
    document.getElementById('setting-current-password').value = '';
    document.getElementById('setting-new-password').value = '';
    statusEl.textContent = '✓ Password changed successfully.';
    statusEl.style.color = 'var(--success)';
    setTimeout(() => statusEl.textContent = '', 4000);
  } catch (err) {
    if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      statusEl.textContent = '❌ Current password is incorrect.';
    } else {
      statusEl.textContent = '❌ Failed: ' + err.message;
      showErrorPopup('Couldn\'t change password', 'Something went wrong changing your password.', err.message);
    }
    statusEl.style.color = 'var(--danger)';
  }
}

async function resetUserPassword(email) {
  if (currentUserRole === 'guest') return;

  const newPwd = prompt(`Enter new password for ${email} (min 6 characters):`);
  if (!newPwd) return;
  if (newPwd.length < 6) { showErrorPopup('Password too short', 'Password must be at least 6 characters.'); return; }
  try {
    const callerToken = await auth.currentUser.getIdToken();
    const data = await apiRequest('/api/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, newPassword: newPwd, callerToken })
    });
    if (data.error) {
      showErrorPopup('Couldn\'t reset password', `Failed to reset password for ${email}.`, data.error);
      return;
    }
    alert(`✓ Password reset for ${email}`);
  } catch(err) {
    showErrorPopup('Couldn\'t reset password', `Failed to reset password for ${email} — check your connection.`, err.message);
  }
}

function openModal(docId) {
  const a = auditStore.find(x => x.id === docId);
  if (!a) return;
  document.getElementById('modal-loan-id').textContent = a.loanId;

  // Build ornament section if data exists
  const ornaments = a.ornaments || [];
  const ornamentHTML = ornaments.length > 0 ? `
    <div class="modal-section">Ornament audit data</div>
    ${ornaments.map((o, i) => `
      <div style="background:var(--surface-2); border:1px solid var(--border); border-radius:var(--r-sm); padding:12px 16px; margin-bottom:10px;">
        <div style="font-size:13px; font-weight:600; color:var(--gold); margin-bottom:10px;">${o.type} — Count: ${o.countAudit ?? '—'}</div>
        <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:8px;">
          <div>
            <div class="mfl">Gross weight</div>
            <div style="font-size:12px; margin-top:2px;">
              <span style="color:var(--text-3);">PC: ${o.gwPC || '—'}g</span>
              &nbsp;→&nbsp;
              <span style="font-weight:600; color:${o.gwAudit && o.gwPC && Math.abs(parseFloat(o.gwAudit) - parseFloat(o.gwPC)) > TW_THRESHOLD ? 'var(--danger)' : 'var(--text-1)'};">Audit: ${o.gwAudit || '—'}g</span>
            </div>
          </div>
          <div>
            <div class="mfl">Karat</div>
            <div style="font-size:12px; margin-top:2px;">
              <span style="color:var(--text-3);">PC: ${o.karatPC || '—'}kt</span>
              &nbsp;→&nbsp;
              <span style="font-weight:600; color:${o.karatAudit && o.karatPC && parseInt(o.karatAudit) !== parseInt(o.karatPC) ? 'var(--danger)' : 'var(--text-1)'};">Audit: ${o.karatAudit || '—'}kt</span>
            </div>
          </div>
          <div>
            <div class="mfl">Net weight</div>
            <div style="font-size:12px; margin-top:2px;">
              <span style="color:var(--text-3);">PC: ${o.nwPC || '—'}g</span>
              &nbsp;→&nbsp;
              <span style="font-weight:600; color:${o.nwAudit && o.nwPC && Math.abs(parseFloat(o.nwAudit) - parseFloat(o.nwPC)) > TW_THRESHOLD ? 'var(--danger)' : 'var(--text-1)'};">Audit: ${o.nwAudit || '—'}g</span>
            </div>
          </div>
          <div>
            <div class="mfl">Stone deduction</div>
            <div style="font-size:12px; margin-top:2px;">
              <span style="color:var(--text-3);">PC: ${o.stoneDedPC || '—'}g</span>
              &nbsp;→&nbsp;
              <span style="font-weight:600;">Audit: ${o.stoneDedAudit || '—'}g</span>
            </div>
          </div>
          <div>
            <div class="mfl">Hallmark</div>
            <div class="mfv">${o.hallmark || '—'}</div>
          </div>
          <div>
            <div class="mfl">Spurious</div>
            <div class="mfv" style="color:${o.spurious === 'Yes' ? 'var(--danger)' : 'inherit'}; font-weight:${o.spurious === 'Yes' ? '600' : 'normal'}">${o.spurious || '—'}</div>
          </div>
        </div>
      </div>
    `).join('')}
  ` : `<div class="modal-section">Ornament audit data</div><div style="font-size:13px; color:var(--text-3); padding:8px 0 16px;">No ornament detail available for this record.</div>`;

  document.getElementById('modal-body').innerHTML = `
    <div class="modal-section">Audit summary</div>
    <div class="modal-grid">
      <div><div class="mfl">Loan ID</div><div class="mfv" style="font-family:'Inter',system-ui,sans-serif; font-weight:500;">${a.loanId}</div></div>
      <div><div class="mfl">Loan booking date</div><div class="mfv">${formatDate(a.loanBookingDate) || '—'}</div></div>
      <div><div class="mfl">Audit date</div><div class="mfv">${formatDate(a.date)}</div></div>
      <div><div class="mfl">Auditor</div><div class="mfv">${a.auditor}</div></div>
      <div><div class="mfl">Branch</div><div class="mfv">${a.branch || '—'}</div></div>
      <div><div class="mfl">City</div><div class="mfv">${a.city || '—'}</div></div>
      <div><div class="mfl">Loan amount</div><div class="mfv">${a.loanAmount ? '₹' + Number(String(a.loanAmount).replace(/[^0-9.]/g, '')).toLocaleString('en-IN') : '—'}</div></div>
    </div>
    <div class="modal-section">Findings</div>
    <div class="modal-grid">
      <div><div class="mfl">Tear weight</div><div class="mfv">${a.tw != null ? Number(a.tw).toFixed(2) + ' g' : '—'}</div></div>
      <div><div class="mfl">Excess funding</div><div class="mfv" style="color:${a.excessFunding === 'Yes' ? 'var(--danger)' : 'inherit'}">${a.excessFunding}${a.excessAmount ? ' — ₹' + Number(a.excessAmount).toLocaleString('en-IN') : ''}</div></div>
      <div><div class="mfl">Spurious</div><div class="mfv" style="color:${a.spurious === 'Yes' ? 'var(--danger)' : 'inherit'}">${a.spurious}</div></div>
      <div><div class="mfl">New / old packet ID</div><div class="mfv">${escapeHtml(a.newPacketId) || '—'}</div></div>
    </div>
    ${ornamentHTML}
    ${a.remarks ? `<div class="modal-section">Remarks</div><div class="remarks-block">${escapeHtml(a.remarks)}</div>` : ''}
  `;
  document.getElementById('audit-modal').classList.remove('hidden');
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('audit-modal')) {
    document.getElementById('audit-modal').classList.add('hidden');
  }
}

// ── INIT ──
initDarkMode();
showLoadingState('reports-tbody', 8, 'Loading audits from Firestore...');
showLoadingState('tw-tbody', 10, 'Loading...');
// App init is triggered by onLoginSuccess() after successful authentication
