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
app.use(express.static(path.join(__dirname, 'public')));

// Lets the frontend know whether Plaid is wired up or if it should fall back
// to manual entry only.
app.get('/api/config', (req, res) => {
  res.json({ plaidConfigured, env: PLAID_ENV, oauthReady: Boolean(PLAID_REDIRECT_URI) });
});

// Step 1: create a short-lived link_token used to open Plaid Link in the browser.
app.post('/api/create_link_token', async (req, res) => {
  if (!plaid) return res.status(400).json({ error: 'Plaid not configured. See README.' });
  try {
    const request = {
      user: { client_user_id: 'debt-free-local-user' },
      client_name: 'Debt-Free',
      products: [Products.Liabilities],
      country_codes: [CountryCode.Us],
      language: 'en',
    };
    // Required for OAuth banks (e.g. Navy Federal). Must match a URI registered
    // in the Plaid dashboard. Without it, OAuth institutions can't redirect back.
    if (PLAID_REDIRECT_URI) request.redirect_uri = PLAID_REDIRECT_URI;
    const response = await plaid.linkTokenCreate(request);
    res.json(response.data);
  } catch (err) {
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
  const errors = [];

  for (const { access_token, institution, owner = 'Me' } of tokens) {
    try {
      const resp = await plaid.liabilitiesGet({ access_token });
      const accounts = resp.data.accounts;
      const liabilities = resp.data.liabilities;
      const nameOf = (id) => accounts.find((a) => a.account_id === id)?.name ?? 'Account';

      for (const card of liabilities.credit ?? []) {
        const acct = accounts.find((a) => a.account_id === card.account_id);
        debts.push({
          source: 'plaid',
          institution,
          owner,
          name: nameOf(card.account_id),
          type: 'credit card',
          balance: acct?.balances?.current ?? 0,
          apr: pickApr(card.aprs),
          minPayment: card.minimum_payment_amount ?? estimateMinPayment(acct?.balances?.current ?? 0),
        });
      }

      for (const loan of liabilities.student ?? []) {
        debts.push({
          source: 'plaid',
          institution,
          owner,
          name: nameOf(loan.account_id),
          type: 'student loan',
          balance: accounts.find((a) => a.account_id === loan.account_id)?.balances?.current ?? 0,
          apr: loan.interest_rate_percentage ?? 0,
          minPayment: loan.minimum_payment_amount ?? 0,
        });
      }

      for (const mort of liabilities.mortgage ?? []) {
        debts.push({
          source: 'plaid',
          institution,
          owner,
          name: nameOf(mort.account_id),
          type: 'mortgage',
          balance: accounts.find((a) => a.account_id === mort.account_id)?.balances?.current ?? 0,
          apr: mort.interest_rate?.percentage ?? 0,
          minPayment: mort.next_monthly_payment ?? 0,
        });
      }
    } catch (err) {
      errors.push({ institution, owner, message: err.response?.data?.error_message ?? err.message });
    }
  }

  res.json({ debts, errors });
});

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
