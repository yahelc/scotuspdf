#!/usr/bin/env tsx
/**
 * Build the US Reports citation index.
 *
 * Maps "volume:page" → { term, filename, docket } for OT2019–current term.
 *
 * Sources:
 *   - supremecourt.gov/opinions/slipopinion/{termCode}  — slip opinion PDF URLs
 *   - courtlistener.com REST API (SCOTUS opinions)      — US Reports citations
 *
 * The two datasets are joined on docket number.
 *
 * Oyez's citation.page is null for OT2015+ cases, so we use CourtListener
 * instead which reliably has the full "VVV U.S. PPP" citation string.
 *
 * Usage:
 *   npx tsx scripts/build-cite-index.ts
 *
 * Output: src/data/cite-index.json
 */

import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';

interface CiteEntry {
  term: string;     // 2-digit SCOTUS term code, e.g. "24"
  filename: string; // e.g. "24-354_x1q3.pdf"
  docket: string;   // e.g. "24-354"
}

// OT2019 is the earliest term with accessible SCOTUS listing pages.
const TERMS = [
  { termCode: '19' },
  { termCode: '20' },
  { termCode: '21' },
  { termCode: '22' },
  { termCode: '23' },
  { termCode: '24' },
  { termCode: '25' },
];

// ─── SCOTUS listing scraper ────────────────────────────────────────────────

async function fetchScotusListing(
  termCode: string
): Promise<Map<string, { termCode: string; filename: string }>> {
  const url = `https://www.supremecourt.gov/opinions/slipopinion/${termCode}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`SCOTUS ${termCode}: HTTP ${resp.status}`);

  const html = await resp.text();
  if (html.includes('Object moved')) {
    throw new Error(`SCOTUS ${termCode}: redirected (term not available)`);
  }

  const result = new Map<string, { termCode: string; filename: string }>();
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[1];
    const pdfMatch = row.match(/href='\/opinions\/(\d+)pdf\/([\w\-_.]+\.pdf)'/i);
    if (!pdfMatch) continue;
    const pdfTermCode = pdfMatch[1];
    const filename = pdfMatch[2];

    // Docket numbers: "XX-XXXXX" format
    const docketMatch = row.match(/\b(\d{2}-\d{1,5})\b/);
    if (!docketMatch) continue;

    result.set(docketMatch[1], { termCode: pdfTermCode, filename });
  }
  return result;
}

// ─── CourtListener scraper ─────────────────────────────────────────────────
// Fetches all SCOTUS opinions filed since OT2019 start, extracts
// docketNumber → {volume, page} from the "NNN U.S. NNN" citation string.

async function fetchCourtListenerCitations(): Promise<Map<string, { volume: string; page: string }>> {
  const result = new Map<string, { volume: string; page: string }>();

  // OT2019 started ~October 2019; fetch from 2019-08-01 to cover any late OT2018
  // cases that might bleed through, while staying clear of earlier terms.
  let url: string | null =
    'https://www.courtlistener.com/api/rest/v4/search/?' +
    'court=scotus&filed_after=2019-08-01&type=o&order_by=dateFiled+asc&per_page=20';

  let page = 0;
  let total = 0;

  while (url) {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) {
      console.warn(`  CourtListener HTTP ${resp.status} — stopping pagination`);
      break;
    }
    const data: { count?: number; next?: string | null; results: any[] } = await resp.json();

    if (page === 0) {
      total = data.count ?? 0;
      process.stdout.write(`  CourtListener: ${total} total opinions, fetching`);
    }
    process.stdout.write('.');

    for (const r of data.results ?? []) {
      const docket = (r.docketNumber ?? '').trim();
      if (!docket) continue;

      // citation is an array of strings like ["603 U.S. 593", "144 S. Ct. 2312"]
      const citations: string[] = r.citation ?? [];
      for (const c of citations) {
        // Match "NNN U.S. NNN" (with or without spaces/periods in "U.S.")
        const m = c.match(/^(\d+)\s+U\.?\s*S\.?\s+(\d+)/);
        if (m) {
          result.set(docket, { volume: m[1], page: m[2] });
          break;
        }
      }
    }

    url = data.next ?? null;
    page++;
    // Small delay to be polite
    await new Promise(r => setTimeout(r, 100));
  }

  process.stdout.write(` done (${result.size} with US Reports citations)\n`);
  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const outPath = resolve(process.cwd(), 'src/data/cite-index.json');

  // Load existing index to preserve any manually added entries
  let existing: Record<string, CiteEntry> = {};
  try {
    existing = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    // fresh start
  }

  console.log('Fetching CourtListener citations...');
  const clMap = await fetchCourtListenerCitations();

  const index: Record<string, CiteEntry> = { ...existing };
  let totalNew = 0;

  for (const { termCode } of TERMS) {
    process.stdout.write(`  SCOTUS term ${termCode}: `);
    let scotusMap: Map<string, { termCode: string; filename: string }>;
    try {
      scotusMap = await fetchScotusListing(termCode);
    } catch (err) {
      console.log(`SKIP — ${err instanceof Error ? err.message : err}`);
      continue;
    }

    let matched = 0;
    for (const [docket, fileInfo] of scotusMap) {
      const citation = clMap.get(docket);
      if (!citation) continue;
      const key = `${citation.volume}:${citation.page}`;
      if (!index[key]) totalNew++;
      index[key] = { term: fileInfo.termCode, filename: fileInfo.filename, docket };
      matched++;
    }

    console.log(`${scotusMap.size} opinions, ${matched} matched with citations`);
    await new Promise(r => setTimeout(r, 200));
  }

  const sorted = Object.fromEntries(
    Object.entries(index).sort(([a], [b]) => {
      const [av, ap] = a.split(':').map(Number);
      const [bv, bp] = b.split(':').map(Number);
      return av !== bv ? av - bv : ap - bp;
    })
  );

  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n');
  console.log(
    `\nWrote ${Object.keys(sorted).length} total entries (${totalNew} new) to ${outPath}`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
