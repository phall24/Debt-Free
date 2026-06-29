// ===========================================================================
// State
// ===========================================================================
// Each debt: { id, name, type, balance, apr, minPayment, source: 'plaid'|'manual' }
let debts = loadManualDebts();
let excludedKeys = loadExcluded();       // Plaid account_ids the user removed
let debtOverrides = loadDebtOverrides(); // account_id -> edited fields (apr, payment…)
let accounts = loadAccounts();           // checking/savings (assets)
let transactions = loadTransactions();   // imported from CSV
let plaidConfigured = false;
let plaidEnv = 'sandbox';
let oauthReady = false;

const $ = (sel) => document.querySelector(sel);

// When served through an ngrok free tunnel, same-origin API calls would hit the
// "browser warning" interstitial. This header tells ngrok to skip it. Only added
// to our own relative URLs so cross-origin (Plaid) requests are untouched.
const _fetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (typeof url === 'string' && url.startsWith('/')) {
    opts = { ...opts, headers: { ...(opts.headers || {}), 'ngrok-skip-browser-warning': 'true' } };
  }
  return _fetch(url, opts);
};

// PDF.js worker (used to read text out of uploaded PDF statements, in-browser).
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
const fmt = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// ===========================================================================
// Init
// ===========================================================================
init();

async function init() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    plaidConfigured = cfg.plaidConfigured;
    plaidEnv = cfg.env;
    oauthReady = cfg.oauthReady;
    let status;
    if (!plaidConfigured) {
      status = 'Plaid keys not set up yet — you can still add debts manually. (See README to enable auto-pull.)';
    } else if (plaidEnv === 'production' && !oauthReady) {
      status = `Plaid connected (production). ⚠️ No redirect URI set — OAuth banks like Navy Federal won't connect until you set PLAID_REDIRECT_URI in .env.`;
    } else {
      status = `Plaid connected (${plaidEnv} mode). Click “Connect a login” to link an account.`;
    }
    $('#plaidStatus').textContent = status;
    $('#connectBtn').disabled = !plaidConfigured;
    $('#refreshBtn').disabled = !plaidConfigured;
    renderSetupBanner();
  } catch {
    $('#plaidStatus').textContent = 'Backend not reachable.';
  }

  // If Plaid is configured, try to pull any already-linked debts.
  if (plaidConfigured) await pullPlaidDebts();

  render();

  $('#connectBtn').addEventListener('click', connectBank);
  $('#refreshBtn').addEventListener('click', pullPlaidDebts);
  $('#addManualBtn').addEventListener('click', () => openDialog());
  $('#restoreHiddenBtn').addEventListener('click', restoreHidden);
  $('#uploadBtn').addEventListener('click', () => $('#statementFile').click());
  $('#statementFile').addEventListener('change', onStatementUpload);
  $('#addAccountBtn').addEventListener('click', () => openAccountDialog());
  $('#accountForm').addEventListener('submit', onAccountSubmit);
  $('#importTxBtn').addEventListener('click', () => $('#txFile').click());
  $('#txFile').addEventListener('change', onTransactionsUpload);
  $('#clearTxBtn').addEventListener('click', clearTransactions);
  $('#txSearch').addEventListener('input', renderTxList);
  $('#filterMonth').addEventListener('change', (e) => { budgetFilter.month = e.target.value; renderBudget(); });
  $('#filterOwner').addEventListener('change', (e) => { budgetFilter.owner = e.target.value; renderBudget(); });
  $('#budgetTargetsBtn').addEventListener('click', openTargetsDialog);
  $('#targetsForm').addEventListener('submit', onTargetsSubmit);
  $('#detailCloseBtn').addEventListener('click', () => $('#detailDialog').close());
  $('#detailEditBtn').addEventListener('click', () => {
    $('#detailDialog').close();
    const d = debts.find((x) => x.id === detailDebtId);
    if (d) openDialog(d);
  });
  $('#unlinkBtn').addEventListener('click', unlinkAll);
  $('#strategy').addEventListener('change', render);
  $('#extra').addEventListener('input', render);
  $('#debtForm').addEventListener('submit', onDialogSubmit);
}

// Shows the activation checklist when auto-connect isn't live yet. Auto-connect
// is the primary path; this guides the user to turn it on.
function renderSetupBanner() {
  const el = $('#setupBanner');
  if (plaidConfigured && !(plaidEnv === 'production' && !oauthReady)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  if (!plaidConfigured) {
    el.className = 'banner warn';
    el.innerHTML = `<strong>Turn on auto-connect (primary mode)</strong> — add your Plaid keys to
      <code>.env</code> and restart:
      <ol class="setup-steps">
        <li>Plaid dashboard → enable <strong>Production access</strong> + <strong>Liabilities</strong>.</li>
        <li>Start an https tunnel (<code>ngrok http ${location.port || 4000}</code>) and register its
          <code>/oauth.html</code> URL in Plaid → Allowed redirect URIs.</li>
        <li>Fill <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code>,
          <code>PLAID_ENV=production</code>, <code>PLAID_REDIRECT_URI</code> in <code>.env</code>, then restart.</li>
      </ol>
      Until then you can use manual entry as a backup.`;
  } else {
    el.className = 'banner warn';
    el.innerHTML = `<strong>Almost there.</strong> Plaid is connected, but no redirect URI is set —
      OAuth banks like Navy Federal need <code>PLAID_REDIRECT_URI</code> (your https tunnel + <code>/oauth.html</code>)
      in <code>.env</code>. Add it and restart to connect Navy Federal.`;
  }
}

// ===========================================================================
// Plaid wiring
// ===========================================================================
async function connectBank() {
  const owner = (prompt('Whose login is this? (e.g. Me, Wife, Joint)', 'Me') || '').trim();
  if (owner === '') return; // cancelled

  const { link_token, error } = await fetch('/api/create_link_token', { method: 'POST' }).then((r) => r.json());
  if (error) return alert('Could not start Plaid: ' + error);

  // Persist so the OAuth redirect (oauth.html) can resume this exact Link session.
  localStorage.setItem('plaidLinkToken', link_token);
  localStorage.setItem('plaidOwner', owner);

  const handler = Plaid.create({
    token: link_token,
    onSuccess: (public_token) => finishLink(public_token, owner),
    onEvent: (eventName, meta) => {
      if (eventName === 'ERROR') {
        console.error('Plaid Link ERROR event:', meta);
      }
    },
    onExit: (err, meta) => {
      localStorage.removeItem('plaidLinkToken');
      localStorage.removeItem('plaidOwner');
      if (err) {
        console.error('Plaid Link exit error:', err, meta);
        alert(
          `Plaid connection failed.\n\n` +
          `Code: ${err.error_code || '(none)'}\n` +
          `Type: ${err.error_type || '(none)'}\n` +
          `Message: ${err.display_message || err.error_message || '(none)'}\n` +
          `Institution: ${meta?.institution?.name || '(none)'}\n` +
          `Request ID: ${meta?.request_id || '(none)'}`
        );
      }
    },
  });
  handler.open();
}

// Plaid items the user has chosen to hide (by account_id), persisted locally.
function loadExcluded() {
  try { return new Set(JSON.parse(localStorage.getItem('excludedKeys') || '[]')); } catch { return new Set(); }
}
function saveExcluded() {
  localStorage.setItem('excludedKeys', JSON.stringify([...excludedKeys]));
}

// User edits to Plaid debts (e.g. APR/payment for auto loans Plaid can't provide),
// keyed by account_id so they survive each refresh.
function loadDebtOverrides() {
  try { return JSON.parse(localStorage.getItem('debtOverrides') || '{}'); } catch { return {}; }
}
function saveDebtOverrides() {
  localStorage.setItem('debtOverrides', JSON.stringify(debtOverrides));
}

// Exchange the public token for stored access, then refresh the debt list.
async function finishLink(public_token, owner) {
  localStorage.removeItem('plaidLinkToken');
  localStorage.removeItem('plaidOwner');
  const res = await fetch('/api/exchange_public_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_token, owner }),
  }).then((r) => r.json());
  if (res.error) return alert('Link failed: ' + res.error);
  await pullPlaidDebts();
  render();
}

async function pullPlaidDebts() {
  try {
    const { debts: pulled, accounts: pulledAccts = [], errors } = await fetch('/api/liabilities').then((r) => r.json());
    // Replace all plaid-sourced debts/accounts, keep manually-added ones.
    // Skip any the user has explicitly removed (by Plaid account_id).
    debts = debts.filter((d) => d.source === 'manual');
    for (const d of pulled) {
      if (d.account_id && excludedKeys.has(d.account_id)) continue;
      const ov = (d.account_id && debtOverrides[d.account_id]) || {};
      debts.push({ ...d, ...ov, id: cryptoId() });
    }
    accounts = accounts.filter((a) => a.source !== 'plaid');
    for (const a of pulledAccts) {
      if (a.account_id && excludedKeys.has(a.account_id)) continue;
      accounts.push({ ...a, id: cryptoId() });
    }
    if (errors?.length) {
      console.warn('Plaid pull errors:', errors);
    }
    await pullPlaidTransactions();
    inferLoanPayments();
  } catch (err) {
    console.error(err);
  }
}

// For auto/personal loans (where Plaid gives no terms), infer the monthly payment
// from the recurring loan-payment transactions — by account, or by the loan's mask
// appearing in the payment description. APR still has to be entered by hand.
function inferLoanPayments() {
  // 1. Try matching a payment to each loan by its account/mask (most reliable).
  // 2. For vehicle loans whose payments are generic "Transfer to Loan" with no
  //    car id, pair the recurring payment amounts to the loans by balance rank
  //    (largest payment → largest balance). The user can flip it via Edit.
  const carPayments = recurringLoanPayments(); // distinct recurring amounts, desc
  const cars = [];
  for (const d of debts) {
    if (!d.needsTerms || !d.account_id) continue;
    if (debtOverrides[d.account_id]?.minPayment) continue; // user already set it

    const direct = inferLoanPaymentDirect(d);
    if (direct) { d.minPayment = direct; d.paymentInferred = true; continue; }

    // Vehicle loan with no direct match → queue for balance-rank assignment.
    if (/loan/i.test(d.type) && !/line of credit/i.test(d.type)) cars.push(d);
  }
  cars.sort((a, b) => b.balance - a.balance);
  cars.forEach((car, i) => {
    if (carPayments[i]) { car.minPayment = carPayments[i]; car.paymentInferred = true; }
  });
}

// A payment matched directly to a loan via its account_id or mask.
function inferLoanPaymentDirect(d) {
  const byAcct = transactions.filter((t) => t.account_id === d.account_id);
  const byMask = d.mask ? transactions.filter((t) => t.description.includes(d.mask) && t.amount < 0) : [];
  return recurringAmount(byAcct.length ? byAcct : byMask, 20);
}

// Distinct recurring "Transfer to Loan" payment amounts (the car payments), desc.
function recurringLoanPayments() {
  const pool = transactions.filter((t) => t.amount < 0 && /transfer to loan/i.test(t.description));
  const byAmt = {};
  for (const t of pool) {
    const a = Math.round(Math.abs(t.amount));
    if (a < 50) continue;
    (byAmt[a] = byAmt[a] || new Set()).add(t.date.slice(0, 7));
  }
  return Object.entries(byAmt).filter(([, m]) => m.size >= 2).map(([a]) => +a).sort((x, y) => y - x);
}

// The amount that recurs across the most months in a set of transactions.
function recurringAmount(txs, floor) {
  const groups = {};
  for (const t of txs) {
    const amt = Math.round(Math.abs(t.amount));
    if (amt < floor) continue;
    (groups[amt] = groups[amt] || new Set()).add(t.date.slice(0, 7));
  }
  let best = 0, bestMonths = 1;
  for (const [amt, months] of Object.entries(groups)) {
    if (months.size >= 2 && months.size > bestMonths) { best = +amt; bestMonths = months.size; }
  }
  return best;
}

// Pull transactions from Plaid into the budget view.
async function pullPlaidTransactions() {
  try {
    const { transactions: pulled = [], errors } = await fetch('/api/transactions').then((r) => r.json());
    transactions = transactions.filter((t) => t.source !== 'plaid');
    const seen = new Set(transactions.map((t) => `${t.date}|${t.amount}|${t.description}`));
    for (const t of pulled) {
      const item = { ...t, category: t.category || categorize(t.description), source: 'plaid', id: cryptoId() };
      const key = `${item.date}|${item.amount}|${item.description}`;
      if (seen.has(key)) continue; // avoid duplicating a CSV/statement import
      seen.add(key);
      transactions.push(item);
    }
    transactions.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (errors?.length) {
      console.warn('Plaid transaction errors:', errors);
      if (errors.some((e) => e.error_code === 'PRODUCT_NOT_READY')) {
        console.info('[Debt-Free] Plaid is still preparing your transactions — click ↻ Refresh again in a minute.');
      }
    }
  } catch (err) {
    console.error('pullPlaidTransactions failed:', err);
  }
}

async function unlinkAll() {
  if (!confirm('Disconnect all linked banks? Your manually-added debts will stay.')) return;
  await fetch('/api/unlink_all', { method: 'POST' });
  debts = debts.filter((d) => d.source === 'manual');
  accounts = accounts.filter((a) => a.source !== 'plaid');
  excludedKeys.clear();
  saveExcluded();
  render();
}

// Un-hide everything the user previously removed, then re-pull from Plaid.
async function restoreHidden() {
  excludedKeys.clear();
  saveExcluded();
  if (plaidConfigured) await pullPlaidDebts();
  render();
}

// ===========================================================================
// Manual entry (persisted in localStorage)
// ===========================================================================
function loadManualDebts() {
  try {
    return JSON.parse(localStorage.getItem('debts') || '[]');
  } catch {
    return [];
  }
}
function saveManualDebts() {
  localStorage.setItem('debts', JSON.stringify(debts.filter((d) => d.source === 'manual')));
}

// ---------------------------------------------------------------------------
// Progress snapshots: one dated record of total debt, upserted per day, so we
// can chart real payoff progress over time. Lives in localStorage.
// ---------------------------------------------------------------------------
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function loadSnapshots() {
  try { return JSON.parse(localStorage.getItem('snapshots') || '[]'); } catch { return []; }
}
function recordSnapshot(total, byOwner) {
  if (!(total > 0)) return loadSnapshots();
  const snaps = loadSnapshots();
  const today = todayISO();
  const existing = snaps.find((s) => s.date === today);
  if (existing) { existing.total = total; existing.byOwner = byOwner; }
  else snaps.push({ date: today, total, byOwner });
  snaps.sort((a, b) => (a.date < b.date ? -1 : 1));
  localStorage.setItem('snapshots', JSON.stringify(snaps));
  return snaps;
}
function resetSnapshots() {
  if (!confirm('Clear your saved progress history and start the baseline from today?')) return;
  localStorage.removeItem('snapshots');
  render();
}

let editingId = null;
let dialogOrigin = null;
function openDialog(debt = null, hint = '') {
  editingId = debt?.id ?? null;
  dialogOrigin = debt?.origin ?? null;
  $('#dialogTitle').textContent = debt ? (debt.id ? 'Edit debt' : 'Confirm debt') : 'Add a debt';
  const hintEl = $('#statementHint');
  hintEl.hidden = !hint;
  hintEl.innerHTML = hint;
  refreshOwnerOptions();
  const f = $('#debtForm');
  f.owner.value = debt?.owner ?? localStorage.getItem('lastOwner') ?? 'Me';
  f.name.value = debt?.name ?? '';
  f.balance.value = debt?.balance ?? '';
  f.apr.value = debt?.apr ?? '';
  f.minPayment.value = debt?.minPayment ?? '';
  f.creditLimit.value = debt?.creditLimit ?? '';
  f.dueDate.value = debt?.dueDate ?? '';
  $('#debtDialog').showModal();
}

// Populate the "whose debt" autocomplete from owners already in use.
function refreshOwnerOptions() {
  const owners = [...new Set([...debts, ...accounts].map((x) => x.owner).filter(Boolean))];
  $('#ownerOptions').innerHTML = owners.map((o) => `<option value="${escapeHtml(o)}">`).join('');
}

function onDialogSubmit(e) {
  if (e.submitter?.value === 'cancel') return;
  const f = e.target;
  const owner = (f.owner.value || 'Me').trim();
  localStorage.setItem('lastOwner', owner);
  const data = {
    name: f.name.value.trim(),
    owner,
    balance: parseFloat(f.balance.value),
    apr: parseFloat(f.apr.value),
    minPayment: parseFloat(f.minPayment.value),
    creditLimit: parseFloat(f.creditLimit.value) || null,
    dueDate: f.dueDate.value || null,
    type: dialogOrigin === 'statement' ? 'from statement' : 'manual',
    source: 'manual',
    origin: dialogOrigin || 'manual',
  };
  if (editingId) {
    const d = debts.find((x) => x.id === editingId);
    if (d.source === 'plaid' && d.account_id) {
      // Persist edits as an override so they survive the next Plaid pull.
      const ov = { name: data.name, apr: data.apr, minPayment: data.minPayment, creditLimit: data.creditLimit, dueDate: data.dueDate, needsTerms: false };
      debtOverrides[d.account_id] = ov;
      saveDebtOverrides();
      Object.assign(d, ov);
    } else {
      Object.assign(d, data);
      saveManualDebts();
    }
  } else {
    debts.push({ ...data, id: cryptoId() });
    saveManualDebts();
  }
  render();
}

function deleteDebt(id) {
  const d = debts.find((x) => x.id === id);
  if (d.source === 'plaid') {
    if (!confirm(`Hide "${d.name}" from your plan? It will stay hidden even after refreshing. (Reconnecting the bank won't bring it back unless you un-hide it.)`)) return;
    if (d.account_id) { excludedKeys.add(d.account_id); saveExcluded(); }
  }
  debts = debts.filter((x) => x.id !== id);
  if (d.source === 'manual') saveManualDebts();
  render();
}

// ===========================================================================
// Statement upload: read a PDF/CSV statement in-browser, auto-detect the
// balance/APR/minimum payment, and open the confirm dialog pre-filled.
// Nothing is uploaded to any server — parsing happens locally.
// ===========================================================================
let statementQueue = [];

async function onStatementUpload(e) {
  const files = [...e.target.files];
  e.target.value = ''; // allow re-uploading the same file later
  if (!files.length) return;

  const owner = (prompt(
    'Whose statement(s) are these? (e.g. Me, Wife, Joint)',
    localStorage.getItem('lastOwner') || 'Me'
  ) || 'Me').trim();

  let txAdded = 0, txSkipped = 0;
  let acctAdded = 0;
  for (const file of files) {
    try {
      const text = await extractText(file);

      // 1. Deposit accounts (checking/savings) — a combined statement can list several.
      const depositAccts = parseDepositSummary(text);
      for (const a of depositAccts) {
        if (accounts.some((x) => x.name === a.name && x.owner === owner && x.source !== 'plaid')) continue;
        accounts.push({ ...a, owner, source: 'manual', origin: 'statement', id: cryptoId() });
        acctAdded++;
      }

      // 2. Credit-card debt — only if the statement actually has card data.
      const hasCard = /minimum payment|payment due date|cardmember|credit card|new balance/i.test(text);
      if (hasCard) {
        statementQueue.push({ ...parseDebtFromText(text, file.name), kind: 'debt', owner });
      } else if (!depositAccts.length) {
        // Fallback: a single deposit-account statement with no summary table.
        statementQueue.push({ ...parseAccountFromText(text, file.name), kind: 'account', owner });
      }

      // 3. Transactions for the budget view.
      const found = parseTransactionsFromStatement(text);
      console.log(`[Debt-Free] "${file.name}": ${text.split('\n').length} lines, ${depositAccts.length} accounts, ${found.length} transactions parsed.`);
      const candidates = text.split('\n').filter((l) => /\d{1,2}[\/-]\d{1,2}/.test(l) && /\d[\d,]*\.\d{2}/.test(l));
      console.log(`[Debt-Free] ${candidates.length} candidate transaction lines (showing up to 30):\n` + candidates.slice(0, 30).join('\n'));
      for (const tx of found) {
        const key = `${tx.date}|${tx.amount}|${tx.description}`;
        if (transactions.some((t) => `${t.date}|${t.amount}|${t.description}` === key)) { txSkipped++; continue; }
        transactions.push({ ...tx, owner, source: 'manual', id: cryptoId() });
        txAdded++;
      }
    } catch (err) {
      console.error('Statement parse error:', err);
      alert(`Couldn't read "${file.name}".\n${err.message}\n\nYou can still add it with “Add manually”.`);
    }
  }
  if (acctAdded) saveAccounts();
  if (txAdded) {
    transactions.sort((a, b) => (a.date < b.date ? 1 : -1));
    saveTransactions();
  }
  if (acctAdded || txAdded) render();
  showNextStatement();
  const bits = [];
  if (acctAdded) bits.push(`${acctAdded} account${acctAdded === 1 ? '' : 's'}`);
  if (txAdded) bits.push(`${txAdded} transaction${txAdded === 1 ? '' : 's'}`);
  if (bits.length) setTimeout(() => alert(`Also imported ${bits.join(' and ')} from the statement` +
    (txSkipped ? ` (${txSkipped} duplicate transactions skipped)` : '') + '.'), 120);
}

// Show the confirm dialog for each parsed statement, one after another.
function showNextStatement() {
  if (!statementQueue.length) return;
  const item = statementQueue.shift();
  if (item.kind === 'account') {
    openAccountDialog(item);
    $('#accountDialog').addEventListener('close', showNextStatement, { once: true });
  } else {
    openDialog(item, statementHintFor(item));
    $('#debtDialog').addEventListener('close', showNextStatement, { once: true });
  }
}

// Parse Navy Federal's "Summary of your deposit accounts" table — one row per
// account: <Name …Checking/Savings> <mask|acct#> $prev $credits $debits $ending $ytd
function parseDepositSummary(text) {
  const out = [];
  const re = /([A-Za-z][A-Za-z .'&-]*?(?:Checking|Savings|Money Market|MMSA))\s+(?:x+|\*+|\d{3,})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})/gi;
  let m;
  while ((m = re.exec(text))) {
    // Strip any leading column-header words that ran into the account name.
    const name = m[1].replace(/^.*\b(?:Dividends|Balance|Debits|Credits|Previous|Withdrawals|YTD|accounts)\b\s*/i, '').trim();
    if (!name || /^total/i.test(name)) continue;
    out.push({
      name,
      type: /savings|money market|mmsa/i.test(name) ? 'savings' : 'checking',
      balance: parseFloat(m[5].replace(/,/g, '')), // 4th of 5 figures = Ending Balance
    });
  }
  return out;
}

// Decide whether an uploaded statement is a debt (credit card) or a deposit account.
function looksLikeDebtStatement(text) {
  if (/minimum payment|amount due|credit card|cardmember|payment due date/i.test(text)) return true;
  if (/checking|savings|share savings|deposit account|available balance/i.test(text)) return false;
  return true; // default to debt — this is a debt-first tool
}

// Pull a checking/savings balance off a deposit-account statement.
function parseAccountFromText(text, filename) {
  const t = text.replace(/\s+/g, ' ');
  const money = (...patterns) => {
    for (const re of patterns) { const m = t.match(re); if (m) return parseFloat(m[1].replace(/[,$\s]/g, '')); }
    return '';
  };
  const balance = money(
    /(?:ending|new|current|present|available) balance[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /balance[^$\d-]{0,15}\$?\s*([\d,]+\.\d{2})/i
  );
  const type = /savings|share savings/i.test(text) ? 'savings' : 'checking';
  const known = ['Navy Federal', 'Capital One', 'Chase', 'Citibank', 'Citi', 'USAA', 'Bank of America', 'Wells Fargo'];
  let name = known.find((k) => new RegExp('\\b' + k.replace(/\s+/g, '\\s+') + '\\b', 'i').test(text)) || '';
  name = (name ? name + ' ' : '') + type.charAt(0).toUpperCase() + type.slice(1);
  return { name, type, balance, source: 'manual', origin: 'statement' };
}

function statementHintFor(item) {
  const got = [], miss = [];
  (item.balance !== '' ? got : miss).push('balance');
  (item.apr !== '' ? got : miss).push('APR');
  (item.minPayment !== '' ? got : miss).push('minimum payment');
  let msg = '📄 <strong>Read from your statement.</strong> ';
  if (got.length) msg += `Found ${got.join(', ')}. `;
  if (miss.length) msg += `Couldn't find ${miss.join(', ')} — please fill in by hand. `;
  return msg + 'Double-check every value before saving.';
}

// Pull text out of a PDF (or read a CSV) entirely in the browser. For PDFs we
// reconstruct rows by grouping text by vertical position, so transaction tables
// survive as lines we can parse.
async function extractText(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || file.type === 'text/csv') {
    return await file.text();
  }
  if (!window.pdfjsLib) throw new Error('PDF reader failed to load (need an internet connection).');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lines = {};
    for (const it of content.items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5]); // vertical position
      (lines[y] ??= []).push({ x: it.transform[4], s: it.str });
    }
    for (const y of Object.keys(lines).map(Number).sort((a, b) => b - a)) {
      const line = lines[y].sort((a, b) => a.x - b.x).map((o) => o.s).join(' ').replace(/\s+/g, ' ').trim();
      if (line) text += line + '\n';
    }
  }
  if (!text.trim()) throw new Error('No readable text found — the PDF may be a scanned image.');
  return text;
}

// Best-effort: pull transaction rows out of a statement's text (lines that
// begin with a date and end with a dollar amount).
function parseTransactionsFromStatement(text, kind) {
  const out = [];
  const year = (text.match(/\b(20\d{2})\b/) || [])[1] || null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\s+(.+?)\s+(\(?-?\$?[\d,]+\.\d{2}\)?-?\s*(?:CR)?)$/i);
    if (!m) continue;
    let [, dateRaw, desc, amtRaw] = m;
    desc = desc.replace(/\s{2,}/g, ' ').trim();
    // Skip summary/total rows that happen to look like transactions.
    if (/minimum payment|new balance|previous balance|statement balance|credit limit|available credit|total\s|past due|finance charge|^balance/i.test(desc)) continue;
    if (!desc || desc.length < 2) continue;
    const date = normalizeStatementDate(dateRaw, year);
    if (!date) continue;
    const value = parseFloat(amtRaw.replace(/[$,()\sCR-]/gi, ''));
    if (Number.isNaN(value) || value === 0) continue;
    // Sign: income/credits/payments/deposits are inflow (+); everything else is outflow (−).
    const category = categorize(desc);
    const isCredit = category === 'Income' || /\bCR\b/i.test(amtRaw) || /^\(.*\)$/.test(amtRaw.trim()) || /-\s*$/.test(amtRaw) ||
      /payment|deposit|refund|credit|interest paid|dividend|payroll|reversal/i.test(desc);
    out.push({ date, description: desc, amount: isCredit ? value : -value, category });
  }
  return out;
}

function normalizeStatementDate(raw, fallbackYear) {
  const m = raw.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (!m) return null;
  let [, mo, d, y] = m;
  if (!y) y = fallbackYear;
  if (!y) return null;
  if (y.length === 2) y = '20' + y;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Heuristics to find the debt figures on a typical credit-card statement.
function parseDebtFromText(text, filename) {
  const t = text.replace(/\s+/g, ' ');
  const money = (...patterns) => {
    for (const re of patterns) {
      const m = t.match(re);
      if (m) return parseFloat(m[1].replace(/[,$\s]/g, ''));
    }
    return '';
  };

  const balance = money(
    /new balance[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /statement balance[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /current balance[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /(?:outstanding|account) balance[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /balance[^$\d-]{0,15}\$?\s*([\d,]+\.\d{2})/i
  );
  const minPayment = money(
    /minimum payment due[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /total minimum payment[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /minimum payment[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i,
    /minimum amount due[^$\d-]{0,25}\$?\s*([\d,]+\.\d{2})/i
  );

  let apr = '';
  const aprM =
    t.match(/(\d{1,2}\.\d{2,3})\s*%\s*(?:apr|annual percentage rate)/i) ||
    t.match(/(?:purchase )?(?:apr|annual percentage rate)[^%\d]{0,25}(\d{1,2}\.\d{2,3})\s*%/i);
  if (aprM) apr = parseFloat(aprM[1]);

  // Credit limit (may be shown without cents) and payment due date.
  const limM = t.match(/(?:credit limit|total credit line|credit line)[^$\d-]{0,25}\$?\s*([\d,]+(?:\.\d{2})?)/i);
  const creditLimit = limM ? parseFloat(limM[1].replace(/,/g, '')) : '';
  const year = (text.match(/\b(20\d{2})\b/) || [])[1] || null;
  const dueM = t.match(/(?:payment due date|due date)[^\d]{0,15}(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)/i);
  const dueDate = dueM ? (normalizeStatementDate(dueM[1], year) || '') : '';

  // Try to name it after a recognizable issuer; fall back to the filename.
  const known = ['Navy Federal', 'Capital One', 'Chase', 'Citibank', 'Citi', 'Discover',
    'American Express', 'Amex', 'Bank of America', 'Wells Fargo', 'USAA', 'Synchrony', 'Barclays'];
  let name = known.find((k) => new RegExp('\\b' + k.replace(/\s+/g, '\\s+') + '\\b', 'i').test(text)) || '';
  if (!name) name = filename.replace(/\.(pdf|csv)$/i, '').replace(/[_-]+/g, ' ');

  return { name, balance, apr, minPayment, creditLimit, dueDate, source: 'manual', origin: 'statement', type: 'from statement' };
}

// ===========================================================================
// Accounts (checking / savings / cash) — assets, for net worth
// ===========================================================================
function loadAccounts() {
  try { return JSON.parse(localStorage.getItem('accounts') || '[]'); } catch { return []; }
}
function saveAccounts() {
  // Persist only manual/statement accounts; Plaid ones are refreshed live.
  localStorage.setItem('accounts', JSON.stringify(accounts.filter((a) => a.source !== 'plaid')));
}

let editingAccountId = null;
function openAccountDialog(acct = null) {
  editingAccountId = acct?.id ?? null;
  $('#accountDialogTitle').textContent = acct ? 'Edit account' : 'Add account';
  refreshOwnerOptions();
  const f = $('#accountForm');
  f.owner.value = acct?.owner ?? localStorage.getItem('lastOwner') ?? 'Me';
  f.name.value = acct?.name ?? '';
  f.type.value = acct?.type ?? 'checking';
  f.balance.value = acct?.balance ?? '';
  $('#accountDialog').showModal();
}
function onAccountSubmit(e) {
  if (e.submitter?.value === 'cancel') return;
  const f = e.target;
  const owner = (f.owner.value || 'Me').trim();
  localStorage.setItem('lastOwner', owner);
  const data = {
    name: f.name.value.trim(),
    owner,
    type: f.type.value,
    balance: parseFloat(f.balance.value) || 0,
    source: 'manual',
  };
  if (editingAccountId) {
    Object.assign(accounts.find((a) => a.id === editingAccountId), data);
  } else {
    accounts.push({ ...data, id: cryptoId() });
  }
  saveAccounts();
  render();
}
function deleteAccount(id) {
  const a = accounts.find((x) => x.id === id);
  if (a?.source === 'plaid') {
    if (!confirm(`Hide "${a.name}" from your accounts? It will stay hidden even after refreshing.`)) return;
    if (a.account_id) { excludedKeys.add(a.account_id); saveExcluded(); }
  }
  accounts = accounts.filter((x) => x.id !== id);
  if (a?.source !== 'plaid') saveAccounts();
  render();
}

function renderAccounts() {
  const list = $('#accountList');
  $('#accountEmpty').hidden = accounts.length > 0;
  list.innerHTML = accounts.map((a) => `
    <div class="debt">
      <div>
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="meta"><span class="pill">${a.source === 'plaid' ? '🔗 ' + escapeHtml(a.institution || 'linked') : escapeHtml(a.owner || 'Me')}</span> ${escapeHtml(a.type)}</div>
      </div>
      <div class="num"><span class="label">Balance</span>${fmt2(a.balance)}</div>
      <div class="num"></div><div class="num"></div>
      <div class="row-actions">
        <button class="ghost" data-aedit="${a.id}">Edit</button>
        <button class="ghost" data-adel="${a.id}">✕</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-aedit]').forEach((b) =>
    b.addEventListener('click', () => openAccountDialog(accounts.find((a) => a.id === b.dataset.aedit))));
  list.querySelectorAll('[data-adel]').forEach((b) =>
    b.addEventListener('click', () => deleteAccount(b.dataset.adel)));

  // Net worth = assets − debts
  const assets = accounts.reduce((s, a) => s + a.balance, 0);
  const owed = debts.reduce((s, d) => s + d.balance, 0);
  const net = assets - owed;
  $('#netWorth').innerHTML = (accounts.length || debts.length) ? `
    <div class="stats" style="margin-top:14px">
      <div class="stat"><div class="key">Cash (assets)</div><div class="value">${fmt(assets)}</div></div>
      <div class="stat"><div class="key">Debts owed</div><div class="value">${fmt(owed)}</div></div>
      <div class="stat"><div class="key">Net worth</div><div class="value ${net >= 0 ? 'good' : ''}" style="${net < 0 ? 'color:var(--danger)' : ''}">${fmt(net)}</div></div>
    </div>` : '';
}

// ===========================================================================
// Transactions: import a bank CSV, categorize, and build a budget view
// ===========================================================================
function loadTransactions() {
  try { return JSON.parse(localStorage.getItem('transactions') || '[]'); } catch { return []; }
}
function saveTransactions() {
  // Persist only manual/CSV/statement transactions; Plaid ones are refreshed live.
  localStorage.setItem('transactions', JSON.stringify(transactions.filter((t) => t.source !== 'plaid')));
}
function clearTransactions() {
  if (!confirm('Remove all imported transactions?')) return;
  transactions = [];
  saveTransactions();
  render();
}

// Keyword → category rules (first match wins). Order matters.
const CATEGORY_RULES = [
  [/payroll|direct dep|salary|dfas|defense finance|navy.*pay|disbursement|deposit from|interest paid|dividend/i, 'Income'],
  [/transfer|xfer|to share|from share|to savings|to checking|online banking transfer|móbile|mobile deposit/i, 'Transfer'],
  [/payment.*thank you|card payment|cardmember|cc payment|credit card payment|loan payment|autopay/i, 'Debt payment'],
  [/mortgage|\brent\b|landlord|apartment|leasing/i, 'Housing'],
  [/electric|water|sewer|gas company|utility|comcast|xfinity|verizon|at&t|t-mobile|spectrum|internet|power co/i, 'Utilities'],
  [/grocery|walmart|kroger|publix|safeway|aldi|costco|whole ?foods|food lion|commissary|wegmans|harris teeter|trader joe/i, 'Groceries'],
  [/restaurant|mcdonald|starbucks|chipotle|doordash|uber eats|grubhub|pizza|coffee|cafe|dunkin|wendy|taco|chick-?fil/i, 'Dining'],
  [/shell|exxon|chevron|\bbp\b|gas station|fuel|marathon|speedway|wawa|sheetz|circle k|valero|sunoco/i, 'Gas'],
  [/amazon|target|ebay|best buy|home depot|lowe'?s|etsy|wayfair/i, 'Shopping'],
  [/netflix|spotify|hulu|disney|subscription|prime video|youtube|apple\.com|patreon|audible/i, 'Subscriptions'],
  [/insurance|geico|progressive|state farm|allstate|usaa.*ins/i, 'Insurance'],
  [/cvs|walgreens|pharmacy|\bdr\.|doctor|medical|dental|hospital|clinic|vision/i, 'Health'],
  [/atm|cash withdrawal|withdrawal/i, 'Cash'],
  [/uber|lyft|parking|toll|metro|transit|airline|delta|united|american air/i, 'Transport'],
];
function categorize(desc) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(desc)) return cat;
  return 'Other';
}

// Canonical category list for dropdowns and budget targets.
const CATEGORIES = ['Income', 'Transfer', 'Debt payment', 'Housing', 'Utilities', 'Groceries',
  'Dining', 'Gas', 'Transport', 'Shopping', 'Subscriptions', 'Insurance', 'Health', 'Cash', 'Other'];

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
let categoryOverrides = loadJSON('categoryOverrides', {}); // txKey -> category
let budgetTargets = loadJSON('budgetTargets', {});         // category -> monthly $ target
let budgetFilter = { month: 'all', owner: 'all' };

// Stable signature for a transaction (Plaid txns get fresh ids each pull).
const txKey = (t) => `${t.date}|${t.amount}|${t.description}`;
// Effective category — a user override beats the auto-detected one.
const catOf = (t) => categoryOverrides[txKey(t)] || t.category || 'Other';
// Categories that are real income/spending (not money just moving around).
const isFlowCat = (c) => c !== 'Transfer' && c !== 'Debt payment';

function filteredTx() {
  return transactions.filter((t) =>
    (budgetFilter.month === 'all' || t.date.slice(0, 7) === budgetFilter.month) &&
    (budgetFilter.owner === 'all' || (t.owner || 'Me') === budgetFilter.owner));
}
function monthSpanOf(txs) {
  if (!txs.length) return 1;
  const dates = txs.map((t) => t.date).sort();
  const a = new Date(dates[0]), b = new Date(dates[dates.length - 1]);
  return Math.max(1, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1);
}

async function onTransactionsUpload(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  let added = 0, skipped = 0;
  for (const file of files) {
    try {
      const text = await file.text();
      const rows = parseTransactionsCsv(text);
      for (const r of rows) {
        // de-dupe on date+amount+description
        const key = `${r.date}|${r.amount}|${r.description}`;
        if (transactions.some((t) => `${t.date}|${t.amount}|${t.description}` === key)) { skipped++; continue; }
        transactions.push({ ...r, source: 'manual', id: cryptoId() });
        added++;
      }
    } catch (err) {
      console.error('CSV parse error:', err);
      alert(`Couldn't read "${file.name}".\n${err.message}`);
    }
  }
  transactions.sort((a, b) => (a.date < b.date ? 1 : -1));
  saveTransactions();
  render();
  if (added || skipped) alert(`Imported ${added} transaction${added === 1 ? '' : 's'}` + (skipped ? ` (${skipped} duplicates skipped).` : '.'));
}

// Parse a bank-export CSV with auto column detection.
function parseTransactionsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows.');
  const rows = lines.map(splitCsvLine);
  const header = rows[0].map((h) => h.toLowerCase().trim());

  const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find('date', 'posted', 'transaction date');
  const iDesc = find('description', 'memo', 'payee', 'name', 'merchant', 'detail');
  const iAmt = find('amount', 'value');
  const iDebit = find('debit', 'withdrawal');
  const iCredit = find('credit', 'deposit');
  if (iDate < 0) throw new Error('No date column found in CSV.');
  if (iAmt < 0 && iDebit < 0 && iCredit < 0) throw new Error('No amount/debit/credit column found.');

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols.length || !cols[iDate]) continue;
    const date = normalizeDate(cols[iDate]);
    if (!date) continue;
    const description = (iDesc >= 0 ? cols[iDesc] : '').trim() || '(no description)';
    let amount;
    if (iAmt >= 0 && cols[iAmt] !== undefined && cols[iAmt] !== '') {
      amount = parseAmount(cols[iAmt]);
    } else {
      const debit = iDebit >= 0 ? parseAmount(cols[iDebit]) : 0;
      const credit = iCredit >= 0 ? parseAmount(cols[iCredit]) : 0;
      amount = (credit || 0) - Math.abs(debit || 0);
    }
    if (amount === null || Number.isNaN(amount)) continue;
    out.push({ date, description, amount, category: categorize(description) });
  }
  if (!out.length) throw new Error('No transactions could be parsed from this CSV.');
  return out;
}

// Split a CSV line handling quoted fields with commas.
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (c === ',' && !inQ) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function parseAmount(s) {
  if (s == null) return null;
  let v = String(s).replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.replace(/[()]/g, ''); } // (12.34) = negative
  const n = parseFloat(v);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}
function normalizeDate(s) {
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);              // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);          // M/D/YYYY
  if (m) {
    let [_, mo, d, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// --- Budget rendering -------------------------------------------------------
function monthSpan() { return monthSpanOf(transactions); }
function saveOverrides() { localStorage.setItem('categoryOverrides', JSON.stringify(categoryOverrides)); }

// Normalize a payee/description into a merchant name (drop store numbers, ids).
function normalizeMerchant(desc) {
  return desc.replace(/[#*]/g, ' ').replace(/\b\d[\d-]{2,}\b/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 28) || desc.toUpperCase();
}

function populateBudgetFilters() {
  const months = [...new Set(transactions.map((t) => t.date.slice(0, 7)))].sort().reverse();
  const owners = [...new Set(transactions.map((t) => t.owner || 'Me'))];
  const mSel = $('#filterMonth'), oSel = $('#filterOwner');
  if (budgetFilter.month !== 'all' && !months.includes(budgetFilter.month)) budgetFilter.month = 'all';
  if (budgetFilter.owner !== 'all' && !owners.includes(budgetFilter.owner)) budgetFilter.owner = 'all';
  mSel.innerHTML = `<option value="all">All months</option>` + months.map((m) => `<option value="${m}">${m}</option>`).join('');
  oSel.innerHTML = `<option value="all">Everyone</option>` + owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  mSel.value = budgetFilter.month;
  oSel.value = budgetFilter.owner;
}

function renderBudget() {
  const has = transactions.length > 0;
  $('#budgetEmpty').hidden = has;
  $('#budgetView').hidden = !has;
  $('#clearTxBtn').hidden = !has;
  if (!has) return;

  populateBudgetFilters();
  const tx = filteredTx();
  const months = monthSpanOf(tx);

  const income = tx.filter((t) => isFlowCat(catOf(t)) && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const spendTx = tx.filter((t) => t.amount < 0 && isFlowCat(catOf(t)));
  const spending = spendTx.reduce((s, t) => s + Math.abs(t.amount), 0);
  const debtPaid = tx.filter((t) => catOf(t) === 'Debt payment' && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const net = income - spending - debtPaid;
  const per = (v) => v / months;
  const multi = months > 1;

  $('#budgetStats').innerHTML = `
    <div class="stat"><div class="key">Income${multi ? ' /mo' : ''}</div><div class="value good">${fmt(per(income))}</div></div>
    <div class="stat"><div class="key">Spending${multi ? ' /mo' : ''}</div><div class="value">${fmt(per(spending))}</div></div>
    <div class="stat"><div class="key">Debt pmts${multi ? ' /mo' : ''}</div><div class="value">${fmt(per(debtPaid))}</div></div>
    <div class="stat"><div class="key">Left over${multi ? ' /mo' : ''}</div><div class="value ${net >= 0 ? 'good' : ''}" style="${net < 0 ? 'color:var(--danger)' : ''}">${fmt(per(net))}</div></div>
  `;
  const perMonthSurplus = Math.floor(per(net) / 5) * 5;
  if (perMonthSurplus > 0) {
    $('#budgetStats').insertAdjacentHTML('beforeend',
      `<div class="stat" style="cursor:pointer" id="useSurplus" title="Set this as your debt extra payment">
        <div class="key">💡 Put toward debt</div><div class="value good">${fmt(perMonthSurplus)}/mo →</div></div>`);
    $('#useSurplus')?.addEventListener('click', () => {
      $('#extra').value = perMonthSurplus;
      renderPlan(); renderAnalytics(); renderRecommendations();
      $('#resultsCard').scrollIntoView({ behavior: 'smooth' });
    });
  }

  const byCat = categoryTotals(spendTx);
  renderInsights(byCat, spending, months, net);
  renderCategoryChart(byCat, spending, months);
  renderMerchants(spendTx);
  renderRecurring();
  renderTrendChart();
  renderTxList();
  $('#txCount').textContent = tx.length;
}

function categoryTotals(spendTx) {
  const byCat = {};
  for (const t of spendTx) byCat[catOf(t)] = (byCat[catOf(t)] || 0) + Math.abs(t.amount);
  return byCat;
}

function renderInsights(byCat, spending, months, net) {
  const el = $('#insightCallouts');
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const bits = [];
  if (rows.length) {
    const [cat, amt] = rows[0];
    bits.push(`💰 Your biggest expense is <strong>${escapeHtml(cat)}</strong> at <strong>${fmt(amt / months)}/mo</strong> (${((amt / spending) * 100).toFixed(0)}% of spending).`);
  }
  const rec = recurringCharges();
  if (rec.total > 0) {
    bits.push(`🔁 You have about <strong>${fmt(rec.total)}/mo</strong> in recurring charges. Cutting half would free <strong>${fmt(rec.total / 2)}/mo</strong> for debt.`);
  }
  // Over-budget warnings
  const over = Object.entries(budgetTargets).filter(([c, tgt]) => tgt > 0 && (byCat[c] || 0) / months > tgt)
    .map(([c, tgt]) => `${c} (+${fmt((byCat[c] / months) - tgt)})`);
  if (over.length) bits.push(`⚠️ Over budget on <strong>${over.join(', ')}</strong> this period.`);

  el.innerHTML = bits.map((b) => `<div class="insight">${b}</div>`).join('');
}

function renderCategoryChart(byCat, spending, months) {
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  $('#catChart').innerHTML = rows.map(([cat, amt], i) => {
    const tgt = budgetTargets[cat];
    const perMo = amt / months;
    let tgtTxt = '';
    if (tgt > 0) {
      const cls = perMo > tgt ? 'over-budget' : 'under-budget';
      tgtTxt = ` <span class="${cls}">/ ${fmt(tgt)} ${perMo > tgt ? 'over' : 'ok'}</span>`;
    }
    const tgtMark = tgt > 0 ? `<div style="position:absolute;top:0;bottom:0;left:${Math.min(100, (tgt * months / max) * 100)}%;width:2px;background:var(--warn)"></div>` : '';
    return `
    <div class="bar-row clickable" data-cat="${escapeHtml(cat)}" title="Click to see ${escapeHtml(cat)} transactions">
      <span class="bar-label">${escapeHtml(cat)}</span>
      <div class="bar-track" style="position:relative"><div class="bar-fill" style="width:${(amt / max) * 100}%;background:${COLORS[i % COLORS.length]}"></div>${tgtMark}</div>
      <span class="bar-val">${fmt(perMo)}${months > 1 ? '/mo' : ''}${tgtTxt}</span>
    </div>`;
  }).join('') || '<p class="muted small">No spending in this view.</p>';
  $('#catChart').querySelectorAll('[data-cat]').forEach((el) =>
    el.addEventListener('click', () => {
      const cat = el.dataset.cat;
      openTxList(`${cat} — spending`, filteredTx().filter((t) => t.amount < 0 && catOf(t) === cat).sort((a, b) => (a.date < b.date ? 1 : -1)));
    }));
}

function renderMerchants(spendTx) {
  const byM = {};
  for (const t of spendTx) {
    const m = normalizeMerchant(t.description);
    byM[m] = byM[m] || { total: 0, count: 0 };
    byM[m].total += Math.abs(t.amount);
    byM[m].count++;
  }
  const rows = Object.entries(byM).sort((a, b) => b[1].total - a[1].total).slice(0, 8);
  const max = rows[0]?.[1].total || 1;
  $('#merchantChart').innerHTML = rows.map(([m, d], i) => `
    <div class="bar-row clickable" data-merchant="${escapeHtml(m)}" title="Click to see ${escapeHtml(m)} transactions">
      <span class="bar-label" title="${escapeHtml(m)}">${escapeHtml(m)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(d.total / max) * 100}%;background:${COLORS[i % COLORS.length]}"></div></div>
      <span class="bar-val">${fmt(d.total)} · ${d.count}×</span>
    </div>`).join('') || '<p class="muted small">No spending in this view.</p>';
  $('#merchantChart').querySelectorAll('[data-merchant]').forEach((el) =>
    el.addEventListener('click', () => {
      const m = el.dataset.merchant;
      openTxList(m, filteredTx().filter((t) => t.amount < 0 && normalizeMerchant(t.description) === m).sort((a, b) => (a.date < b.date ? 1 : -1)));
    }));
}

// Detect recurring charges: same merchant + similar amount across 2+ months.
function recurringCharges() {
  const groups = {};
  for (const t of filteredTx()) {
    if (t.amount >= 0 || !isFlowCat(catOf(t))) continue;
    const key = normalizeMerchant(t.description) + '|' + Math.round(Math.abs(t.amount));
    (groups[key] = groups[key] || []).push(t);
  }
  const recurring = [];
  for (const [key, items] of Object.entries(groups)) {
    const monthsHit = new Set(items.map((t) => t.date.slice(0, 7)));
    if (monthsHit.size >= 2) {
      const amt = Math.abs(items[0].amount);
      recurring.push({ merchant: key.split('|')[0], amount: amt, months: monthsHit.size, count: items.length });
    }
  }
  recurring.sort((a, b) => b.amount - a.amount);
  return { list: recurring.slice(0, 10), total: recurring.reduce((s, r) => s + r.amount, 0) };
}

function renderRecurring() {
  const { list, total } = recurringCharges();
  if (!list.length) {
    $('#recurringList').innerHTML = '<p class="muted small">No recurring charges detected (need 2+ months of data).</p>';
    return;
  }
  $('#recurringList').innerHTML =
    `<div class="recurring-row" style="font-weight:600"><span>~${fmt(total)}/mo total</span><span></span><span></span></div>` +
    list.map((r) => `
      <div class="recurring-row clickable" data-merchant="${escapeHtml(r.merchant)}" title="Click to see these charges">
        <span>${escapeHtml(r.merchant)}</span>
        <span class="freq">${r.months} mo · ${r.count}×</span>
        <span class="bar-val">${fmt2(r.amount)}/mo</span>
      </div>`).join('');
  $('#recurringList').querySelectorAll('[data-merchant]').forEach((el) =>
    el.addEventListener('click', () => {
      const m = el.dataset.merchant;
      openTxList(`${m} — recurring`, filteredTx().filter((t) => t.amount < 0 && normalizeMerchant(t.description) === m).sort((a, b) => (a.date < b.date ? 1 : -1)));
    }));
}

function renderTrendChart() {
  const byMonth = {};
  for (const t of transactions) {
    if (budgetFilter.owner !== 'all' && (t.owner || 'Me') !== budgetFilter.owner) continue;
    const m = t.date.slice(0, 7);
    byMonth[m] ??= { income: 0, spend: 0 };
    const c = catOf(t);
    if (!isFlowCat(c)) continue;
    if (t.amount > 0) byMonth[m].income += t.amount;
    else byMonth[m].spend += Math.abs(t.amount);
  }
  const months = Object.keys(byMonth).sort();
  if (months.length < 2) {
    $('#trendChart').innerHTML = '<p class="muted small">Need 2+ months of data to show trends.</p>';
    return;
  }
  const max = Math.max(...months.map((m) => Math.max(byMonth[m].income, byMonth[m].spend)), 1);
  $('#trendChart').innerHTML = months.map((m) => {
    const d = byMonth[m];
    return `<div class="bar-row clickable" data-month="${m}" title="Click to view ${m}" style="grid-template-columns:64px 1fr 1fr">
      <span class="bar-label">${m}</span>
      <div class="bar-track" title="Income ${fmt(d.income)}"><div class="bar-fill" style="width:${(d.income / max) * 100}%;background:var(--accent)"></div></div>
      <div class="bar-track" title="Spending ${fmt(d.spend)}"><div class="bar-fill" style="width:${(d.spend / max) * 100}%;background:var(--danger)"></div></div>
    </div>`;
  }).join('') + `<div class="legend"><span><i style="background:var(--accent)"></i>Income</span><span><i style="background:var(--danger)"></i>Spending</span> · <span class="muted">click a month to drill in</span></div>`;
  $('#trendChart').querySelectorAll('[data-month]').forEach((el) =>
    el.addEventListener('click', () => { budgetFilter.month = el.dataset.month; renderBudget(); }));
}

let shownTx = [];
function renderTxList() {
  const q = ($('#txSearch')?.value || '').toLowerCase();
  shownTx = filteredTx().filter((t) => !q || t.description.toLowerCase().includes(q) || catOf(t).toLowerCase().includes(q)).slice(0, 400);
  $('#txList').innerHTML = shownTx.map((t, i) => `
    <div class="item">
      <span>${t.date} · ${escapeHtml(t.description)}
        <select class="cat-pill-select" data-i="${i}">${CATEGORIES.map((c) => `<option ${c === catOf(t) ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </span>
      <span class="when" style="color:${t.amount < 0 ? 'var(--danger)' : 'var(--accent)'}">${t.amount < 0 ? '-' : '+'}${fmt2(Math.abs(t.amount))}</span>
    </div>`).join('') || '<p class="muted small">No matches.</p>';
  $('#txList').querySelectorAll('select[data-i]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const t = shownTx[+sel.dataset.i];
      categoryOverrides[txKey(t)] = sel.value;
      saveOverrides();
      render();
    }));
}

// Budget targets dialog
function openTargetsDialog() {
  const cats = CATEGORIES.filter((c) => isFlowCat(c) && c !== 'Income');
  $('#targetsFields').innerHTML = cats.map((c) =>
    `<label>${c}<input type="number" min="0" step="10" name="${c}" value="${budgetTargets[c] ?? ''}" placeholder="—" /></label>`).join('');
  $('#targetsDialog').showModal();
}
function onTargetsSubmit(e) {
  if (e.submitter?.value === 'cancel') return;
  const f = e.target;
  const next = {};
  for (const c of CATEGORIES) {
    const field = f.elements[c];
    if (field && field.value) next[c] = parseFloat(field.value);
  }
  budgetTargets = next;
  localStorage.setItem('budgetTargets', JSON.stringify(budgetTargets));
  render();
}

// ===========================================================================
// Payoff engine  (the heart of the tool)
// ===========================================================================
// Simulates paying every debt month by month. Each month you pay every
// minimum, then throw all remaining money at ONE target debt chosen by the
// strategy. When a debt is cleared, its freed-up payment rolls onto the next
// (the snowball effect) — total monthly outlay stays constant.
function simulate(inputDebts, strategy, extra, priorityId) {
  const list = inputDebts.map((d) => ({ ...d, balance: d.balance }));
  const totalMin = list.reduce((s, d) => s + d.minPayment, 0);
  const monthlyBudget = totalMin + Math.max(0, extra);

  let months = 0;
  let totalInterest = 0;
  const payoffOrder = [];
  // trajectory[0] = today's starting balance; one entry per month after.
  const startBalance = list.reduce((s, d) => s + d.balance, 0);
  const trajectory = [{ month: 0, balance: startBalance, interest: 0 }];
  const MAX_MONTHS = 1200; // 100-year safety cap

  const order = (active) => {
    const sorted = [...active].sort((a, b) =>
      strategy === 'avalanche' ? b.apr - a.apr : a.balance - b.balance
    );
    // Optionally force one debt to the front of the attack order.
    if (priorityId) return sorted.filter((d) => d.id === priorityId).concat(sorted.filter((d) => d.id !== priorityId));
    return sorted;
  };

  while (list.some((d) => d.balance > 0.005) && months < MAX_MONTHS) {
    months++;
    // 1. Accrue one month of interest.
    let monthInterest = 0;
    for (const d of list) {
      if (d.balance > 0) {
        const interest = d.balance * (d.apr / 100 / 12);
        d.balance += interest;
        totalInterest += interest;
        monthInterest += interest;
      }
    }
    // 2. Pay the minimum on every active debt.
    let pool = monthlyBudget;
    const active = list.filter((d) => d.balance > 0.005);
    for (const d of active) {
      const pay = Math.min(d.minPayment, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
    }
    // 3. Throw everything left at the target debt(s), in strategy order.
    for (const d of order(active)) {
      if (pool <= 0.005) break;
      if (d.balance <= 0.005) continue;
      const pay = Math.min(pool, d.balance);
      d.balance -= pay;
      pool -= pay;
    }
    // 4. Record any debts that just got cleared.
    for (const d of active) {
      if (d.balance <= 0.005 && !payoffOrder.find((p) => p.id === d.id)) {
        payoffOrder.push({ id: d.id, name: d.name, owner: d.owner || 'Me', month: months });
      }
    }
    // 5. Snapshot total remaining balance and interest paid this month.
    const remaining = list.reduce((s, d) => s + Math.max(0, d.balance), 0);
    trajectory.push({ month: months, balance: remaining, interest: monthInterest });
  }

  const stalled = months >= MAX_MONTHS;
  return { months, totalInterest, payoffOrder, monthlyBudget, totalMin, stalled, startBalance, trajectory };
}

// ===========================================================================
// Rendering
// ===========================================================================
function render() {
  renderDebts();
  renderAccounts();
  renderPlan();
  renderRecommendations();
  renderAnalytics();
  renderBudget();
}

// Credit utilization label, colored by how high it is (lenders like < 30%).
function utilizationLabel(d) {
  if (!d.creditLimit) return '';
  const pct = Math.round((d.balance / d.creditLimit) * 100);
  const color = pct >= 80 ? 'var(--danger)' : pct >= 30 ? 'var(--warn)' : 'var(--accent)';
  return `<span style="color:${color}">${pct}% of ${fmt(d.creditLimit)} used</span>`;
}

function renderDebts() {
  const list = $('#debtList');
  list.innerHTML = '';
  $('#emptyState').hidden = debts.length > 0;

  // Restore-hidden button reflects how many Plaid items are currently hidden.
  const restoreBtn = $('#restoreHiddenBtn');
  restoreBtn.hidden = excludedKeys.size === 0;
  restoreBtn.textContent = `↩ Restore ${excludedKeys.size} hidden`;

  if (!debts.length) return;

  // Group debts by owner.
  const groups = new Map();
  for (const d of debts) {
    const owner = d.owner || 'Me';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(d);
  }

  const debtRow = (d) => `
    <div class="debt clickable" data-detail="${d.id}" title="Click for details">
      <div>
        <div class="name">${escapeHtml(d.name)}</div>
        <div class="meta">
          <span class="pill">${d.source === 'plaid' ? '🔗 ' + escapeHtml(d.institution || 'linked') : d.origin === 'statement' ? '📄 statement' : '✍️ manual'}</span>
          ${d.type ? escapeHtml(d.type) : ''}${d.creditLimit ? ` · ${utilizationLabel(d)}` : ''}${d.dueDate ? ` · due ${escapeHtml(d.dueDate)}` : ''}${d.paymentInferred ? ` · <span style="color:var(--accent-2)">payment auto-detected</span>` : ''}${d.needsTerms ? ` · <span style="color:var(--warn)">⚠️ click Edit to set APR${d.minPayment ? '' : ' &amp; payment'}</span>` : ''}
        </div>
      </div>
      <div class="num"><span class="label">Balance</span>${fmt2(d.balance)}</div>
      <div class="num"><span class="label">APR</span>${d.apr.toFixed(2)}%</div>
      <div class="num"><span class="label">Min/mo</span>${fmt2(d.minPayment)}</div>
      <div class="row-actions">
        <button class="ghost" data-edit="${d.id}">Edit</button>
        <button class="ghost" data-del="${d.id}">✕</button>
      </div>
    </div>`;

  // Only show owner headers when there's more than one person.
  const multiOwner = groups.size > 1;
  let html = '';
  for (const [owner, items] of groups) {
    const subtotal = items.reduce((s, d) => s + d.balance, 0);
    if (multiOwner) {
      html += `<div class="owner-header">
        <span>${escapeHtml(owner)}</span>
        <span class="muted small">${items.length} debt${items.length > 1 ? 's' : ''} · ${fmt(subtotal)}</span>
      </div>`;
    }
    html += items.map(debtRow).join('');
  }

  if (multiOwner) {
    const total = debts.reduce((s, d) => s + d.balance, 0);
    html += `<div class="owner-header household">
      <span>Household total</span><span>${fmt(total)}</span>
    </div>`;
  }

  list.innerHTML = html;
  list.querySelectorAll('[data-detail]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('.row-actions')) return; // let Edit/✕ do their thing
      openDebtDetail(el.dataset.detail);
    })
  );
  list.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openDialog(debts.find((d) => d.id === b.dataset.edit)))
  );
  list.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteDebt(b.dataset.del))
  );
}

// --- Debt drill-down --------------------------------------------------------
let detailDebtId = null;
function openDebtDetail(id) {
  const d = debts.find((x) => x.id === id);
  if (!d) return;
  detailDebtId = id;
  $('#detailEditBtn').style.display = '';
  const strategy = $('#strategy').value;
  const extra = parseFloat($('#extra').value) || 0;
  const monthlyInterest = d.balance * (d.apr / 100 / 12);
  const totalDebt = debts.reduce((s, x) => s + x.balance, 0);
  const share = totalDebt ? (d.balance / totalDebt) * 100 : 0;
  const cleared = simulate(debts, strategy, extra).payoffOrder.find((p) => p.id === id);

  const cells = [
    ['Balance', fmt2(d.balance)],
    ['APR', d.apr.toFixed(2) + '%'],
    ['Min payment', fmt2(d.minPayment)],
    ['Interest / mo', fmt2(monthlyInterest)],
  ];
  if (d.creditLimit) {
    cells.push(['Credit limit', fmt(d.creditLimit)]);
    cells.push(['Utilization', Math.round((d.balance / d.creditLimit) * 100) + '%']);
  }
  if (d.dueDate) cells.push(['Due date', d.dueDate]);
  cells.push(['Interest / yr', fmt(monthlyInterest * 12)]);
  cells.push(['% of your debt', share.toFixed(0) + '%']);

  // Target-this-first impact across all debts.
  const base = simulate(debts, strategy, extra);
  const targeted = simulate(debts, strategy, extra, id);
  const tgtSaved = base.totalInterest - targeted.totalInterest;
  let targetHtml = '';
  if (debts.length > 1 && !base.stalled && !targeted.stalled) {
    if (tgtSaved >= 1) {
      targetHtml = `<div class="insight">🎯 <strong>Attack this debt first</strong> and you'd save <strong>${fmt(tgtSaved)}</strong> in total interest across all your debts (vs your current ${cap(strategy)} order).</div>`;
    } else if (tgtSaved <= -1) {
      targetHtml = `<div class="insight" style="background:var(--card-2);border-color:var(--border)">Targeting this first would cost <strong>${fmt(-tgtSaved)}</strong> more interest than your current order — it's not your most efficient next target.</div>`;
    } else {
      targetHtml = `<div class="insight" style="background:var(--card-2);border-color:var(--border)">Targeting this first is about the same as your current order.</div>`;
    }
  }

  // Payment history from transactions.
  const pays = paymentHistory(d);
  let payHtml = '';
  if (pays.list.length) {
    payHtml = `<div class="detail-section"><h4>Payment history</h4>
      <div class="detail-grid">
        <div class="cell"><div class="k">Paid this year</div><div class="v">${fmt(pays.thisYear)}</div></div>
        <div class="cell"><div class="k">Avg payment</div><div class="v">${fmt2(pays.avg)}</div></div>
        <div class="cell"><div class="k">Payments</div><div class="v">${pays.list.length}</div></div>
      </div>
      <div class="detail-tx schedule" style="margin-top:8px">
        ${pays.list.slice(0, 10).map((t) => `<div class="item"><span>${t.date} · ${escapeHtml(t.description)}</span><span class="when" style="color:var(--accent)">${fmt2(Math.abs(t.amount))}</span></div>`).join('')}
      </div></div>`;
  }

  const maxExtra = Math.max(500, Math.ceil((d.balance / 12) / 50) * 50);
  $('#detailContent').innerHTML = `
    <div class="detail-head">
      <h3>${escapeHtml(d.name)}</h3>
      <div class="sub">${d.source === 'plaid' ? '🔗 ' + escapeHtml(d.institution || 'linked') : d.origin === 'statement' ? '📄 statement' : '✍️ manual'} · ${escapeHtml(d.type || 'debt')} · ${escapeHtml(d.owner || 'Me')}</div>
    </div>
    <div class="detail-grid">
      ${cells.map(([k, v]) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
    </div>
    ${cleared ? `<div class="insight">🗓️ Your current plan clears this <strong>${dateAfter(cleared.month)}</strong> (${humanMonths(cleared.month)} from now).</div>` : ''}
    ${targetHtml}
    <div class="detail-section">
      <h4>Pay extra on just this debt</h4>
      <div class="row" style="gap:10px;align-items:center">
        <input type="range" id="detailExtra" min="0" max="${maxExtra}" step="25" value="0" style="flex:1" />
        <span id="detailExtraLabel" style="min-width:90px;text-align:right;font-variant-numeric:tabular-nums">+$0/mo</span>
      </div>
      <div id="detailPayoff"></div>
    </div>
    ${payHtml}
  `;
  // Wire the slider and render the initial payoff chart/schedule.
  const slider = $('#detailExtra');
  slider.addEventListener('input', () => {
    $('#detailExtraLabel').textContent = `+${fmt(+slider.value)}/mo`;
    updateDetailPayoff(d, +slider.value);
  });
  updateDetailPayoff(d, 0);
  $('#detailDialog').showModal();
}

function updateDetailPayoff(d, extraOnThis) {
  const box = $('#detailPayoff');
  const a = amortize(d, extraOnThis);
  const baseA = amortize(d, 0);
  if (a.stalled) {
    box.innerHTML = `<div class="insight" style="background:#2b2410;border-color:#4d3f12;color:var(--warn)">⚠️ This payment doesn't cover the interest — the balance never clears. Increase it (or set an APR/payment via Edit).</div>`;
    return;
  }
  const monthsSaved = baseA.months - a.months;
  const interestSaved = baseA.totalInterest - a.totalInterest;
  const summary = extraOnThis > 0
    ? `Debt-free in <strong>${humanMonths(a.months)}</strong> (${dateAfter(a.months)}), <strong>${fmt(a.totalInterest)}</strong> interest — that's ${humanMonths(monthsSaved)} sooner and <strong>${fmt(interestSaved)}</strong> saved vs. minimum only.`
    : `At the ${fmt2(d.minPayment)} minimum: debt-free in <strong>${humanMonths(a.months)}</strong> (${dateAfter(a.months)}), <strong>${fmt(a.totalInterest)}</strong> total interest. Drag the slider to throw extra at it.`;

  box.innerHTML = `<div class="insight" style="background:var(--card-2);border-color:var(--border)">${summary}</div>
    ${miniBalanceChart(a.rows, d.balance)}
    <details style="margin-top:8px"><summary>Month-by-month schedule</summary>
      <table class="scenario"><thead><tr><th>#</th><th>Payment</th><th>Interest</th><th>Principal</th><th>Balance</th></tr></thead>
      <tbody>${a.rows.slice(0, 360).map((r) => `<tr><td>${r.month}</td><td>${fmt2(r.payment)}</td><td>${fmt2(r.interest)}</td><td>${fmt2(r.principal)}</td><td>${fmt2(r.balance)}</td></tr>`).join('')}</tbody></table>
    </details>`;
}

// Single-debt amortization at minPayment + extra.
function amortize(debt, extraOnThis) {
  const d = { balance: debt.balance };
  const payment = (debt.minPayment || 0) + Math.max(0, extraOnThis);
  const rate = debt.apr / 100 / 12;
  const rows = [];
  let month = 0, totalInterest = 0;
  const MAX = 1200;
  while (d.balance > 0.005 && month < MAX) {
    month++;
    const interest = d.balance * rate;
    const pay = Math.min(payment, d.balance + interest);
    const principal = pay - interest;
    if (principal <= 0) return { rows, months: month, totalInterest, stalled: true, payment };
    d.balance = d.balance + interest - pay;
    totalInterest += interest;
    rows.push({ month, payment: pay, interest, principal, balance: Math.max(0, d.balance) });
  }
  return { rows, months: month, totalInterest, stalled: month >= MAX, payment };
}

// Compact balance-over-time SVG for a single debt.
function miniBalanceChart(rows, startBalance) {
  if (!rows.length) return '';
  const W = 500, H = 120, P = { l: 48, r: 10, t: 8, b: 18 };
  const maxM = rows.length, maxB = startBalance || 1;
  const x = (m) => P.l + (m / maxM) * (W - P.l - P.r);
  const y = (b) => P.t + (1 - b / maxB) * (H - P.t - P.b);
  const pts = [{ month: 0, balance: startBalance }, ...rows];
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.month).toFixed(1)} ${y(p.balance).toFixed(1)}`).join(' ');
  let grid = '';
  for (let i = 0; i <= 2; i++) {
    const val = (maxB / 2) * i, yy = y(val);
    grid += `<line x1="${P.l}" y1="${yy}" x2="${W - P.r}" y2="${yy}" class="grid"/><text x="${P.l - 6}" y="${yy + 4}" class="axis" text-anchor="end">${fmtShort(val)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" style="margin-top:8px">${grid}<path d="${path}" class="line-accent"/></svg>`;
}

// Payments toward a debt, inferred from transactions.
function paymentHistory(d) {
  const rel = relatedTransactions(d);
  // Credit accounts: payments are inflows (+). Loans: matched payment transfers.
  const list = rel.filter((t) => t.amount > 0 || /payment|autopay|transfer to loan/i.test(t.description))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const yr = new Date().getFullYear();
  const thisYear = list.filter((t) => t.date.startsWith(String(yr))).reduce((s, t) => s + Math.abs(t.amount), 0);
  const avg = list.length ? list.reduce((s, t) => s + Math.abs(t.amount), 0) / list.length : 0;
  return { list, thisYear, avg };
}

// Generic transaction drill-down (used by the budget charts).
function openTxList(title, txs) {
  const out = txs.reduce((s, t) => (t.amount < 0 ? s + Math.abs(t.amount) : s), 0);
  const inc = txs.reduce((s, t) => (t.amount > 0 ? s + t.amount : s), 0);
  detailDebtId = null;
  $('#detailEditBtn').style.display = 'none';
  $('#detailContent').innerHTML = `
    <div class="detail-head"><h3>${escapeHtml(title)}</h3>
      <div class="sub">${txs.length} transaction${txs.length === 1 ? '' : 's'}${out ? ` · ${fmt(out)} out` : ''}${inc ? ` · ${fmt(inc)} in` : ''}</div></div>
    <div class="detail-tx schedule" style="max-height:55vh">
      ${txs.slice(0, 400).map((t) => `<div class="item"><span>${t.date} · ${escapeHtml(t.description)} <span class="pill">${escapeHtml(catOf(t))}</span></span><span class="when" style="color:${t.amount < 0 ? 'var(--danger)' : 'var(--accent)'}">${t.amount < 0 ? '-' : '+'}${fmt2(Math.abs(t.amount))}</span></div>`).join('') || '<p class="muted small">No transactions.</p>'}
    </div>`;
  $('#detailDialog').showModal();
}

// Transactions tied to a debt: same Plaid account, or its mask in the description.
function relatedTransactions(d) {
  return transactions
    .filter((t) => (d.account_id && t.account_id === d.account_id) || (d.mask && t.description.includes(d.mask)))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function renderPlan() {
  const card = $('#resultsCard');
  if (!debts.length) { card.hidden = true; return; }
  card.hidden = false;

  const strategy = $('#strategy').value;
  const extra = parseFloat($('#extra').value) || 0;

  const plan = simulate(debts, strategy, extra);
  const totalDebt = debts.reduce((s, d) => s + d.balance, 0);

  // Compare against the alternative strategy and against minimums-only.
  const other = strategy === 'avalanche' ? 'snowball' : 'avalanche';
  const otherPlan = simulate(debts, other, extra);
  const minOnly = simulate(debts, strategy, 0);

  if (plan.stalled) {
    $('#stats').innerHTML = `<div class="banner warn">⚠️ With these numbers the debt never gets paid off —
      your minimum payments don't cover the interest. Increase your extra payment above, or the minimums.</div>`;
    $('#compare').innerHTML = '';
    $('#schedule').innerHTML = '';
    return;
  }

  $('#stats').innerHTML = `
    <div class="stat"><div class="key">Total debt</div><div class="value">${fmt(totalDebt)}</div></div>
    <div class="stat"><div class="key">Debt-free in</div><div class="value good">${humanMonths(plan.months)}</div></div>
    <div class="stat"><div class="key">Debt-free date</div><div class="value">${dateAfter(plan.months)}</div></div>
    <div class="stat"><div class="key">Total interest paid</div><div class="value">${fmt(plan.totalInterest)}</div></div>
    <div class="stat"><div class="key">Paying</div><div class="value">${fmt(plan.monthlyBudget)}<span class="key">/mo</span></div></div>
  `;

  // Insight callouts
  const interestSaved = minOnly.totalInterest - plan.totalInterest;
  const monthsSaved = minOnly.months - plan.months;
  const vsOtherInterest = otherPlan.totalInterest - plan.totalInterest;

  let compareHtml = '';
  if (extra > 0 && monthsSaved > 0) {
    compareHtml += `💪 Paying <strong>${fmt(extra)} extra/month</strong> gets you out
      <strong>${humanMonths(monthsSaved)} sooner</strong> and saves
      <strong>${fmt(interestSaved)}</strong> in interest vs. minimums only.<br>`;
  }
  if (Math.abs(vsOtherInterest) >= 1) {
    if (vsOtherInterest > 0) {
      compareHtml += `🏔️ <strong>${cap(strategy)}</strong> saves you <strong>${fmt(vsOtherInterest)}</strong>
        more interest than ${other}.`;
    } else {
      compareHtml += `❄️ <strong>${cap(other)}</strong> would save <strong>${fmt(-vsOtherInterest)}</strong>
        more interest, but ${strategy} clears small balances faster for motivation.`;
    }
  }
  const compareEl = $('#compare');
  compareEl.innerHTML = compareHtml || 'Add an extra payment above to see how much faster you could be debt-free.';
  compareEl.className = 'compare' + (compareHtml ? '' : ' neutral');

  // Payoff schedule
  $('#schedule').innerHTML = plan.payoffOrder
    .map((p, i) => `
      <div class="item">
        <span><strong>${i + 1}.</strong> ${escapeHtml(p.name)} paid off</span>
        <span class="when">${dateAfter(p.month)} (${humanMonths(p.month)})</span>
      </div>`)
    .join('');
}

// ===========================================================================
// "Get out of debt sooner" — turn the full picture into ranked, quantified moves
// ===========================================================================
function renderRecommendations() {
  const card = $('#recsCard');
  if (!debts.length) { card.hidden = true; return; }

  const strategy = $('#strategy').value;
  const extra = parseFloat($('#extra').value) || 0;
  const baseline = simulate(debts, strategy, extra);
  if (baseline.stalled) { card.hidden = true; return; }
  card.hidden = false;

  // Impact of paying `newExtra` total per month, measured against the baseline.
  const impactOf = (newExtra, strat = strategy) => {
    const p = simulate(debts, strat, Math.max(0, newExtra));
    return { plan: p, monthsSaved: baseline.months - p.months, interestSaved: baseline.totalInterest - p.totalInterest, newExtra };
  };

  const recs = [];

  // 1. Switch to avalanche if it saves interest (costs nothing).
  if (strategy !== 'avalanche') {
    const av = simulate(debts, 'avalanche', extra);
    const saved = baseline.totalInterest - av.totalInterest;
    if (saved >= 1) {
      recs.push({
        title: 'Switch to the Avalanche method',
        detail: 'Pay highest-interest debt first instead of smallest. Costs you nothing extra.',
        monthsSaved: baseline.months - av.months, interestSaved: saved,
        action: () => { $('#strategy').value = 'avalanche'; },
      });
    }
  }

  // 2. Redirect your monthly surplus from spending (needs transactions).
  const surplus = monthlySurplus();
  if (surplus > extra + 5) {
    const i = impactOf(surplus);
    if (i.monthsSaved > 0) recs.push({
      title: `Put your leftover ${fmt(surplus)}/mo toward debt`,
      detail: `Your imported transactions show about ${fmt(surplus)} left after expenses each month — more than the ${fmt(extra)} you're applying now.`,
      monthsSaved: i.monthsSaved, interestSaved: i.interestSaved, newExtra: surplus,
    });
  }

  // 3. Trim the biggest discretionary category (needs transactions).
  const cut = biggestDiscretionaryCut();
  if (cut) {
    const i = impactOf(extra + cut.amount);
    if (i.monthsSaved > 0) recs.push({
      title: `Cut "${cut.category}" spending in half (~${fmt(cut.amount)}/mo)`,
      detail: `You're spending about ${fmt(cut.monthly)}/mo on ${cut.category}. Redirecting half of it accelerates your payoff.`,
      monthsSaved: i.monthsSaved, interestSaved: i.interestSaved, newExtra: extra + cut.amount,
    });
  }

  // 4. Generic "add a bit more" if nothing data-driven beats a small bump.
  if (recs.length < 2) {
    const bump = extra < 50 ? 50 : 100;
    const i = impactOf(extra + bump);
    if (i.monthsSaved > 0) recs.push({
      title: `Find an extra ${fmt(bump)}/mo`,
      detail: 'Even a small steady increase compounds. Import a transactions CSV and I can pinpoint where to find it.',
      monthsSaved: i.monthsSaved, interestSaved: i.interestSaved, newExtra: extra + bump,
    });
  }

  // Highest-APR callout (informational, no apply button).
  const worst = [...debts].sort((a, b) => b.apr - a.apr)[0];
  const worstBurn = worst.balance * (worst.apr / 100 / 12);

  recs.sort((a, b) => b.monthsSaved - a.monthsSaved);

  $('#recsList').innerHTML = recs.map((r, idx) => `
    <div class="rec">
      <div class="rec-main">
        <div class="rec-title">${escapeHtml(r.title)}</div>
        <div class="rec-detail muted small">${r.detail}</div>
      </div>
      <div class="rec-impact">
        <div class="rec-num">${humanMonths(r.monthsSaved)} sooner</div>
        <div class="muted small">save ${fmt(r.interestSaved)}</div>
      </div>
      <button class="primary" data-rec="${idx}">Apply</button>
    </div>`).join('') +
    `<div class="rec info">
      <div class="rec-main">
        <div class="rec-title">🎯 Attack ${escapeHtml(worst.name)} first (${worst.apr.toFixed(1)}% APR)</div>
        <div class="rec-detail muted small">It's your most expensive debt — costing ${fmt2(worstBurn)} in interest every month. Every extra dollar should hit it first. A balance transfer or lower-rate loan here would save the most.</div>
      </div>
    </div>`;

  $('#recsList').querySelectorAll('[data-rec]').forEach((b) =>
    b.addEventListener('click', () => {
      const r = recs[+b.dataset.rec];
      if (r.action) r.action();
      if (r.newExtra !== undefined) $('#extra').value = Math.round(r.newExtra);
      render();
      $('#resultsCard').scrollIntoView({ behavior: 'smooth' });
    }));

  renderScenarioTable(strategy, extra, baseline);
}

// Average money left over each month, from imported transactions.
function monthlySurplus() {
  if (!transactions.length) return 0;
  const months = monthSpan();
  const income = transactions.filter((t) => isFlowCat(catOf(t)) && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const spend = transactions.filter((t) => isFlowCat(catOf(t)) && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  return Math.max(0, Math.floor(((income - spend) / months) / 5) * 5);
}

// The biggest "wants" category we could realistically cut in half.
function biggestDiscretionaryCut() {
  if (!transactions.length) return null;
  const months = monthSpan();
  const discretionary = new Set(['Dining', 'Shopping', 'Subscriptions', 'Transport', 'Gas']);
  const byCat = {};
  for (const t of transactions) {
    if (t.amount < 0 && discretionary.has(catOf(t))) byCat[catOf(t)] = (byCat[catOf(t)] || 0) + Math.abs(t.amount);
  }
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const monthly = top[1] / months;
  const amount = Math.floor((monthly / 2) / 5) * 5;
  return amount >= 10 ? { category: top[0], monthly, amount } : null;
}

function renderScenarioTable(strategy, extra, baseline) {
  const adds = [...new Set([0, 25, 50, 100, 200, 300].map((a) => extra + a))];
  const rows = adds.map((e) => {
    const p = simulate(debts, strategy, e);
    if (p.stalled) return '';
    const saved = baseline.totalInterest - p.totalInterest;
    const sooner = baseline.months - p.months;
    const isNow = e === extra;
    return `<tr class="${isNow ? 'now' : ''}">
      <td>${fmt(e)}/mo${isNow ? ' (now)' : ''}</td>
      <td>${dateAfter(p.months)}</td>
      <td>${humanMonths(p.months)}</td>
      <td>${sooner > 0 ? humanMonths(sooner) + ' sooner' : '—'}</td>
      <td>${saved > 0 ? fmt(saved) : '—'}</td>
    </tr>`;
  }).join('');
  $('#scenarioTable').innerHTML = `
    <table class="scenario">
      <thead><tr><th>Pay</th><th>Debt-free</th><th>Time</th><th>vs now</th><th>Interest saved</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ===========================================================================
// Analytics  (SVG charts, no external libraries)
// ===========================================================================
const COLORS = ['#3fb950', '#58a6ff', '#d29922', '#f85149', '#bc8cff', '#39c5cf', '#ff7b72', '#7ee787'];

function renderAnalytics() {
  const card = $('#analyticsCard');
  if (!debts.length) { card.hidden = true; return; }

  const strategy = $('#strategy').value;
  const extra = parseFloat($('#extra').value) || 0;
  const plan = simulate(debts, strategy, extra);
  const minOnly = simulate(debts, strategy, 0);

  if (plan.stalled) { card.hidden = true; return; }
  card.hidden = false;

  renderProgressChart();
  renderBalanceChart(plan, minOnly);
  renderPrincipalChart(plan);
  renderOwnerChart(plan);
  renderBurnChart();
}

// --- 0. Real progress over time (from saved snapshots) ----------------------
function renderProgressChart() {
  const total = debts.reduce((s, d) => s + d.balance, 0);
  const byOwner = {};
  for (const d of debts) byOwner[d.owner || 'Me'] = (byOwner[d.owner || 'Me'] || 0) + d.balance;
  const snaps = recordSnapshot(total, byOwner);
  const box = $('#progressChart');

  if (snaps.length < 2) {
    box.innerHTML = `<div class="progress-empty">
      📍 Baseline saved: <strong>${fmt(total)}</strong> on ${snaps[0]?.date ?? todayISO()}.<br>
      Come back after you make a payment and update your balances — this chart will
      show your real debt dropping over time.
    </div>`;
    return;
  }

  const W = 920, H = 240, P = { l: 60, r: 14, t: 14, b: 28 };
  const start = snaps[0], now = snaps[snaps.length - 1];
  const maxBal = Math.max(...snaps.map((s) => s.total));
  const t0 = new Date(start.date).getTime();
  const t1 = Math.max(new Date(now.date).getTime(), t0 + 86400000);
  const x = (date) => P.l + ((new Date(date).getTime() - t0) / (t1 - t0)) * (W - P.l - P.r);
  const y = (b) => P.t + (1 - b / maxBal) * (H - P.t - P.b);
  const linePath = snaps.map((s, i) => `${i ? 'L' : 'M'}${x(s.date).toFixed(1)} ${y(s.total).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(now.date).toFixed(1)} ${y(0).toFixed(1)} L${x(start.date).toFixed(1)} ${y(0).toFixed(1)} Z`;

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const val = (maxBal / 4) * i, yy = y(val);
    grid += `<line x1="${P.l}" y1="${yy}" x2="${W - P.r}" y2="${yy}" class="grid"/>
      <text x="${P.l - 8}" y="${yy + 4}" class="axis" text-anchor="end">${fmtShort(val)}</text>`;
  }
  const dots = snaps.map((s) =>
    `<circle cx="${x(s.date)}" cy="${y(s.total)}" r="3.5" fill="var(--accent)"><title>${s.date}: ${fmt(s.total)}</title></circle>`
  ).join('');

  const paidDown = start.total - now.total;
  const pctDown = start.total ? (paidDown / start.total) * 100 : 0;

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" style="height:240px">
      ${grid}
      <path d="${areaPath}" fill="var(--accent)" opacity="0.12"/>
      <path d="${linePath}" class="line-accent"/>
      ${dots}
      <text x="${x(start.date)}" y="${H - 8}" class="axis" text-anchor="start">${start.date}</text>
      <text x="${x(now.date)}" y="${H - 8}" class="axis" text-anchor="end">${now.date}</text>
    </svg>
    <div class="progress-stats">
      <div class="ps">Started at<b>${fmt(start.total)}</b></div>
      <div class="ps">Now<b>${fmt(now.total)}</b></div>
      <div class="ps">Paid down<b class="${paidDown > 0 ? 'good' : ''}">${fmt(paidDown)}</b></div>
      <div class="ps">Progress<b class="${pctDown > 0 ? 'good' : ''}">${pctDown.toFixed(1)}%</b></div>
    </div>
    <p class="muted small" style="margin-top:8px">
      ${snaps.length} updates recorded since ${start.date}.
      <button class="link" id="resetProgress">Reset history</button>
    </p>`;
  $('#resetProgress')?.addEventListener('click', resetSnapshots);
}

// --- 1. Balance over time: your plan vs minimums-only -----------------------
function renderBalanceChart(plan, minOnly) {
  const W = 460, H = 220, P = { l: 56, r: 12, t: 12, b: 28 };
  const maxBal = plan.startBalance;
  const maxMonth = Math.max(minOnly.months, plan.months, 1);
  const x = (m) => P.l + (m / maxMonth) * (W - P.l - P.r);
  const y = (b) => P.t + (1 - b / maxBal) * (H - P.t - P.b);
  const path = (traj) => traj.map((p, i) => `${i ? 'L' : 'M'}${x(p.month).toFixed(1)} ${y(p.balance).toFixed(1)}`).join(' ');

  // y gridlines / labels (0, 25, 50, 75, 100%)
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const val = (maxBal / 4) * i;
    const yy = y(val);
    grid += `<line x1="${P.l}" y1="${yy}" x2="${W - P.r}" y2="${yy}" class="grid"/>
      <text x="${P.l - 8}" y="${yy + 4}" class="axis" text-anchor="end">${fmtShort(val)}</text>`;
  }
  // x labels (year marks)
  let xlab = '';
  const yearStep = maxMonth > 60 ? 24 : 12;
  for (let m = 0; m <= maxMonth; m += yearStep) {
    xlab += `<text x="${x(m)}" y="${H - 8}" class="axis" text-anchor="middle">${m === 0 ? 'now' : (m / 12) + 'y'}</text>`;
  }

  $('#balanceChart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart">
      ${grid}${xlab}
      <path d="${path(minOnly.trajectory)}" class="line-faint"/>
      <path d="${path(plan.trajectory)}" class="line-accent"/>
      <circle cx="${x(plan.months)}" cy="${y(0)}" r="4" fill="var(--accent)"/>
    </svg>
    <div class="legend">
      <span><i style="background:var(--accent)"></i>Your plan — debt-free ${dateAfter(plan.months)}</span>
      <span><i style="background:var(--muted)"></i>Minimums only — ${dateAfter(minOnly.months)}</span>
    </div>`;
}

// --- 2. Principal vs interest (stacked bar) ---------------------------------
function renderPrincipalChart(plan) {
  const principal = plan.startBalance;
  const interest = plan.totalInterest;
  const total = principal + interest;
  const pctI = total ? (interest / total) * 100 : 0;

  $('#principalChart').innerHTML = `
    <div class="stacked-bar">
      <div class="seg principal" style="width:${100 - pctI}%" title="Principal"></div>
      <div class="seg interest" style="width:${pctI}%" title="Interest"></div>
    </div>
    <div class="legend">
      <span><i style="background:var(--accent-2)"></i>Principal ${fmt(principal)}</span>
      <span><i style="background:var(--danger)"></i>Interest ${fmt(interest)}</span>
    </div>
    <p class="muted small">You'll pay <strong>${fmt(total)}</strong> total — that's
      <strong>${pctI.toFixed(0)}%</strong> of it lost to interest.</p>`;
}

// --- 3. Debt by person (horizontal bars + payoff date) ----------------------
function renderOwnerChart(plan) {
  const byOwner = new Map();
  for (const d of debts) {
    const o = d.owner || 'Me';
    byOwner.set(o, (byOwner.get(o) || 0) + d.balance);
  }
  const total = [...byOwner.values()].reduce((s, v) => s + v, 0) || 1;
  // Last payoff month per owner from the schedule.
  const ownerDone = {};
  for (const p of plan.payoffOrder) ownerDone[p.owner] = Math.max(ownerDone[p.owner] || 0, p.month);

  const rows = [...byOwner.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([owner, bal], i) => {
      const pct = (bal / total) * 100;
      const done = ownerDone[owner];
      return `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(owner)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${COLORS[i % COLORS.length]}"></div></div>
          <span class="bar-val">${fmt(bal)}${done ? ` · clear ${dateAfter(done)}` : ''}</span>
        </div>`;
    }).join('');

  $('#ownerChart').innerHTML = rows;
}

// --- 4. Current monthly interest burn, per debt -----------------------------
function renderBurnChart() {
  const burns = debts
    .map((d) => ({ name: d.name, owner: d.owner || 'Me', monthly: d.balance * (d.apr / 100 / 12) }))
    .filter((b) => b.monthly > 0)
    .sort((a, b) => b.monthly - a.monthly);
  const totalBurn = burns.reduce((s, b) => s + b.monthly, 0);
  const max = burns[0]?.monthly || 1;

  const rows = burns.map((b, i) => `
    <div class="bar-row">
      <span class="bar-label" title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(b.monthly / max) * 100}%;background:var(--danger)"></div></div>
      <span class="bar-val">${fmt2(b.monthly)}/mo</span>
    </div>`).join('');

  $('#burnChart').innerHTML = `${rows}
    <p class="muted small">Together your debts cost <strong>${fmt2(totalBurn)}</strong> in interest
      <strong>every month</strong> (${fmt(totalBurn * 12)}/yr) just standing still.</p>`;
}

function fmtShort(n) {
  if (n >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return '$' + Math.round(n);
}

// ===========================================================================
// Helpers
// ===========================================================================
function humanMonths(m) {
  const y = Math.floor(m / 12);
  const mo = m % 12;
  if (y && mo) return `${y}y ${mo}mo`;
  if (y) return `${y} yr${y > 1 ? 's' : ''}`;
  return `${mo} mo`;
}
function dateAfter(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cryptoId() {
  return (crypto.randomUUID?.() || String(Math.random())).slice(0, 8);
}
