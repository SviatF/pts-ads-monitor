# PTS Ads Monitor

Internal Meta Ads health monitor for PTS Cooperation.

## What it does

- Reads owned and client ad accounts shared to one Meta Business Manager.
- Checks account status every 10 minutes.
- Sends Telegram alerts only when an account status changes.
- Treats Meta account status `UNSETTLED`, `PENDING_SETTLEMENT`, and `IN_GRACE_PERIOD` as payment/billing states.
- Detects newly seen `DISAPPROVED` ads and sends only the ad names grouped by account.
- Sends a recovery alert when an account returns to `ACTIVE`.
- Stores state in Supabase so alerts are not duplicated.

## 1. Supabase

Create a Supabase project and run `supabase/schema.sql` in SQL Editor.

## 2. Environment variables

Copy `.env.example` values into Vercel project environment variables:

- `META_BUSINESS_ID` — central Business Manager ID.
- `META_ACCESS_TOKEN` — server-side Meta token with read access to the BM ad accounts.
- `META_GRAPH_VERSION` — Graph API version, configurable without code changes.
- `TELEGRAM_BOT_TOKEN` — BotFather token.
- `TELEGRAM_CHAT_ID` — target channel/chat ID. The bot must be allowed to post there.
- `SUPABASE_URL` — Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — server-only service role key. Never expose it to the browser.
- `CRON_SECRET` — random secret used to protect `/api/monitor`.
- `ALERT_EXISTING_REJECTS=false` — recommended. On the first scan existing rejected ads are only remembered, not alerted.

## 3. Meta flow

Share all client ad accounts to one central BM. The monitor reads both:

- `/{business-id}/owned_ad_accounts`
- `/{business-id}/client_ad_accounts`

For each account it reads status and queries ads with `effective_status=DISAPPROVED`.

## 4. First run

After deploying and setting environment variables, call `/api/monitor` once with:

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR_DOMAIN/api/monitor
```

The first run syncs all accessible accounts and seeds already rejected ads. By default it does not spam Telegram with historical rejects.

## 5. Telegram behavior

You receive alerts for:

- account problem / disabled state;
- billing/payment state;
- account restored;
- newly detected rejected ads, grouped per account.

Healthy accounts stay silent.

## Notes

Meta permissions and available status fields depend on the access token and Business Manager setup. The monitor intentionally does not assume every disabled account is a payment failure; only billing-related Meta account status codes are labeled as payment states.
