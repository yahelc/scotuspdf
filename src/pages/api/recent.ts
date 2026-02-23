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

export function parseOpinionRows(html: string): RecentOpinion[] {
  const opinions: RecentOpinion[] = [];
  const seen = new Set<string>();

  // Preferred path: parse by table rows/cells.
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];
    const cells: string[] = [];
    const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
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
    const linkMatch = nameCell.match(/href=['"]([^'"]+?\.pdf(?:\?[^'"]*)?)['"]/i);
    const titleText = stripHtml(nameCell);
    if (!linkMatch || !titleText) continue;

    const pdfPath = linkMatch[1];
    const pdfUrl = pdfPath.startsWith('http') ? pdfPath : `${SCOTUS_BASE}${pdfPath}`;

    // Extract term and filename from URL path like /opinions/24pdf/filename.pdf
    const pathMatch = pdfPath.match(/\/(\d{2})pdf\/([\w\-]+\.pdf)/i);
    const term = pathMatch ? pathMatch[1] : '';
    const filename = pathMatch ? pathMatch[2] : pdfPath.split('/').pop() || '';

    const key = `${term}/${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);

    opinions.push({
      title: titleText,
      date: dateMatch[1],
      docketNumber: docketMatch[1],
      pdfUrl,
      term,
      filename,
    });
  }

  // Fallback: if row parsing found nothing, collect PDF anchors directly.
  if (opinions.length === 0) {
    const anchorRegex = /<a\b[^>]*href=['"]([^'"]+?\.pdf(?:\?[^'"]*)?)['"][^>]*>([\s\S]*?)<\/a>/gi;
    let anchorMatch;
    while ((anchorMatch = anchorRegex.exec(html)) !== null) {
      const pdfPath = anchorMatch[1];
      const title = stripHtml(anchorMatch[2]);
      if (!title) continue;

      const pathMatch = pdfPath.match(/\/(\d{2})pdf\/([\w.-]+\.pdf)/i);
      const term = pathMatch ? pathMatch[1] : '';
      const filename = pathMatch ? pathMatch[2] : pdfPath.split('/').pop() || '';
      const key = `${term}/${filename}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const pdfUrl = pdfPath.startsWith('http') ? pdfPath : `${SCOTUS_BASE}${pdfPath}`;
      opinions.push({
        title,
        date: '',
        docketNumber: '',
        pdfUrl,
        term,
        filename,
      });
      if (opinions.length >= 10) break;
    }
  }

  return opinions.slice(0, 10);
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(input: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
    '&middot;': '\u00b7',
  };
  let out = input.replace(/&(amp|lt|gt|quot|nbsp|middot|#39);/g, (m) => entities[m] || m);
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return out;
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
