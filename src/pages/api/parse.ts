import type { APIRoute } from 'astro';
import { parsePdf } from '../../lib/parser';
import { getCached, setCache } from '../../lib/s3cache';
import type { ParsedOpinion } from '../../lib/types';

export const prerender = false;

const ALLOWED_HOSTS = ['www.supremecourt.gov', 'supremecourt.gov'];
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB
const FETCH_TIMEOUT_MS = 15_000;

const inflight = new Map<string, Promise<ParsedOpinion>>();

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

  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname) || parsedUrl.protocol !== 'https:') {
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
        'Cache-Control': 'max-age=0, s-maxage=2592000',
      },
    });
  }

  // Singleflight: if another request is already parsing this PDF, reuse its promise
  let parsePromise = inflight.get(cacheKey);
  if (!parsePromise) {
    parsePromise = (async (): Promise<ParsedOpinion> => {
      const pdfData = await fetchPdfWithLimits(pdfUrl);
      return await parsePdf(pdfData, pdfUrl);
    })();
    inflight.set(cacheKey, parsePromise);
    parsePromise.finally(() => inflight.delete(cacheKey));
  }

  let parsed: ParsedOpinion;
  try {
    parsed = await parsePromise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'PDF_TOO_LARGE') {
      return new Response(JSON.stringify({ error: 'PDF exceeds max size' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (message === 'PDF_FETCH_TIMEOUT') {
      return new Response(JSON.stringify({ error: 'PDF fetch timed out' }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('PDF parse error:', message);
    return new Response(JSON.stringify({ error: 'Failed to parse PDF' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cache in S3 (non-blocking)
  setCache(cacheKey, parsed).catch((err) => console.error('Cache store failed:', err));

  return new Response(JSON.stringify(parsed), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=0, s-maxage=2592000',
    },
  });
};

async function fetchPdfWithLimits(pdfUrl: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(pdfUrl, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Failed to fetch PDF: ${resp.status}`);
    }

    const contentLength = resp.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_PDF_BYTES) {
      throw new Error('PDF_TOO_LARGE');
    }

    if (!resp.body) {
      const fallback = await resp.arrayBuffer();
      if (fallback.byteLength > MAX_PDF_BYTES) throw new Error('PDF_TOO_LARGE');
      return fallback;
    }

    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PDF_BYTES) {
        controller.abort();
        throw new Error('PDF_TOO_LARGE');
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.buffer;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('PDF_FETCH_TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
