import type { APIRoute } from 'astro';
import { getCached, setCache } from '../../lib/s3cache';

export const prerender = false;

// govinfo publishes annual USC editions with a ~1-2 year lag.
// The link service (?year=N) only redirects to main editions (every 6 years), not annual
// supplements. So we use the link service to get the granule path structure, then probe
// for newer year-URLs directly (in parallel) to find the most recent available edition.
const EDITION_LAG = 1;
const MAX_FALLBACK_YEARS = 5;

interface EditionResult {
  htmlUrl: string;
  editionYear: number;
  baseHtmlUrl: string;
  baseYear: number;
}

async function findBestEditionHtml(
  title: number,
  section: number,
  startYear: number
): Promise<EditionResult | null> {
  // Step 1: Use the link service to get the base granule path (it caps at the latest main
  // edition — typically 2022 or older — but gives us the title/chapter/section path we need)
  let basePdfLocation: string | null = null;
  let baseYear = startYear;

  for (let year = startYear; year >= startYear - MAX_FALLBACK_YEARS; year--) {
    try {
      const res = await fetch(
        `https://www.govinfo.gov/link/uscode/${title}/${section}?year=${year}`,
        { redirect: 'manual' }
      );
      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) {
        basePdfLocation = location;
        const yearMatch = location.match(/USCODE-(\d{4})-/);
        baseYear = yearMatch ? parseInt(yearMatch[1]) : year;
        break;
      }
    } catch {
      return null;
    }
  }

  if (!basePdfLocation) return null;

  const baseHtmlUrl = basePdfLocation
    .replace('/pdf/', '/html/')
    .replace(/\.pdf$/, '.htm');

  // Step 2: The link service may redirect to an older edition — probe newer years in
  // parallel by swapping the year in the URL. Annual supplements have the same path
  // structure, so USCODE-2022-title50-chap35-sec1701 → USCODE-2024-title50-chap35-sec1701.
  const probeYears: number[] = [];
  for (let y = startYear; y > baseYear; y--) probeYears.push(y);

  if (probeYears.length > 0) {
    const probeResults = await Promise.all(
      probeYears.map(async (year) => {
        const url = baseHtmlUrl.replace(
          new RegExp(`USCODE-${baseYear}-`, 'g'),
          `USCODE-${year}-`
        );
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          // redirect: 'manual' so a 302→govinfo-homepage doesn't look like a 200
          const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
          clearTimeout(timer);
          return res.status === 200 ? { year, url } : null;
        } catch {
          return null;
        }
      })
    );
    const best = probeResults
      .filter((r): r is { year: number; url: string } => r !== null)
      .sort((a, b) => b.year - a.year)[0];
    if (best) return { htmlUrl: best.url, editionYear: best.year, baseHtmlUrl, baseYear };
  }

  return { htmlUrl: baseHtmlUrl, editionYear: baseYear, baseHtmlUrl, baseYear };
}

// govinfo sometimes serves its navigation/homepage with HTTP 200 when a specific
// annual-supplement file doesn't exist (soft 404). Detect by looking for a marker
// that appears in the nav page but never in a real USC section document.
function isGovInfoNavPage(html: string): boolean {
  return html.includes('GovInfo logo');
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const titleParam = url.searchParams.get('title');
  const sectionParam = url.searchParams.get('section');
  const yearParam = url.searchParams.get('year');

  // Validate params
  if (!titleParam || !sectionParam || !yearParam) {
    return new Response(JSON.stringify({ error: 'Missing params' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const title = parseInt(titleParam);
  const section = parseInt(sectionParam);
  const decisionYear = parseInt(yearParam);

  if (isNaN(title) || isNaN(section) || isNaN(decisionYear)) {
    return new Response(JSON.stringify({ error: 'Invalid params' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cap at currentYear - EDITION_LAG so we don't request editions that don't exist yet
  const startYear = Math.min(decisionYear, new Date().getFullYear() - EDITION_LAG);
  const cacheKey = `usc-v1:${title}:${section}:${startYear}`;

  // Check S3 cache
  const cached = await getCached<{ html: string; editionYear: number; sourceUrl: string }>(cacheKey);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
    });
  }

  // Find the best available edition, probing newer years if the link service is behind
  const found = await findBestEditionHtml(title, section, startYear);
  if (!found) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let { htmlUrl, editionYear: actualEditionYear, baseHtmlUrl, baseYear } = found;

  // Fetch the HTML page (manual redirect so a govinfo 302→homepage doesn't sneak through)
  async function fetchHtml(url: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { redirect: 'manual', signal: controller.signal });
      clearTimeout(timeout);
      if (res.status !== 200) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  let rawHtml: string | null = await fetchHtml(htmlUrl);

  // govinfo returns HTTP 200 with navigation HTML (soft 404) when an annual-supplement
  // file doesn't exist. If detected, fall back to the base link-service edition.
  if (rawHtml === null || isGovInfoNavPage(rawHtml)) {
    if (htmlUrl !== baseHtmlUrl) {
      rawHtml = await fetchHtml(baseHtmlUrl);
      if (rawHtml !== null && !isGovInfoNavPage(rawHtml)) {
        htmlUrl = baseHtmlUrl;
        actualEditionYear = baseYear;
      } else {
        rawHtml = null;
      }
    } else {
      rawHtml = null;
    }
  }

  if (rawHtml === null) {
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

  const result = { html: bodyContent, editionYear: actualEditionYear, sourceUrl: htmlUrl };

  // Cache for 30 days
  await setCache(cacheKey, result, 30 * 24 * 60 * 60);

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
  });
};
