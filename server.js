import express from 'express';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');

const {
  PLAID_CLIENT_ID,
  PLAID_SECRET,
  PLAID_ENV = 'sandbox',
  PLAID_REDIRECT_URI,
  PORT = 4000,
} = process.env;

const plaidConfigured = Boolean(PLAID_CLIENT_ID && PLAID_SECRET);

// ---------------------------------------------------------------------------
// Plaid client
// ---------------------------------------------------------------------------
let plaid = null;
if (plaidConfigured) {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET': PLAID_SECRET,
      },
    },
  });
  plaid = new PlaidApi(configuration);
}

// ---------------------------------------------------------------------------
// Tiny JSON "database" for Plaid access tokens (one row per linked institution)
// ---------------------------------------------------------------------------
function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveTokens(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
// Never cache the app shell/assets — this is a fast-moving local tool, and the
// Cloudflare tunnel + browser would otherwise serve stale code after edits.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store, max-age=0'),
}));

// Lets the frontend know whether Plaid is wired up or if it should fall back
// to manual entry only.
app.get('/api/config', (req, res) => {
  res.json({ plaidConfigured, env: PLAID_ENV, oauthReady: Boolean(PLAID_REDIRECT_URI) });
});

// Step 1: create a short-lived link_token used to open Plaid Link in the browser.
app.post('/api/create_link_token', async (req, res) => {
  if (!plaid) return res.status(400).json({ error: 'Plaid not configured. See README.' });
  const base = {
    user: { client_user_id: 'debt-free-local-user' },
    client_name: 'Debt-Free',
    country_codes: [CountryCode.Us],
    language: 'en',
  };
  // Required for OAuth banks (e.g. Navy Federal). Must match a URI registered
  // in the Plaid dashboard. Without it, OAuth institutions can't redirect back.
  if (PLAID_REDIRECT_URI) base.redirect_uri = PLAID_REDIRECT_URI;

  try {
    // Prefer pulling transactions too, but gracefully fall back to liabilities-only
    // if the account isn't enabled for the Transactions product yet.
    const response = await plaid.linkTokenCreate({ ...base, products: [Products.Liabilities, Products.Transactions] });
    res.json({ ...response.data, transactions: true });
  } catch (err) {
    if (err.response?.data?.error_code === 'INVALID_PRODUCT') {
      try {
        const response = await plaid.linkTokenCreate({ ...base, products: [Products.Liabilities] });
        return res.json({ ...response.data, transactions: false });
      } catch (err2) {
        return sendPlaidError(res, err2);
      }
    }
    sendPlaidError(res, err);
  }
});

// Step 2: exchange the public_token (from Link) for a permanent access_token, and store it.
app.post('/api/exchange_public_token', async (req, res) => {
  if (!plaid) return res.status(400).json({ error: 'Plaid not configured. See README.' });
  try {
    const { public_token, owner } = req.body;
    const response = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    // Grab the institution name for a nicer UI label.
    let institution = 'Linked account';
    try {
      const item = await plaid.itemGet({ access_token });
      const instId = item.data.item.institution_id;
      if (instId) {
        const inst = await plaid.institutionsGetById({
          institution_id: instId,
          country_codes: [CountryCode.Us],
        });
        institution = inst.data.institution.name;
      }
    } catch { /* non-fatal */ }

    // Preserve the existing owner label if this item is being re-linked.
    const existing = loadTokens();
    const prior = existing.find((t) => t.item_id === item_id);
    const ownerLabel = (owner || prior?.owner || 'Me').trim();
    const tokens = existing.filter((t) => t.item_id !== item_id);
    tokens.push({ item_id, access_token, institution, owner: ownerLabel });
    saveTokens(tokens);

    res.json({ ok: true, institution, owner: ownerLabel });
  } catch (err) {
    sendPlaidError(res, err);
  }
});

// Step 3: pull every debt across all linked institutions and normalize them.
app.get('/api/liabilities', async (req, res) => {
  if (!plaid) return res.status(400).json({ error: 'Plaid not configured. See README.' });
  const tokens = loadTokens();
  const debts = [];
  const depositAccounts = [];
  const errors = [];

  for (const { access_token, institution, owner = 'Me' } of tokens) {
    try {
      const resp = await plaid.liabilitiesGet({ access_token });
      const accounts = resp.data.accounts;
      const liabilities = resp.data.liabilities;
      const nameOf = (id) => accounts.find((a) => a.account_id === id)?.name ?? 'Account';

      // Checking/savings come on the same response — surface them as assets.
      for (const acct of accounts) {
        if (acct.type === 'depository') {
          depositAccounts.push({
            source: 'plaid',
            institution,
            owner,
            account_id: acct.account_id,
            name: acct.name,
            type: acct.subtype || 'checking',
            balance: acct.balances?.available ?? acct.balances?.current ?? 0,
          });
        }
      }

      for (const card of liabilities.credit ?? []) {
        const acct = accounts.find((a) => a.account_id === card.account_id);
        debts.push({
          source: 'plaid',
          institution,
          owner,
          account_id: card.account_id,
          name: nameOf(card.account_id),
          type: 'credit card',
          balance: acct?.balances?.current ?? 0,
          apr: pickApr(card.aprs),
          minPayment: card.minimum_payment_amount ?? estimateMinPayment(acct?.balances?.current ?? 0),
          creditLimit: acct?.balances?.limit ?? null,
          dueDate: card.next_payment_due_date ?? null,
          // Rich Plaid Liabilities fields we now surface instead of discarding:
          isOverdue: card.is_overdue ?? false,
          lastPayment: card.last_payment_amount ?? null,
          lastPaymentDate: card.last_payment_date ?? null,
          lastStatementBalance: card.last_statement_balance ?? null,
          statementDate: card.last_statement_issue_date ?? null,
          aprs: (card.aprs ?? []).map((a) => ({ type: a.apr_type, rate: a.apr_percentage, balance: a.balance_subject_to_apr })),
        });
      }

      for (const loan of liabilities.student ?? []) {
        debts.push({
          source: 'plaid',
          institution,
          owner,
          account_id: loan.account_id,
          name: nameOf(loan.account_id),
          type: 'student loan',
          balance: accounts.find((a) => a.account_id === loan.account_id)?.balances?.current ?? 0,
          apr: loan.interest_rate_percentage ?? 0,
          minPayment: loan.minimum_payment_amount ?? 0,
          dueDate: loan.next_payment_due_date ?? null,
          isOverdue: loan.is_overdue ?? false,
          lastPayment: loan.last_payment_amount ?? null,
          lastPaymentDate: loan.last_payment_date ?? null,
          expectedPayoffDate: loan.expected_payoff_date ?? null,
          ytdInterestPaid: loan.ytd_interest_paid ?? null,
        });
      }

      for (const mort of liabilities.mortgage ?? []) {
        debts.push({
          source: 'plaid',
          institution,
          owner,
          account_id: mort.account_id,
          name: nameOf(mort.account_id),
          type: 'mortgage',
          balance: accounts.find((a) => a.account_id === mort.account_id)?.balances?.current ?? 0,
          apr: mort.interest_rate?.percentage ?? 0,
          minPayment: mort.next_monthly_payment ?? 0,
          dueDate: mort.next_payment_due_date ?? null,
          isOverdue: mort.is_overdue ?? false,
          lastPayment: mort.last_payment_amount ?? null,
          lastPaymentDate: mort.last_payment_date ?? null,
          ytdInterestPaid: mort.ytd_interest_paid ?? null,
        });
      }

      // Auto/personal loans: Plaid's Liabilities product doesn't return their
      // terms, but the loan account itself shows up. Surface it as a debt with
      // the balance; APR/payment are left for the user to fill in.
      const coveredIds = new Set([
        ...(liabilities.credit ?? []).map((c) => c.account_id),
        ...(liabilities.student ?? []).map((l) => l.account_id),
        ...(liabilities.mortgage ?? []).map((m) => m.account_id),
      ]);
      for (const acct of accounts) {
        if (acct.type === 'loan' && !coveredIds.has(acct.account_id)) {
          debts.push({
            source: 'plaid',
            institution,
            owner,
            account_id: acct.account_id,
            mask: acct.mask || null,
            name: acct.name,
            type: (acct.subtype || 'loan').replace(/_/g, ' '),
            balance: acct.balances?.current ?? 0,
            apr: 0,
            minPayment: 0,
            creditLimit: null,
            dueDate: null,
            needsTerms: true, // UI hint: APR/payment unknown, ask user to set
          });
        }
      }
    } catch (err) {
      errors.push({ institution, owner, message: err.response?.data?.error_message ?? err.message });
    }
  }

  res.json({ debts, accounts: depositAccounts, errors, syncedAt: new Date().toISOString() });
});

// Pull transactions across all linked institutions (requires Transactions product).
app.get('/api/transactions', async (req, res) => {
  if (!plaid) return res.status(400).json({ error: 'Plaid not configured. See README.' });
  const tokens = loadTokens();
  const txns = [];
  const errors = [];

  for (const { access_token, owner = 'Me' } of tokens) {
    try {
      let cursor;
      let hasMore = true;
      let guard = 0;
      while (hasMore && guard++ < 50) {
        const resp = await plaid.transactionsSync({ access_token, cursor });
        for (const t of resp.data.added) {
          txns.push({
            date: t.date,
            description: t.merchant_name || t.name,
            amount: -t.amount, // Plaid: positive = money OUT; this app: positive = money IN
            category: mapPlaidCategory(t.personal_finance_category?.primary),
            account_id: t.account_id,
            owner,
          });
        }
        cursor = resp.data.next_cursor;
        hasMore = resp.data.has_more;
      }
    } catch (err) {
      const data = err.response?.data;
      errors.push({ owner, error_code: data?.error_code, message: data?.error_message ?? err.message });
    }
  }
  res.json({ transactions: txns, errors });
});

// Detected recurring streams (subscriptions/bills) and income, straight from
// Plaid's recurring-transactions model — more reliable than guessing from raw
// transactions. Powers the Recurring panel AND verified take-home income.
app.get('/api/recurring', async (req, res) => {
  if (!plaid) return res.status(400).json({ error: 'Plaid not configured. See README.' });
  const tokens = loadTokens();
  const outflows = [];
  const inflows = [];
  const errors = [];

  for (const { access_token, owner = 'Me' } of tokens) {
    try {
      // Recurring detection keys off already-synced transactions; make sure
      // sync has run at least once so the streams exist.
      try { await plaid.transactionsSync({ access_token }); } catch { /* non-fatal */ }

      const acctResp = await plaid.accountsGet({ access_token });
      const account_ids = acctResp.data.accounts.map((a) => a.account_id);
      const nameOf = (id) => acctResp.data.accounts.find((a) => a.account_id === id)?.name ?? 'Account';

      const resp = await plaid.transactionsRecurringGet({ access_token, account_ids });
      const normalize = (s, direction) => ({
        owner,
        direction,
        description: s.merchant_name || s.description,
        account: nameOf(s.account_id),
        amount: s.average_amount?.amount ?? s.last_amount?.amount ?? 0,
        lastAmount: s.last_amount?.amount ?? null,
        frequency: s.frequency,
        monthlyAmount: monthlyFromFrequency(s.average_amount?.amount ?? s.last_amount?.amount ?? 0, s.frequency),
        category: s.personal_finance_category?.primary ?? null,
        lastDate: s.last_date ?? null,
        nextDate: s.predicted_next_date ?? null,
        isActive: s.is_active !== false,
        status: s.status ?? null,
      });

      for (const s of resp.data.outflow_streams ?? []) outflows.push(normalize(s, 'out'));
      for (const s of resp.data.inflow_streams ?? []) inflows.push(normalize(s, 'in'));
    } catch (err) {
      const data = err.response?.data;
      errors.push({ owner, error_code: data?.error_code, message: data?.error_message ?? err.message });
    }
  }
  res.json({ outflows, inflows, errors });
});

// Normalize a per-charge amount to a monthly figure given Plaid's frequency enum.
function monthlyFromFrequency(amount, frequency) {
  const perMonth = {
    WEEKLY: 52 / 12,
    BIWEEKLY: 26 / 12,
    SEMI_MONTHLY: 2,
    MONTHLY: 1,
    ANNUALLY: 1 / 12,
  };
  return Math.abs(amount) * (perMonth[frequency] ?? 1);
}

// Map Plaid's personal_finance_category to this app's simple categories.
function mapPlaidCategory(primary) {
  const map = {
    INCOME: 'Income',
    TRANSFER_IN: 'Transfer',
    TRANSFER_OUT: 'Transfer',
    LOAN_PAYMENTS: 'Debt payment',
    BANK_FEES: 'Other',
    ENTERTAINMENT: 'Subscriptions',
    FOOD_AND_DRINK: 'Dining',
    GENERAL_MERCHANDISE: 'Shopping',
    GENERAL_SERVICES: 'Other',
    GOVERNMENT_AND_NON_PROFIT: 'Other',
    MEDICAL: 'Health',
    PERSONAL_CARE: 'Health',
    RENT_AND_UTILITIES: 'Utilities',
    TRANSPORTATION: 'Transport',
    TRAVEL: 'Transport',
    HOME_IMPROVEMENT: 'Shopping',
  };
  return map[primary] ?? null; // null → client falls back to keyword categorization
}

// List connected logins (no secrets) so the UI can show/manage them.
app.get('/api/links', (req, res) => {
  res.json(loadTokens().map(({ item_id, institution, owner }) => ({ item_id, institution, owner })));
});

// Rename the owner label on a single connected login.
app.post('/api/links/owner', (req, res) => {
  const { item_id, owner } = req.body;
  const tokens = loadTokens();
  const t = tokens.find((x) => x.item_id === item_id);
  if (!t) return res.status(404).json({ error: 'Login not found' });
  t.owner = (owner || 'Me').trim();
  saveTokens(tokens);
  res.json({ ok: true });
});

// Remove a single connected login.
app.post('/api/unlink', (req, res) => {
  const { item_id } = req.body;
  saveTokens(loadTokens().filter((t) => t.item_id !== item_id));
  res.json({ ok: true });
});

// Remove all linked institutions (forget stored access tokens).
app.post('/api/unlink_all', (req, res) => {
  saveTokens([]);
  res.json({ ok: true });
});

// Pick the most relevant APR from Plaid's list (prefer the balance-carrying / purchase APR).
function pickApr(aprs = []) {
  if (!aprs.length) return 0;
  const order = ['balance_transfer_apr', 'purchase_apr', 'cash_apr', 'special'];
  for (const type of order) {
    const match = aprs.find((a) => a.apr_type === type);
    if (match) return match.apr_percentage;
  }
  return aprs[0].apr_percentage ?? 0;
}

// Banks usually require ~2% of balance or $25, whichever is greater, when min isn't reported.
function estimateMinPayment(balance) {
  return Math.max(25, Math.round(balance * 0.02));
}

function sendPlaidError(res, err) {
  const data = err.response?.data;
  console.error('Plaid error:', data ?? err.message);
  res.status(500).json({
    error: data?.error_message ?? err.message,
    error_code: data?.error_code,
  });
}

app.listen(PORT, () => {
  console.log(`\n  Debt-Free running at  http://localhost:${PORT}`);
  console.log(`  Plaid: ${plaidConfigured ? `configured (${PLAID_ENV})` : 'NOT configured — manual entry only'}\n`);
});
