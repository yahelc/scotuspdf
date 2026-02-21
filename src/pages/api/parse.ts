import type { APIRoute } from 'astro';
import { parsePdf } from '../../lib/parser';
import { getCached, setCache } from '../../lib/s3cache';
import type { ParsedOpinion } from '../../lib/types';

export const prerender = false;

const ALLOWED_HOSTS = ['www.supremecourt.gov', 'supremecourt.gov'];

function cacheKeyFromUrl(url: string): string {
  const parsed = new URL(url);
  // e.g., "opinions/slipopinion/25/23-1345_opinion.pdf" -> "parsed/25/23-1345_opinion.json"
  const path = parsed.pathname.replace(/^\//, '').replace(/\.pdf$/, '');
  return `parsed/${path}.json`;
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const pdfUrl = url.searchParams.get('url');

  if (!pdfUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pdfUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    return new Response(JSON.stringify({ error: 'URL must be from supremecourt.gov' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cacheKey = cacheKeyFromUrl(pdfUrl);

  // Check cache
  const cached = await getCached<ParsedOpinion>(cacheKey);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=86400, s-maxage=2592000',
      },
    });
  }

  // Download PDF
  let pdfData: ArrayBuffer;
  try {
    const resp = await fetch(pdfUrl);
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch PDF: ${resp.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    pdfData = await resp.arrayBuffer();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to download PDF' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse
  let parsed: ParsedOpinion;
  try {
    parsed = await parsePdf(pdfData, pdfUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('PDF parse error:', message, stack);
    return new Response(JSON.stringify({ error: 'Failed to parse PDF', detail: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cache in S3 (non-blocking)
  setCache(cacheKey, parsed).catch((err) => console.error('Cache store failed:', err));

  return new Response(JSON.stringify(parsed), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=86400, s-maxage=2592000',
    },
  });
};
