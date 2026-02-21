# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SCOTUS PDF Reader — a web app that takes Supreme Court slip opinion PDFs (optimized for print) and reflows them into a mobile-friendly reading experience. Deployed on Netlify at https://scotuspdf.netlify.app.

## Commands

```bash
npm run dev      # Start Astro dev server at localhost:4321
npm run build    # Build for production (outputs to dist/)
npm run preview  # Preview production build locally
```

**Important**: When restarting the dev server, always flush the Vite cache first:
```bash
rm -rf node_modules/.vite && npm run dev
```

**Deploying** (always purge CDN cache after deploy):
```bash
rm -rf node_modules/.vite && npx netlify-cli deploy --prod --dir=dist

# Purge Netlify CDN cache (required — API responses have long cache headers)
TOKEN=$(python3 -c "import json; c=json.load(open('$HOME/Library/Preferences/netlify/config.json')); users=c.get('users',{}); uid=list(users.keys())[0]; print(users[uid]['auth']['token'])")
curl -s -X POST "https://api.netlify.com/api/v1/purge" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"site_id":"751ab2cd-6265-41d6-8d7e-591b870e6d42"}'
```

## Architecture

```
User → index.astro (paste URL) → /read/:term/:filename
       Reader.svelte (Svelte 5 island, client:load)
         → /api/parse?url=<scotus-pdf-url>
           → S3 cache check → if miss: download PDF → parse with pdfjs-dist → cache in S3
         → returns ParsedOpinion JSON
         → renders chapters with footnote popovers, font size control, chapter nav
```

### Key Files

- **`src/lib/parser.ts`** — Core PDF parsing engine. Most complex file. Two-pass approach:
  1. Extract text items from all pages via pdfjs-dist, identify section headers from the "header band" (y position at 80-84% of page height on every SCOTUS PDF page)
  2. Group pages by section header changes into chapters (Syllabus, Opinion, concurrences, dissents)
  - Handles small-cap rendering artifacts (SCOTUS PDFs use actual small caps where first letter is 11pt and rest are 9pt — pdfjs returns these as separate text items)
  - `fixSmallCaps()` post-processing cleans up split names like "J USTICE G ORSUCH" → "JUSTICE GORSUCH"
  - `KNOWN_JUSTICES` map used for name normalization
  - **pdfjs-dist serverless fix**: Must pre-load worker onto `globalThis.pdfjsWorker` before importing pdf.mjs, because Web Workers aren't available in Netlify Functions

- **`src/components/Reader.svelte`** — Svelte 5 reader UI with `$state`/`$effect`/`$derived` runes. Chapter navigation, font size slider, footnote popovers, localStorage position persistence.

- **`src/pages/api/parse.ts`** — Server endpoint that validates URL (must be supremecourt.gov), checks S3 cache, downloads PDF, parses, returns JSON.

- **`src/pages/api/recent.ts`** — Scrapes supremecourt.gov for recent slip opinions via HTML table regex parsing.

- **`src/lib/s3cache.ts`** — Optional S3 caching layer. Gracefully no-ops when `S3_BUCKET` env var is not set.

- **`src/lib/preferences.ts`** — localStorage for user preferences (fontSize, viewMode) and per-opinion reading position.

### URL Scheme

- `/` — Home page (search box + recent opinions)
- `/read/:term/:filename` — Reader (e.g., `/read/25/24-1287_4gcj.pdf`)
- SCOTUS PDF URL pattern: `https://www.supremecourt.gov/opinions/{term}pdf/{filename}`

## Tech Stack

- **Astro 5** with Svelte 5 islands — static pages + server endpoints via `prerender = false`
- **Netlify** adapter (serverless functions, NOT edge functions)
- **pdfjs-dist** (legacy build) for PDF text extraction in Node.js
- **@aws-sdk/client-s3** for optional persistent caching
- Styling: CSS custom properties, dark mode via `prefers-color-scheme`, Century Schoolbook serif font

## Key Gotchas

1. **Astro v5 removed `output: "hybrid"`** — don't add it back. Use default static output with `prerender = false` on individual endpoints.
2. **pdfjs-dist in serverless**: Must set `globalThis.pdfjsWorker` to the worker module before importing `pdf.mjs`. Without this, it tries to spawn a Web Worker and fails.
3. **netlify.toml `included_files`**: The pdfjs worker file must be listed in `included_files` to be available in the function bundle.
4. **SCOTUS PDF structure**: Section headers appear at consistent Y position (~80-84% of page height). This is the reliable way to detect chapter boundaries — NOT text regex matching, which produces false positives from citations.
5. **Small caps**: SCOTUS uses actual small caps (first letter at body font, rest at ~80% size). The parser handles this during line joining and via post-processing regex.

## Test Opinions

Validate parser changes against these real opinions:
- Trump v. United States (23-939): `https://www.supremecourt.gov/opinions/23pdf/23-939_e2pg.pdf` — 6 chapters
- Learning Resources v. Trump (24-1287): `https://www.supremecourt.gov/opinions/25pdf/24-1287_4gcj.pdf` — 8 chapters, uses "Opinion of JUSTICE" header format
