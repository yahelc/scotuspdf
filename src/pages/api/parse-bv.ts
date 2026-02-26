import type { APIRoute } from 'astro';
import { parseBoundVolumeCase } from '../../lib/bv-parser';
import { getCached, setCache } from '../../lib/s3cache';
import type { ParsedOpinion } from '../../lib/types';

export const prerender = false;

const BASE = 'https://www.supremecourt.gov/opinions';

/**
 * Returns ordered groups of candidate URLs for a volume.
 * Each group is one PDF part (PP1, PP2); within a group we try variants
 * until one responds 200. If the case isn't found in part 1, we fall through
 * to part 2 (necessary for multi-part preliminary prints).
 *
 * Volumes 502–585: single bound volume PDF
 * Volumes 586–591: preliminary prints, may be split into PP1 + PP2
 * Volumes > 591:   not yet available
 */
function getUrlGroups(volume: number): string[][] {
  if (volume >= 502 && volume <= 585) {
    return [[`${BASE}/boundvolumes/${volume}BV.pdf`]];
  }
  if (volume >= 586 && volume <= 591) {
    return [
      [
        `${BASE}/preliminaryprint/${volume}US1PP_final.pdf`,
        `${BASE}/preliminaryprint/${volume}US1PP_web.pdf`,
      ],
      [
        `${BASE}/preliminaryprint/${volume}US2PP_final.pdf`,
        `${BASE}/preliminaryprint/${volume}US2PP_web.pdf`,
      ],
    ];
  }
  return [];
}

async function resolveUrl(candidates: string[]): Promise<string | null> {
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { method: 'HEAD' });
      if (resp.ok) return url;
    } catch {
      // try next
    }
  }
  return null;
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const volumeParam = url.searchParams.get('volume');
  const pageParam = url.searchParams.get('page');

  if (!volumeParam || !pageParam) {
    return new Response(JSON.stringify({ error: 'Missing volume or page parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const volume = parseInt(volumeParam);
  const page = parseInt(pageParam);
  const urlGroups = getUrlGroups(volume);

  if (isNaN(volume) || isNaN(page) || page < 1 || !urlGroups.length) {
    return new Response(JSON.stringify({ error: 'Bound volume not yet published for this case' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cacheKey = `parsed/bv/${volume}/${page}.json`;

  // Check cache
  const cached = await getCached<ParsedOpinion>(cacheKey);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=0, s-maxage=2592000',
      },
    });
  }

  // Try each URL group in order (PP1 then PP2 for preliminary prints)
  let parsed: ParsedOpinion | null = null;
  let lastError = 'Case not found in volume';

  for (const candidates of urlGroups) {
    const pdfUrl = await resolveUrl(candidates);
    if (!pdfUrl) continue;

    let pdfData: ArrayBuffer;
    try {
      const resp = await fetch(pdfUrl);
      if (!resp.ok) continue;
      pdfData = await resp.arrayBuffer();
    } catch {
      continue;
    }

    try {
      parsed = await parseBoundVolumeCase(pdfData, volume, page);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // case not in this part — try next group
    }
  }

  if (!parsed) {
    console.error('Bound volume parse error:', lastError);
    return new Response(JSON.stringify({ error: 'Failed to parse bound volume case', detail: lastError }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cache (non-blocking)
  setCache(cacheKey, parsed).catch(err => console.error('Cache store failed:', err));

  return new Response(JSON.stringify(parsed), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=0, s-maxage=2592000',
    },
  });
};
