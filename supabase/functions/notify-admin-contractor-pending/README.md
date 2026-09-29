# notify-admin-contractor-pending

Emails every admin when a contractor uploads or updates their license +
insurance and is still awaiting verification. Uses the same SMTP server
already configured for Supabase auth email.

The frontend fires this function automatically after `saveProfile` when
the contractor row is not yet verified.

## One-time setup

### 1. Deploy the function

Install the Supabase CLI (if you don't have it) and log in, then from
the repo root:

```bash
npx supabase login
npx supabase link --project-ref mjlaniudtmdfzrcgmios
npx supabase functions deploy notify-admin-contractor-pending
```

If you'd rather not use the CLI: in the Supabase dashboard, go to
**Edge Functions → Deploy a new function**, name it exactly
`notify-admin-contractor-pending`, and paste the contents of
`index.ts`.

### 2. Set the SMTP secrets

The function reads SMTP creds from environment variables. Set them
either from the dashboard (**Project Settings → Edge Functions →
Secrets**) or with the CLI:

```bash
npx supabase secrets set \
  SMTP_HOST=smtp.office365.com \
  SMTP_PORT=587 \
  SMTP_USER=support@subcontractorpros.com \
  SMTP_PASS='your-smtp-password-or-app-password' \
  SMTP_FROM=support@subcontractorpros.com \
  APP_URL=https://your-deployed-site.example.com
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically by the platform — do not set them by hand.

`APP_URL` becomes the "Open Admin Dashboard" button in the email.

### 3. Test

Sign in as a contractor account, upload a license + COI, save the
profile. Every admin (rows in the `admins` table) will get an email
within a few seconds.

Check function logs at **Edge Functions → notify-admin-contractor-pending
→ Logs** if nothing arrives.

## Optional: also trigger from a Database Webhook

The frontend already invokes this on save, so a webhook is redundant
unless you also want emails when someone updates a contractor row via
SQL. If you want it: **Database → Webhooks → New Webhook**,
table `contractors`, events `INSERT` + `UPDATE`, HTTP POST to the
function URL, add an `Authorization: Bearer <SERVICE_ROLE_KEY>` header.
