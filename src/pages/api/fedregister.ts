import type { APIRoute } from 'astro';
import { getCached, setCache } from '../../lib/s3cache';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const volumeParam = url.searchParams.get('volume');
  const pageParam = url.searchParams.get('page');

  if (!volumeParam || !pageParam) {
    return new Response(JSON.stringify({ error: 'Missing params' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const volume = parseInt(volumeParam);
  const page = parseInt(pageParam);

  if (isNaN(volume) || isNaN(page)) {
    return new Response(JSON.stringify({ error: 'Invalid params' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cacheKey = `fr-v1:${volume}:${page}`;

  const cached = await getCached<{ html: string; issueDate: string; sourceUrl: string }>(cacheKey);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
    });
  }

  // Use govinfo link service to find the specific FR issue
  let pdfLocation: string | null = null;
  try {
    const res = await fetch(
      `https://www.govinfo.gov/link/fr/${volume}/${page}`,
      { redirect: 'manual' }
    );
    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      pdfLocation = location;
    }
  } catch {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!pdfLocation) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // pdfLocation: https://www.govinfo.gov/content/pkg/FR-2025-04-15/pdf/2025-06462.pdf#page=1
  const dateMatch = pdfLocation.match(/FR-(\d{4}-\d{2}-\d{2})/);
  const issueDate = dateMatch
    ? new Date(dateMatch[1] + 'T12:00:00Z').toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '';

  // Convert to HTML URL: swap /pdf/ → /html/, strip .pdf(#...) → .htm
  const htmlUrl = pdfLocation
    .replace('/pdf/', '/html/')
    .replace(/\.pdf(#.*)?$/, '.htm');

  // Fetch the HTML page
  let rawHtml: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const htmlRes = await fetch(htmlUrl, { redirect: 'manual', signal: controller.signal });
    clearTimeout(timeout);
    if (htmlRes.status !== 200) {
      return new Response(JSON.stringify({ error: 'fetch_failed' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    rawHtml = await htmlRes.text();
  } catch {
    return new Response(JSON.stringify({ error: 'fetch_failed' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Clean HTML: strip script/style/link tags, extract body content
  let cleanedHtml = rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*\/?>/gi, '');

  const bodyMatch = cleanedHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : cleanedHtml;

  const result = { html: bodyContent, issueDate, sourceUrl: htmlUrl };

  // Cache for 30 days
  await setCache(cacheKey, result, 30 * 24 * 60 * 60);

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
  });
};
