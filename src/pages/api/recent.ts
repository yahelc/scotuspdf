import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';
import { isConferenceWindow } from '../../lib/scotus-calendar';
import type { RecentOpinion } from '../../lib/types';

export const prerender = false;

const SCOTUS_BASE = 'https://www.supremecourt.gov';
const BLOB_KEY = 'recent/opinions.json';
const CONFERENCE_STALENESS_MS = 30_000; // 30 seconds
const NORMAL_STALENESS_MS = 600_000; // 10 minutes

interface RecentCache {
  opinions: RecentOpinion[];
  scrapedAt: string;
}

const inflight = new Map<string, Promise<RecentCache>>();

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

async function scrapeAndCache(): Promise<RecentCache> {
  const term = getCurrentTerm();
  const resp = await fetch(`${SCOTUS_BASE}/opinions/slipopinion/${term}`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch opinions page: ${resp.status}`);
  }

  const html = await resp.text();
  const opinions = parseOpinionRows(html);
  const cache: RecentCache = { opinions, scrapedAt: new Date().toISOString() };

  // Write to Blob (non-blocking)
  try {
    const store = getStore('recent-opinions');
    await store.setJSON(BLOB_KEY, cache);
  } catch (err) {
    console.error('Blob write failed:', err);
  }

  return cache;
}

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const forceRefresh = url.searchParams.get('refresh') === 'true';
  const conferenceWindow = await isConferenceWindow();
  const stalenessMs = conferenceWindow ? CONFERENCE_STALENESS_MS : NORMAL_STALENESS_MS;
  const cdnMaxAge = conferenceWindow ? 30 : 600;

  // Check Blob cache (unless force refresh)
  if (!forceRefresh) {
    try {
      const store = getStore('recent-opinions');
      const cached = await store.get(BLOB_KEY, { type: 'json' }) as RecentCache | null;
      if (cached) {
        const age = Date.now() - new Date(cached.scrapedAt).getTime();
        if (age < stalenessMs) {
          return new Response(JSON.stringify(cached.opinions), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `max-age=0, s-maxage=${cdnMaxAge}`,
            },
          });
        }
      }
    } catch {
      // Blob read failed — fall through to scrape
    }
  }

  // Singleflight: prevent concurrent scrapes
  let scrapePromise = inflight.get(BLOB_KEY);
  if (!scrapePromise) {
    scrapePromise = scrapeAndCache();
    inflight.set(BLOB_KEY, scrapePromise);
    scrapePromise.finally(() => inflight.delete(BLOB_KEY));
  }

  try {
    const result = await scrapePromise;
    return new Response(JSON.stringify(result.opinions), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=0, s-maxage=${cdnMaxAge}`,
      },
    });
  } catch (err) {
    console.error('Recent opinions fetch error:', err);

    // Try to serve stale data on error
    try {
      const store = getStore('recent-opinions');
      const stale = await store.get(BLOB_KEY, { type: 'json' }) as RecentCache | null;
      if (stale) {
        return new Response(JSON.stringify(stale.opinions), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `max-age=0, s-maxage=60`,
          },
        });
      }
    } catch {
      // Nothing to fall back on
    }

    return new Response(JSON.stringify({ error: 'Failed to fetch recent opinions' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
