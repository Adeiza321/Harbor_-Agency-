# Harbor

A recruitment-agency dashboard with three role views (Rec Ops, Recruiter, Admin), backed by Supabase (Postgres + Auth + Storage + Edge Functions) and Anthropic for CV scoring, screening questions, and fit verdicts.

## Structure

- `app.jsx` — the canonical React source for the whole app (single file, no build tooling required to read/edit). Built with esbuild into a self-contained `harbor.html`.
- `supabase/schema.sql` — the database schema (tables, RLS policies, the candidate-portal function). Already applied to the live project; kept here as the source of truth for the schema.
- `supabase/functions/ai-screen/index.ts` — the Edge Function that calls Anthropic for CV scoring, screening-question drafting, and the post-screening fit verdict. Reads a CV PDF, stores it in the `cvs` storage bucket, and re-scores from storage on request.

## Building

The app is bundled with `esbuild` (React + ReactDOM + a `lucide-react` shim bundled in) into one HTML file with only the Tailwind CDN script left external. There's no `package.json` here yet — ask Claude in whichever workspace you're in to rebuild `harbor.html` from `app.jsx` after edits.

## Backend

Supabase project ref: `acjmsihvvupqiikxckho`. Secrets (`ANTHROPIC_API_KEY`, service role key) live only as Supabase Edge Function secrets — never in this repo.

## Working across two workspaces

`app.jsx` is the single source of truth. Pull before you start editing in either workspace, push when you're done, and rebuild `harbor.html` after pulling so the two stay in sync.
