# Harbor

A recruitment-agency dashboard with three role views (Rec Ops, Recruiter, Admin), backed by Supabase (Postgres + Auth + Storage + Edge Functions) and AI (Claude and Gemini) for CV scoring, screening questions, fit verdicts and job-ad rewriting.

## Structure

- `app.jsx` — the canonical React source for the whole app (single file). Built into the self-contained `index.html`.
- `build/` — the build: `main.jsx` (entry), `lucide-shim.js` (maps the `lucide-react` icon names to `react-icons/lu`), and the generated `app.jsx` / `bundle.js`.
- `supabase/migrations/` — changes applied to the live database after `schema.sql` was written, in date order.
- `supabase/functions/` — every Edge Function deployed to the live project (`client-view` and `record-login` were added on 7 Oct 2026; `backfill-phones` and `check-secret` are disabled one-offs that only exist live and can be deleted from the dashboard).
- `supabase/schema.sql` — the database schema (tables, RLS policies, storage bucket, candidate-portal function). Already applied to the live project; kept here as the source of truth.
- `supabase/functions/ai-screen/` — AI screening. `screening.ts`: one **company card** per job a candidate is on (`candidate_jobs.ai`): summary, strengths, gaps, score and verdict (Perfect fit / Possible fit / Reject) from the resume plus every answer the candidate has given for any job; drafts follow-up questions it has never asked before (Rec Ops/Admins approve them); the candidate answers on their candidate page and the card is rescreened and replaced. Salary expectation found in answers goes to the profile. Routed roles (`candidate_response = pending`) only get a card once the candidate accepts. `resume.ts` reads PDF, Word, ODT, RTF, text and photo resumes.
- `supabase/functions/job-redraft/index.ts` — the "AI redraft for SEO" button on Post a job: rewrites the job ad, snippet and search keywords.

## Features added in the second workspace

- **Job pipeline** — `candidate_jobs` links a candidate to one or more jobs, each with a stage (Sourced → Screening → Submitted → Interview → Offer → Placed / Rejected / Withdrawn) and a fit score. Stages can be changed from the job page or the candidate's profile ("Jobs" card).
- **Resumes** — one private bucket, `resumes`, with files at `<candidate_id>/<file>` (`candidates.resume_path`, `resume_name`). Upload, view (10-minute signed link) and AI scoring all use the same file. The older `cvs` bucket / `cv_path` is still read as a fallback.
- **Job currency and hiring country** — `jobs.currency` (ISO code, default NGN) and `jobs.country`. Picking a country pre-selects its currency; pay shows in the job's currency.
- **AI redraft for SEO** — reviewed before use; the chosen keywords and snippet are saved in `jobs.seo`.

## Building

Entry point `build/main.jsx`; `lucide-react` imports in `app.jsx` resolve to `build/lucide-shim.js` (react-icons/lu). Any bundler works, e.g. with bun:

```
sed 's#from "lucide-react";#from "./lucide-shim.js";#' app.jsx > build/app.jsx
bun build build/main.jsx --minify --target=browser --format=iife --define 'process.env.NODE_ENV="production"' --outfile=build/bundle.js
```

Then inline the bundle into `index.html` (escape `</script` as `<\/script`).

`index.html` is the latest build and is what GitHub Pages serves at the custom domain in `CNAME`. Open it directly in a browser; only the Tailwind CDN script loads from the internet. Any loose `harbor.html` copies outside the repo are older builds.

## Backend

Supabase project ref: `acjmsihvvupqiikxckho`. Secrets live only as Supabase Edge Function secrets (Edge Functions → Secrets) — never in this repo.

AI providers (secrets: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`; optional model overrides `ANTHROPIC_MODEL`, `GEMINI_MODEL`):
- Screening, scoring, follow-up questions and fit reviews (`ai-screen`): Claude first (default `claude-haiku-4-5-20251001`, the low-cost model; set `ANTHROPIC_MODEL=claude-sonnet-5` for the stronger one), with Gemini as the backup when Claude fails.
- Employer industry lookup and job redraft / job-brief extraction: Gemini first; Claude takes over if Gemini fails, is over quota or doesn't answer in time (45 s for lookups, 40 s for drafts).
ChatGPT/OpenAI is not used. Use a Gemini key on a billed project for live candidate data: Google's free tier may use prompts (resumes) to improve its products.

## Working across two workspaces

`app.jsx` is the single source of truth. Pull before you start editing in either workspace, push when you're done, and rebuild `harbor.html` after pulling so the two stay in sync. Database changes go in `supabase/schema.sql` in the same commit that uses them.
