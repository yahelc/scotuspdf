/**
 * Builds a mapping of U.S. Reports volume → OT term year by querying
 * the Oyez API for each term from OT1955 to the current year.
 *
 * Output: src/data/vol-term-map.json
 *   { "vol": term, ... }  e.g. { "350": 1955, "425": 1975, ... }
 *
 * Run: npx tsx scripts/build-vol-term-map.ts
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const MIN_TERM = 1955;
const MAX_TERM = new Date().getFullYear();
const PER_PAGE = 300; // covers largest known terms (max ~184)

const volToTerm: Record<number, number> = {};

async function fetchTermCases(term: number): Promise<void> {
  const url = `https://api.oyez.org/cases?filter=term:${term}&per_page=${PER_PAGE}&page=0`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  term ${term}: HTTP ${res.status}`);
      return;
    }
    const cases = await res.json() as Array<{ citation?: { volume?: string } }>;
    let mapped = 0;
    for (const c of cases) {
      const vol = parseInt(c.citation?.volume ?? '');
      if (!isNaN(vol) && vol > 0) {
        // If multiple terms share the same volume, the earlier term wins
        if (!(vol in volToTerm)) {
          volToTerm[vol] = term;
          mapped++;
        }
      }
    }
    console.log(`  term ${term}: ${cases.length} cases, ${mapped} new volumes mapped`);
  } catch (err) {
    console.warn(`  term ${term}: fetch failed`, err);
  }
}

console.log(`Fetching Oyez data for OT${MIN_TERM}–OT${MAX_TERM}...`);

for (let term = MIN_TERM; term <= MAX_TERM; term++) {
  await fetchTermCases(term);
  await new Promise(r => setTimeout(r, 100));
}

// Sort by volume number
const sorted = Object.entries(volToTerm)
  .sort(([a], [b]) => parseInt(a) - parseInt(b))
  .reduce<Record<string, number>>((acc, [vol, term]) => {
    acc[vol] = term;
    return acc;
  }, {});

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '../src/data/vol-term-map.json');
writeFileSync(outPath, JSON.stringify(sorted, null, 2));
console.log(`\nWrote ${Object.keys(sorted).length} entries to ${outPath}`);
console.log(`Volume range: ${Object.keys(sorted)[0]}–${Object.keys(sorted).at(-1)}`);
