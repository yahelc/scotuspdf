# SCOTUS PDF Reader

Turns Supreme Court slip opinion PDFs (formatted for print) into a mobile-friendly reading experience. Live at **https://scotuspdf.netlify.app**.

## Commands

```bash
npm run dev              # Dev server at localhost:4321
npm run build            # Production build → dist/
npm run test             # Run test suite
npm run deploy           # test → build → deploy to Netlify

npm run build:cite-index # Rebuild the US Reports citation index (see below)
```

When restarting the dev server, flush the Vite cache and expose on the local network:
```bash
rm -rf node_modules/.vite && npx astro dev --host
```

## Citation Index

`src/data/cite-index.json` maps US Reports citations (`volume:page`) to their SCOTUS slip opinion PDFs. It's used to instantly resolve "Try to render" links when a citation is clicked in the reader.

The index covers OT2019–OT2024 (312 entries). It's built by cross-referencing:
- **supremecourt.gov** slip opinion listing pages — docket → PDF filename
- **CourtListener API** — docket → US Reports volume:page (Oyez `citation.page` is null for OT2015+)

**Refresh after each term wraps up** (typically July):
```bash
npm run build:cite-index
git add src/data/cite-index.json
git commit -m "Refresh citation index for OT20XX"
```

Current-term cases (OT2025) don't have US Reports citations yet — they're handled by the `/api/find-slip` endpoint which scrapes the SCOTUS listing on demand.

## Architecture

```
User → index.astro (paste URL) → /read/:term/:filename
       Reader.svelte (Svelte 5 island, client:load)
         → /api/parse?url=<scotus-pdf-url>
           → S3 cache check → if miss: download PDF → parse with pdfjs-dist → cache in S3
         → returns ParsedOpinion JSON
         → renders chapters with footnote popovers, font size control, chapter nav
```

See [CLAUDE.md](CLAUDE.md) for full architecture details, key gotchas, and development notes.
