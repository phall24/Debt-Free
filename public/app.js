// ===========================================================================
// State
// ===========================================================================
// Each debt: { id, name, type, balance, apr, minPayment, source: 'plaid'|'manual' }
let debts = loadManualDebts();
let plaidConfigured = false;
let plaidEnv = 'sandbox';
let oauthReady = false;

const $ = (sel) => document.querySelector(sel);
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
    const { debts: pulled, errors } = await fetch('/api/liabilities').then((r) => r.json());
    // Replace all plaid-sourced debts, keep manual ones.
    debts = debts.filter((d) => d.source === 'manual');
    for (const d of pulled) debts.push({ ...d, id: cryptoId() });
    if (errors?.length) {
      console.warn('Plaid pull errors:', errors);
    }
  } catch (err) {
    console.error(err);
  }
}

async function unlinkAll() {
  if (!confirm('Disconnect all linked banks? Your manually-added debts will stay.')) return;
  await fetch('/api/unlink_all', { method: 'POST' });
  debts = debts.filter((d) => d.source === 'manual');
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
function openDialog(debt = null) {
  editingId = debt?.id ?? null;
  $('#dialogTitle').textContent = debt ? 'Edit debt' : 'Add a debt';
  refreshOwnerOptions();
  const f = $('#debtForm');
  f.owner.value = debt?.owner ?? localStorage.getItem('lastOwner') ?? 'Me';
  f.name.value = debt?.name ?? '';
  f.balance.value = debt?.balance ?? '';
  f.apr.value = debt?.apr ?? '';
  f.minPayment.value = debt?.minPayment ?? '';
  $('#debtDialog').showModal();
}

// Populate the "whose debt" autocomplete from owners already in use.
function refreshOwnerOptions() {
  const owners = [...new Set(debts.map((d) => d.owner).filter(Boolean))];
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
    type: 'manual',
    source: 'manual',
  };
  if (editingId) {
    const d = debts.find((x) => x.id === editingId);
    Object.assign(d, data);
  } else {
    debts.push({ ...data, id: cryptoId() });
  }
  saveManualDebts();
  render();
}

function deleteDebt(id) {
  const d = debts.find((x) => x.id === id);
  if (d.source === 'plaid') {
    alert('This debt came from a linked bank. Use “Disconnect all banks” to remove linked debts.');
    return;
  }
  debts = debts.filter((x) => x.id !== id);
  saveManualDebts();
  render();
}

// ===========================================================================
// Payoff engine  (the heart of the tool)
// ===========================================================================
// Simulates paying every debt month by month. Each month you pay every
// minimum, then throw all remaining money at ONE target debt chosen by the
// strategy. When a debt is cleared, its freed-up payment rolls onto the next
// (the snowball effect) — total monthly outlay stays constant.
function simulate(inputDebts, strategy, extra) {
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

  const order = (active) =>
    [...active].sort((a, b) =>
      strategy === 'avalanche' ? b.apr - a.apr : a.balance - b.balance
    );

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
  renderPlan();
  renderAnalytics();
}

function renderDebts() {
  const list = $('#debtList');
  list.innerHTML = '';
  $('#emptyState').hidden = debts.length > 0;
  if (!debts.length) return;

  // Group debts by owner.
  const groups = new Map();
  for (const d of debts) {
    const owner = d.owner || 'Me';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(d);
  }

  const debtRow = (d) => `
    <div class="debt">
      <div>
        <div class="name">${escapeHtml(d.name)}</div>
        <div class="meta">
          <span class="pill">${d.source === 'plaid' ? '🔗 ' + escapeHtml(d.institution || 'linked') : '✍️ manual'}</span>
          ${d.type ? escapeHtml(d.type) : ''}
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
  list.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openDialog(debts.find((d) => d.id === b.dataset.edit)))
  );
  list.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteDebt(b.dataset.del))
  );
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
