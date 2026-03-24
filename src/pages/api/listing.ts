import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';
import type { RecentOpinion } from '../../lib/types';

export const prerender = false;

const SCOTUS_BASE = 'https://www.supremecourt.gov';
const CURRENT_TERM_STALENESS_MS = 600_000; // 10 minutes
const PAST_TERM_STALENESS_MS = 3_600_000;  // 1 hour

function getCurrentTermCode(): string {
  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return String(year).slice(-2);
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(input: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&nbsp;': ' ', '&middot;': '\u00b7',
  };
  let out = input.replace(/&(amp|lt|gt|quot|nbsp|middot|#39);/g, (m) => entities[m] || m);
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return out;
}

function parseListingRows(html: string, type: 'opinions' | 'orders'): RecentOpinion[] {
  const items: RecentOpinion[] = [];
  const seen = new Set<string>();

  // Column offsets differ between opinions and orders:
  // opinions: cells[0]=rownum, cells[1]=date, cells[2]=docket, cells[3]=name+link
  // orders:   cells[0]=date,   cells[1]=docket, cells[2]=name+link
  const isOrders = type === 'orders';
  const minCells = isOrders ? 3 : 4;
  const dateIdx  = isOrders ? 0 : 1;
  const docketIdx = isOrders ? 1 : 2;
  const nameIdx  = isOrders ? 2 : 3;

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
    if (cells.length < minCells) continue;

    const dateCell   = cells[dateIdx];
    const docketCell = cells[docketIdx];
    const nameCell   = cells[nameIdx];

    const dateMatch   = dateCell.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const docketMatch = docketCell.match(/([\dA-Z\-]+)/);
    // Only match hrefs without page anchors (#page=N) so order statement rows are skipped
    const linkMatch   = nameCell.match(/href=['"]([^'"]+?\.pdf)['"]/i);
    const titleText   = stripHtml(nameCell);

    if (!dateMatch || !docketMatch || !linkMatch || !titleText) continue;

    const pdfPath = linkMatch[1];
    const pdfUrl  = pdfPath.startsWith('http') ? pdfPath : `${SCOTUS_BASE}${pdfPath}`;
    const pathMatch = pdfPath.match(/\/(\d{2})pdf\/([\w\-]+\.pdf)/i);
    const term     = pathMatch ? pathMatch[1] : '';
    const filename = pathMatch ? pathMatch[2] : pdfPath.split('/').pop() || '';

    const key = `${term}/${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      title: titleText,
      date: dateMatch[1],
      docketNumber: docketMatch[1],
      pdfUrl,
      term,
      filename,
    });
  }

  return items;
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') ?? 'opinions';
  const term = url.searchParams.get('term') ?? '';

  if ((type !== 'opinions' && type !== 'orders') || !/^\d{2}$/.test(term) || parseInt(term) < 15) {
    return new Response(JSON.stringify({ error: 'Invalid parameters' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const currentTerm = getCurrentTermCode();
  const isCurrentTerm = term === currentTerm;
  const stalenessMs = isCurrentTerm ? CURRENT_TERM_STALENESS_MS : PAST_TERM_STALENESS_MS;
  const cdnMaxAge   = isCurrentTerm ? 600 : 3600;
  const blobKey = `listing/${type}/${term}.json`;

  interface ListingCache { items: RecentOpinion[]; scrapedAt: string; }

  // Check Netlify Blob cache
  try {
    const store = getStore('recent-opinions');
    const cached = await store.get(blobKey, { type: 'json' }) as ListingCache | null;
    if (cached) {
      const age = Date.now() - new Date(cached.scrapedAt).getTime();
      if (age < stalenessMs) {
        return new Response(JSON.stringify(cached.items), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=0, s-maxage=${cdnMaxAge}` },
        });
      }
    }
  } catch { /* fall through to scrape */ }

  // Fetch from supremecourt.gov
  const listingUrl = type === 'orders'
    ? `${SCOTUS_BASE}/opinions/relatingtoorders/${term}`
    : `${SCOTUS_BASE}/opinions/slipopinion/${term}`;

  let html: string;
  try {
    const resp = await fetch(listingUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (err) {
    console.error(`Listing fetch error (${type}/${term}):`, err);
    return new Response(JSON.stringify({ error: 'Failed to fetch listing' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }

  const items = parseListingRows(html, type as 'opinions' | 'orders');
  const cache: ListingCache = { items, scrapedAt: new Date().toISOString() };

  // Write to Blob (non-blocking)
  try {
    const store = getStore('recent-opinions');
    await store.setJSON(blobKey, cache);
  } catch (err) {
    console.error('Blob write failed:', err);
  }

  return new Response(JSON.stringify(items), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=0, s-maxage=${cdnMaxAge}` },
  });
};
