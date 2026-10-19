# Starlink Chad — Reseller Platform

A plain-Node (Express) reseller site for Starlink data plans in Chad, with an
operator-verified PIN/OTP payment flow delivered over Telegram.

## Stack

- Node.js + Express (no database: orders live in memory)
- Server-rendered HTML views with a tiny `{{value}}` template layer
- Telegram long-polling bot for operator approvals
- Playwright end-to-end test (`nodeapp/test-flow.cjs`)

## Run

```powershell
cd nodeapp
npm install
npm start        # http://127.0.0.1:8000
```

Environment variables (in `.env`):

| Variable | Purpose |
|----------|--------|
| `PORT` | Port to listen on (default 8000) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token; without it notifications are disabled |
| `TELEGRAM_CHAT_ID` | Operator chat id |

## Flow

1. Customer picks a plan + payment method (Airtel / Moov Money) and a phone number.
2. Customer enters a 4-digit PIN -> forwarded to Telegram for operator review.
3. Operator taps **Allow Proceed** (-> OTP step), **Invalid Information**
   (-> retry PIN, attempt 2/2), or **Wrong PIN** (-> back to PIN entry).
4. Customer enters the OTP -> forwarded to Telegram again.
5. Operator taps **Correct OTP + PIN** (-> paid/success), **Wrong Code**
   (-> retry OTP), or **Wrong PIN** (-> back to the PIN entry page).
6. After 2 attempts with no valid verdict the order fails and the customer
   restarts from the plans page.

## Tests

```powershell
cd nodeapp
node test-flow.cjs
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | **Statut Réseau** — live speed dashboard (download/upload/ping/jitter) + data usage |
| `/plans/` | **Forfaits** — data packages, payment modal (Airtel / Moov Money) |
| `/settings/` | **Paramètres** — settings tab |
| `/orders/<ref>/<token>/pin` | PIN entry page |
| `/orders/<ref>/<token>/otp` | OTP entry page |
| `/orders/<ref>/<token>/success` | Payment success page |

## Seeded plans

| Plan | Data | Price (XAF) |
|------|------|-------------|
| Forfait Starter | 5 Go | 750,00 |
| Forfait Basique | 15 Go | 1 500,00 |
| Forfait Standard | 30 Go | 3 000,00 |
| Forfait Premium | 60 Go | 5 500,00 |
| Forfait Business | 150 Go | 12 000,00 |

## Deployment on Render

1. Push the repo to GitHub (the app lives in `nodeapp/`).
2. On [render.com](https://render.com) create a **Web Service**, connect the repo.
3. Settings:
   - **Root Directory**: `nodeapp`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance**: Free tier is fine for testing (the app is stateless apart from in-memory orders).
4. Environment variables (Render → Environment):

   | Variable | Value |
   |----------|-------|
   | `NODE_ENV` | `production` |
   | `PORT` | leave unset — Render injects it and `server.js` uses it |
   | `TELEGRAM_BOT_TOKEN` | your bot token from @BotFather |
   | `TELEGRAM_CHAT_ID` | your operator chat id |

   Note: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are optional. Without
   them the server still runs; it just logs a warning instead of polling
   Telegram, and the operator callbacks can be driven through
   `/api/_test/operator/<ref>/<action>` for local QA (see `test-flow.cjs`).
5. Deploy. Render detects Node from `package.json` automatically — no
   Dockerfile or buildpack config is needed.

### Getting a Telegram token + chat id

- Create a bot with [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
- Message your bot once, then open
  `https://api.telegram.org/bot<token>/getUpdates` and copy `message.chat.id`.
- Put both values in the Render environment variables. On boot the server
  starts long-polling and the operator receives the PIN/OTP notifications with
  the Approve / Wrong-code / Wrong-PIN inline buttons.

### Health check & free-tier notes

- Render's health check can point at `/` (it returns 200).
- Free instances sleep after 15 min idle; the first request after sleep takes
  a few seconds. In-memory orders are lost on restart — for production use,
  consider a persistent store (e.g. Redis/Upstash) if you need orders to
  survive redeploys.
- Long polling works on Render as-is; no webhook URL is required.
