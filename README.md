# Harbor

A recruitment-agency dashboard with three role views (Rec Ops, Recruiter, Admin), backed by Supabase (Postgres + Auth + Storage + Edge Functions) and an AI provider (Gemini for now, Anthropic as the fallback) for CV scoring, screening questions, fit verdicts and job-ad rewriting.

## Structure

- `app.jsx` — the canonical React source for the whole app (single file). Built into a self-contained `harbor.html`.
- `build/` — the build: `build.mjs` (esbuild bundle → `harbor.html`), `main.jsx` (entry), `lucide-shim.js` (maps the `lucide-react` icon names to `react-icons/lu`).
- `supabase/schema.sql` — the database schema (tables, RLS policies, storage bucket, candidate-portal function). Already applied to the live project; kept here as the source of truth.
- `supabase/functions/ai-screen/index.ts` — CV scoring, screening-question drafting and the post-screening fit verdict. Every score and verdict uses both the resume (PDF from the `resumes` bucket) and the candidate's screening answers (the job's own questions in `candidate_jobs.screening_answers` plus the AI-screening reply). Scoring against a job also sets that job link's fit.
- `supabase/functions/job-redraft/index.ts` — the "AI redraft for SEO" button on Post a job: rewrites the job ad, snippet and search keywords.

## Features added in the second workspace

- **Job pipeline** — `candidate_jobs` links a candidate to one or more jobs, each with a stage (Sourced → Screening → Submitted → Interview → Offer → Placed / Rejected / Withdrawn) and a fit score. Stages can be changed from the job page or the candidate's profile ("Jobs" card).
- **Resumes** — one private bucket, `resumes`, with files at `<candidate_id>/<file>` (`candidates.resume_path`, `resume_name`). Upload, view (10-minute signed link) and AI scoring all use the same file. The older `cvs` bucket / `cv_path` is still read as a fallback.
- **Job currency and hiring country** — `jobs.currency` (ISO code, default NGN) and `jobs.country`. Picking a country pre-selects its currency; pay shows in the job's currency.
- **AI redraft for SEO** — reviewed before use; the chosen keywords and snippet are saved in `jobs.seo`.

## Building

```
Entry point `build/main.jsx`; `lucide-react` imports in `app.jsx` resolve to `build/lucide-shim.js` (react-icons/lu). Any bundler works, e.g. with bun:

```
sed 's#from "lucide-react";#from "./lucide-shim.js";#' app.jsx > build/app.jsx
bun build build/main.jsx --minify --target=browser --format=iife --define 'process.env.NODE_ENV="production"' --outfile=build/bundle.js
```

then inline the bundle into the page (escape `</script` as `<\/script`).
```

`index.html` in this repo is the latest build (same as `harbor.html`). Open it directly in a browser. Only the Tailwind CDN script loads from the internet.

## Backend

Supabase project ref: `acjmsihvvupqiikxckho`. Secrets live only as Supabase Edge Function secrets (Edge Functions → Secrets) — never in this repo.

AI provider: both AI functions use **Gemini** when `GEMINI_API_KEY` is set (model from `GEMINI_MODEL`, default `gemini-3.8-flash`), and fall back to Anthropic (`ANTHROPIC_API_KEY`) when it isn't. To switch back to Claude, delete the `GEMINI_API_KEY` secret; no code change needed. Use a Gemini key on a billed project for live candidate data: Google's free tier may use prompts (resumes) to improve its products.

## Working across two workspaces

`app.jsx` is the single source of truth. Pull before you start editing in either workspace, push when you're done, and rebuild `harbor.html` after pulling so the two stay in sync. Database changes go in `supabase/schema.sql` in the same commit that uses them.
