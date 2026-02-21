import type { APIRoute } from 'astro';
import { getCached, setCache } from '../../lib/s3cache';
import type { RecentOpinion } from '../../lib/types';

export const prerender = false;

const SCOTUS_BASE = 'https://www.supremecourt.gov';

function parseOpinionRows(html: string): RecentOpinion[] {
  const opinions: RecentOpinion[] = [];

  // Match table rows containing opinion data
  // SCOTUS slip opinion pages use a table with columns: Date, Docket, Name, Author, PDF links
  const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const dateCell = match[1].trim();
    const docketCell = match[2].trim();
    const nameCell = match[3].trim();

    // Extract date
    const dateMatch = dateCell.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    if (!dateMatch) continue;

    // Extract docket number
    const docketMatch = docketCell.match(/([\d\-]+)/);
    if (!docketMatch) continue;

    // Extract case name and PDF link
    const linkMatch = nameCell.match(/href="([^"]*\.pdf)"/i);
    const titleMatch = nameCell.match(/>([^<]+)</);
    if (!linkMatch || !titleMatch) continue;

    const pdfPath = linkMatch[1];
    const pdfUrl = pdfPath.startsWith('http') ? pdfPath : `${SCOTUS_BASE}${pdfPath}`;

    // Extract term and filename from URL path like /opinions/24pdf/filename.pdf
    const pathMatch = pdfPath.match(/\/(\d{2})pdf\/([\w\-]+\.pdf)/i);
    const term = pathMatch ? pathMatch[1] : '';
    const filename = pathMatch ? pathMatch[2] : pdfPath.split('/').pop() || '';

    opinions.push({
      title: titleMatch[1].trim(),
      date: dateMatch[1],
      docketNumber: docketMatch[1],
      pdfUrl,
      term,
      filename,
    });
  }

  return opinions.slice(0, 10);
}

export const GET: APIRoute = async () => {
  const cacheKey = 'recent/opinions.json';

  // Check cache (short TTL)
  const cached = await getCached<RecentOpinion[]>(cacheKey);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=3600',
      },
    });
  }

  try {
    const resp = await fetch(`${SCOTUS_BASE}/opinions/slipopinion/24`);
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch opinions page' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const html = await resp.text();
    const opinions = parseOpinionRows(html);

    // Cache with short TTL
    setCache(cacheKey, opinions, 3600).catch((err) =>
      console.error('Cache store failed:', err)
    );

    return new Response(JSON.stringify(opinions), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=3600',
      },
    });
  } catch (err) {
    console.error('Recent opinions fetch error:', err);
    return new Response(JSON.stringify({ error: 'Failed to fetch recent opinions' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
