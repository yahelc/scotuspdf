import type { APIRoute } from 'astro';
import { parseBoundVolumeCase } from '../../lib/bv-parser';
import { getCached, setCache } from '../../lib/s3cache';
import type { ParsedOpinion } from '../../lib/types';

export const prerender = false;

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

  if (isNaN(volume) || isNaN(page) || volume < 502 || volume > 585 || page < 1) {
    return new Response(JSON.stringify({ error: 'Bound volume not yet published (available through vol. 585, OT2018)' }), {
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

  // Download bound volume PDF
  const pdfUrl = `https://www.supremecourt.gov/opinions/boundvolumes/${volume}bv.pdf`;
  let pdfData: ArrayBuffer;
  try {
    const resp = await fetch(pdfUrl);
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch bound volume: ${resp.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    pdfData = await resp.arrayBuffer();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to download bound volume PDF' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse
  let parsed: ParsedOpinion;
  try {
    parsed = await parseBoundVolumeCase(pdfData, volume, page);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Bound volume parse error:', message);
    return new Response(JSON.stringify({ error: 'Failed to parse bound volume case', detail: message }), {
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
