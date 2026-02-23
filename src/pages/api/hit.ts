import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';

export const prerender = false;

const POPULAR_CACHE_KEY = '__popular_3d_v1';
const CASE_KEY_RE = /^\d{2}\/[A-Za-z0-9_.-]+\.pdf$/;

export const POST: APIRoute = async ({ request }) => {
  try {
    const { caseKey } = await request.json();
    if (!caseKey || typeof caseKey !== 'string' || !CASE_KEY_RE.test(caseKey)) {
      return new Response(JSON.stringify({ error: 'Missing caseKey' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const store = getStore('hits');
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const threeDayCutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

    const data = await atomicUpdateJson<Record<string, number>>(store, caseKey, (existing) => {
      const next = existing || {};
      next[today] = (next[today] || 0) + 1;
      for (const date of Object.keys(next)) {
        if (date < cutoff) delete next[date];
      }
      return next;
    });

    const total = Object.entries(data)
      .filter(([d]) => d >= threeDayCutoff)
      .reduce((sum, [, n]) => sum + n, 0);

    // Incrementally update the popular cache
    updatePopularCache(store, caseKey, total, threeDayCutoff).catch(() => {});

    return new Response(JSON.stringify({ total }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Hit tracking error:', err);
    return new Response(JSON.stringify({ error: 'Failed to track hit' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

interface PopularCache {
  generatedAt: string;
  windowStart: string;
  totals: Record<string, number>;
}

async function updatePopularCache(
  store: ReturnType<typeof getStore>,
  caseKey: string,
  total: number,
  windowStart: string
): Promise<void> {
  await atomicUpdateJson<PopularCache>(store, POPULAR_CACHE_KEY, (existing) => {
    const cache =
      existing && existing.windowStart === windowStart
        ? existing
        : { generatedAt: new Date().toISOString(), windowStart, totals: {} };

    if (total > 0) {
      cache.totals[caseKey] = total;
    } else {
      delete cache.totals[caseKey];
    }
    cache.generatedAt = new Date().toISOString();
    cache.windowStart = windowStart;
    return cache;
  });
}

async function atomicUpdateJson<T>(
  store: ReturnType<typeof getStore>,
  key: string,
  updater: (existing: T | null) => T,
  maxRetries: number = 6
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const existing = await store.getWithMetadata(key, { type: 'text' });
    const existingValue = existing?.data ? (JSON.parse(existing.data) as T) : null;
    const nextValue = updater(existingValue);

    if (existing?.etag) {
      const result = await store.set(key, JSON.stringify(nextValue), { onlyIfMatch: existing.etag });
      if (result.modified) return nextValue;
      continue;
    }

    const created = await store.set(key, JSON.stringify(nextValue), { onlyIfNew: true });
    if (created.modified) return nextValue;
  }

  throw new Error(`Atomic update failed for key: ${key}`);
}
