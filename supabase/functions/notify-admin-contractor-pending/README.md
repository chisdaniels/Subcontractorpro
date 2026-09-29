# notify-admin-contractor-pending

Emails every admin when a contractor uploads or updates their license +
insurance and is still awaiting verification. Uses [Resend](https://resend.com).

The frontend fires this function automatically after `saveProfile` when
the contractor row is not yet verified.

## One-time setup

### 1. Sign up for Resend and get an API key

- Create an account at [resend.com](https://resend.com) (free tier is 3,000
  emails/month).
- **Domains** → **Add Domain** → add `subcontractorpros.com` and follow
  the DNS steps. Skip this while testing and use `onboarding@resend.dev`
  as the sender.
- **API Keys** → **Create API Key** → copy it.

### 2. Deploy the function

Paste `index.ts` into the Supabase dashboard's Edge Function editor, or:

```bash
npx supabase functions deploy notify-admin-contractor-pending
```

### 3. Set the secrets

Dashboard: **Edge Functions → Secrets → New**, add:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | the key from step 1 |
| `MAIL_FROM` | `TradeLinkPro <notifications@subcontractorpros.com>` — or `onboarding@resend.dev` for testing |
| `APP_URL` | your deployed site URL (the "Open Admin Dashboard" button links here) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do NOT set them.

### 4. Test

Sign in as a contractor account, upload a license + COI, save. Every
admin (rows in the `admins` table) will get an email within a few
seconds. Check function logs under **Edge Functions →
notify-admin-contractor-pending → Logs** if nothing arrives.
