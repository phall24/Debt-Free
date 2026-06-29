# 💸 Debt-Free

A private, local web app that connects to your bank/credit-card accounts through
**Plaid**, pulls in every debt automatically (balances, APRs, minimum payments),
and builds a payoff plan — comparing the **Avalanche** and **Snowball** methods so
you can see the fastest, cheapest way out.

Everything runs on your own machine. Plaid handles the secure bank login, so this
app **never sees or stores your bank password**.

---

## Quick start

```bash
npm install        # one time
cp .env.example .env   # then add your Plaid keys (see below)
npm start
```

Then open **http://localhost:4000**.

> Don't have Plaid keys yet? You can still run the app and add debts **manually** —
> auto-pull just stays off until you add keys.

---

## Getting your free Plaid keys

1. Sign up at **https://dashboard.plaid.com/signup** (free).
2. Go to **Developers → Keys**.
3. Copy your **client_id** and the **Sandbox** secret into `.env`:
   ```
   PLAID_CLIENT_ID=...
   PLAID_SECRET=...
   PLAID_ENV=sandbox
   ```
4. Restart the app (`npm start`).

### Sandbox vs. your real accounts
- **Sandbox** (default) connects to *fake* test banks — perfect for trying it out.
  When Plaid Link asks you to log in, use username **`user_good`** and password
  **`pass_good`**.
- To connect **your real accounts**, you need Plaid **Production** access (request
  it from the Plaid dashboard), then set `PLAID_ENV=production` and use your
  production secret. Plaid's free tier covers a small number of linked accounts.

---

## Three ways to add debts

1. **Connect a login (Plaid)** — auto-pulls balances/APRs/min payments. Primary, but
   needs Plaid production + OAuth access for OAuth banks.
2. **Upload a statement** — drop in a **PDF or CSV** statement; the app reads the
   balance, APR, and minimum payment **in your browser** (nothing is uploaded
   anywhere) and pre-fills a debt for you to confirm. Free, private, no Plaid needed.
3. **Add manually** — type the four numbers in. Always available.

## For couples / multiple logins

Built for a household, not just one person:

- Click **Connect a login** as many times as you need — your accounts, your
  spouse's, and joint accounts. You can even link **two different logins at the
  same bank** (they're stored as separate connections).
- Each connection is tagged with an **owner** (e.g. *Me*, *Wife*, *Joint*). Debts
  are grouped by owner with per-person subtotals **and** a combined household
  total.
- The payoff plan is **household-wide** — it tackles all the debts together with
  one shared monthly budget, which is the fastest way out as a couple.

## How it works

| Piece | What it does |
|-------|--------------|
| `server.js` | Express backend. Talks to Plaid, stores access tokens in `data/tokens.json`, and serves the app. |
| `public/` | The browser app: connect button, debt list, and the payoff engine. |
| Plaid **Liabilities** product | Returns credit-card balances + APRs + minimum payments, plus student loans and mortgages. |

The payoff math (in `public/app.js → simulate()`) walks month by month: it pays
every minimum, then throws all leftover money at one target debt (highest APR for
Avalanche, smallest balance for Snowball). When a debt is cleared, its payment
rolls onto the next one — the snowball effect.

---

## Privacy & security notes

- Your Plaid **access tokens** live only in `data/tokens.json` on your computer
  (git-ignored). Manually-entered debts live in your browser's localStorage.
- This is a personal, single-user local tool. If you ever deploy it somewhere
  public, add real auth and encrypt the token store first.
- Use **"Disconnect all banks"** in the footer to wipe stored Plaid tokens.
