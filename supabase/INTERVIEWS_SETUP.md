# Interview calendar: setup

The interview calendar works now without any setup: scheduling, the Interviews page, outcomes,
candidate emails and reminders (through your existing Brevo candidate email), the candidate's
"Yes, I'll be there" and the no-show follow-up.

Google Calendar sync and automatic Google Meet links need one Google sign-in app for Harbor.
After that, each person connects their own Google account on **My profile → Calendar**.

## 1. Create the Google sign-in app (once, about 15 minutes)

1. Go to console.cloud.google.com and create a project, for example "Harbor".
2. **APIs & Services → Library**: enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (or Internal if everyone uses one Google Workspace).
   - App name "Harbor", your support email, your logo if you like.
   - Scopes: add
     - `https://www.googleapis.com/auth/calendar.app.created`
     - `https://www.googleapis.com/auth/calendar.freebusy`
     - `openid` and `email`
   - Test users: add each recruiter's Google address. While the app is in "Testing", up to
     100 named people can connect, which is enough for an internal team. (Testing-mode access
     must be renewed every 7 days; to avoid that, publish the app and complete Google's
     verification for the calendar scopes.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorised redirect URI, exactly:
     `https://acjmsihvvupqiikxckho.supabase.co/functions/v1/interviews/oauth`
   - Copy the **Client ID** and **Client secret**.

## 2. Add the keys to Supabase

Supabase dashboard → **Edge Functions → Secrets**:

| Secret | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID |
| `GOOGLE_CLIENT_SECRET` | the Client secret |
| `PORTAL_BASE_URL` | where Harbor is hosted (used in email links), if not set already |

Never put these in the repo or in `index.html`.

## 3. Each recruiter connects

My profile → **Calendar** → **Connect Google Calendar**. Harbor creates a calendar called
"Harbor interviews" in their account and only ever touches that calendar, plus free/busy
times for clash warnings. It never reads their other meetings.

## How it behaves

- Scheduling puts the interview in the recruiter's "Harbor interviews" calendar with a Google
  Meet link (for video calls), and emails the candidate an invite with a calendar file.
- Moving or deleting the event in Google updates Harbor within 10 minutes, and the candidate is
  emailed the new time (or the cancellation).
- Reminders go to the candidate 24 hours and 1 hour before, when "Email the candidate" is ticked.
- Candidates can confirm they'll attend or add it to their calendar. They are not offered a
  reschedule option. If you mark a no-show, they get one follow-up by email and on their
  candidate page: "Sorry we missed you... if you'd like to reschedule, let us know."
- Outcomes: Offer moves the role to Offer; Client reject marks the role Rejected and returns the
  candidate to Active file unless they are live on another role.
