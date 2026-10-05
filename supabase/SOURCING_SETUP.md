# Sourcing and outreach: setup checklist

Everything is built and deployed. Each part is switched off until its key exists, so you can
connect them one at a time. Add keys in the Supabase dashboard: **Edge Functions → Secrets**.
Never put a key in the repo or in `index.html`.

## What already runs today (no new keys needed)

- **When a job goes live (Open)**, it is queued automatically. Within about 10 minutes, Harbor
  generates the job's parallel titles, checks your own candidates against them in both
  directions, and records how many strong fits (Perfect or Good, 60%+) it found.
  You can see this on the job page under **Sourcing**.
- The scheduler (`pg_cron`) calls the `sourcing` function every 10 minutes, and once a day at
  06:00 UTC for client leads. Its ops token is stored in the database vault.
- Candidates can opt in on their candidate page to be presented anonymously to employers.
  Only those who opt in are ever pitched.

## 1. Apollo: candidates outside Harbor, and hiring managers' emails

1. Get an Apollo plan that includes API access. Create a key: Settings → Integrations → API.
2. Add the secret `APOLLO_API_KEY`.

After this, when the bench has fewer strong fits than your setting (default 3), Harbor searches
Apollo in the job's search area (shown on the job page under Sourcing): for on-site and hybrid
jobs, the office city plus places within about an hour's commute; for a job located by state
only, that whole state; for remote jobs, the states in the time zones the job description
prefers, or the whole country if it states none. It then reveals verified work emails for the best matches (1 credit each,
capped by "Most outside candidates per job"), checks each person's fit, and drafts an email.
People already in Harbor, or who unsubscribed, are skipped.

## 2. TheirStack: the daily job feed (client leads)

1. Create an account at theirstack.com and an API key.
2. Add the secret `THEIRSTACK_API_KEY`.
3. In Harbor: **Outreach → Setup**, tick "Fetch new job postings every morning". Set postings per
   day (1 credit per posting).

Each morning Harbor pulls new postings (direct employers only, no agencies) in your target
regions for titles your opted-in candidates hold. It keeps postings where a candidate is a
strong fit and drafts an anonymous pitch to the hiring contact: an email when Apollo finds a
verified address, otherwise a LinkedIn message for you to copy and send yourself.

## 3. Email sender (needs the domain)

Do not send outreach from your main domain, and never through Brevo (Brevo is for Harbor's own
messages and forbids third-party lists).

1. Buy a separate domain for outreach, similar to your brand.
2. Create 2 or 3 mailboxes on it (Google Workspace or Microsoft 365).
3. Set SPF, DKIM and DMARC records for the domain.
4. Choose one sender:

   **Instantly (recommended).** Connect the mailboxes and let warm-up run for 2 to 3 weeks.
   Create a campaign with a single step: subject `{{subject}}`, body `{{body}}`. Set its schedule
   and activate it. Optionally create a second campaign the same way for client pitches.
   Secrets: `INSTANTLY_API_KEY`, `INSTANTLY_CAMPAIGN_ID`, optional `INSTANTLY_CLIENT_CAMPAIGN_ID`.

   **Gmail API (one mailbox, no warm-up tooling).** Create an OAuth client in Google Cloud,
   authorise the outreach mailbox with the `gmail.send` scope, and keep the refresh token.
   Secrets: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER`.

## 4. Links in emails

Add the secret `PORTAL_BASE_URL` with the address where Harbor is hosted (for example
`https://app.yourdomain.com`). The "I'm interested", unsubscribe and delete links in every email
open Harbor at `/?u=…`.

## 5. Sender details (required before anything is sent)

**Outreach → Setup** (Admin): sender name, sender title and business postal address. Anti-spam
law (CAN-SPAM in the US, GDPR in Europe, PDPA in Malaysia) requires the address and an
unsubscribe link in every email. Harbor adds these, plus a "why you're getting this" notice for
people outside the US, automatically.

## Spending needs an Admin's approval

Nothing that costs credits runs on its own. When a job's bench is short, or the daily client-lead
feed is due, Harbor creates a request in **Outreach → Approvals** with the estimated cost and emails
every Admin. It runs only when an Admin clicks **Approve and run** (or is declined, and nothing is
spent). When an Admin clicks "Search outside Harbor" or "Fetch today's jobs" themselves, they confirm
the cost first; when Rec Ops clicks them, it becomes a request for an Admin.

## How sending works

- **Approval**: by default a person approves every email (Outreach → Candidate outreach or
  Client leads, or on the job page). Switch to automatic in Setup once you trust the drafts.
- Approved emails go into a queue and are sent every 10 minutes, up to the daily limit
  (default 40). If no sender is connected yet, they simply wait.
- **Unsubscribe or delete** puts a one-way hash of the address on a suppression list, so the
  person is never emailed again. Delete also erases their details.
- Outside contacts who never engaged are deleted after 90 days (Setup: retention).
- "I'm interested" from a candidate creates an application in the Inbox for that job. From a
  hiring manager it moves the lead to Replied.

## Secrets summary

| Secret | For |
|---|---|
| `APOLLO_API_KEY` | Outside candidates, hiring managers' emails |
| `THEIRSTACK_API_KEY` | Daily job feed |
| `INSTANTLY_API_KEY`, `INSTANTLY_CAMPAIGN_ID`, `INSTANTLY_CLIENT_CAMPAIGN_ID` (optional) | Sending via Instantly |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER` | Sending via Gmail instead |
| `PORTAL_BASE_URL` | Links in emails |
| `ANTHROPIC_API_KEY` | Already set |
