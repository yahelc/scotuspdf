import type { APIRoute } from 'astro';
import { parsePdf } from '../../lib/parser';
import { getCached, setCache } from '../../lib/s3cache';
import type { ParsedOpinion } from '../../lib/types';

export const prerender = false;

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const vol = parseInt(url.searchParams.get('vol') ?? '');
  const page = parseInt(url.searchParams.get('page') ?? '');

  if (isNaN(vol) || isNaN(page) || vol < 1 || vol > 501 || page < 1) {
    return new Response(JSON.stringify({ error: 'Invalid or out-of-range vol/page' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cacheKey = `parsed/usreports/${vol}/${page}.json`;
  const cached = await getCached<ParsedOpinion>(cacheKey);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=0, s-maxage=2592000',
      },
    });
  }

  const apiKey = import.meta.env.GOVINFO_API_KEY ?? '';
  const pdfUrl = `https://api.govinfo.gov/packages/USREPORTS-${vol}/granules/USREPORTS-${vol}-${page}/pdf?api_key=${apiKey}`;
  const sourceUrl = `https://www.govinfo.gov/app/details/USREPORTS-${vol}/USREPORTS-${vol}-${page}`;

  let pdfData: ArrayBuffer;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(pdfUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_PDF_BYTES) throw new Error('PDF_TOO_LARGE');
    pdfData = buf;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'PDF_TOO_LARGE') {
      return new Response(JSON.stringify({ error: 'PDF too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('USREPORTS fetch error:', msg);
    return new Response(JSON.stringify({ error: 'Failed to fetch opinion PDF' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let parsed: ParsedOpinion;
  try {
    parsed = await parsePdf(pdfData, sourceUrl);
  } catch (err) {
    console.error('USREPORTS parse error:', err);
    return new Response(JSON.stringify({ error: 'Failed to parse opinion PDF' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // parsePdf() title extraction relies on "SUPREME COURT OF THE UNITED STATES" text,
  // which govinfo.gov US Reports PDFs don't have. Fall back to the granule summary API.
  if (parsed.caseTitle === 'Unknown Case') {
    try {
      const summaryResp = await fetch(
        `https://api.govinfo.gov/packages/USREPORTS-${vol}/granules/USREPORTS-${vol}-${page}/summary?api_key=${apiKey}`
      );
      if (summaryResp.ok) {
        const summary = await summaryResp.json();
        if (summary.title) {
          // Strip citation suffix: "Teamsters v. United States, 431 U.S. 324 (1977)" → "Teamsters v. United States"
          const cleanTitle = summary.title.replace(/,\s*\d+\s+U\.S\.\s+\d+.*$/i, '').trim();
          if (cleanTitle) parsed = { ...parsed, caseTitle: cleanTitle };
        }
      }
    } catch {
      // Keep "Unknown Case" if summary fetch fails
    }
  }

  setCache(cacheKey, parsed).catch(e => console.error('Cache store failed:', e));

  return new Response(JSON.stringify(parsed), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=0, s-maxage=2592000',
    },
  });
};
