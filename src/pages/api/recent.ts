import type { APIRoute } from 'astro';
import { getCached, setCache } from '../../lib/s3cache';
import type { RecentOpinion } from '../../lib/types';

export const prerender = false;

const SCOTUS_BASE = 'https://www.supremecourt.gov';

function getCurrentTerm(): string {
  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return String(year).slice(-2);
}

function parseOpinionRows(html: string): RecentOpinion[] {
  const opinions: RecentOpinion[] = [];

  // Match entire table rows, then extract cells
  // SCOTUS slip opinion pages: columns are R#, Date, Docket, Name, J., Citation
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];
    const cells: string[] = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].trim());
    }
    if (cells.length < 4) continue;
    const dateCell = cells[1];
    const docketCell = cells[2];
    const nameCell = cells[3];

    // Extract date
    const dateMatch = dateCell.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    if (!dateMatch) continue;

    // Extract docket number
    const docketMatch = docketCell.match(/([\dA-Z\-]+)/);
    if (!docketMatch) continue;

    // Extract case name and PDF link
    const linkMatch = nameCell.match(/href=['"](.*?\.pdf)['"]/i);
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
    const term = getCurrentTerm();
    const resp = await fetch(`${SCOTUS_BASE}/opinions/slipopinion/${term}`);
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
