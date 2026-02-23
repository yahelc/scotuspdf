import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';

export const prerender = false;

const POPULAR_CACHE_KEY = '__popular_3d_v1';
const CACHE_STALE_MS = 10 * 60 * 1000; // 10 minutes

interface PopularCache {
  generatedAt: string;
  windowStart: string;
  totals: Record<string, number>;
}

export const GET: APIRoute = async () => {
  try {
    const store = getStore('hits');
    const threeDayCutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

    // Try serving from precomputed cache
    const cached = await getPopularCache(store);
    if (cached && cached.windowStart === threeDayCutoff) {
      const generatedAt = Date.parse(cached.generatedAt);
      if (Number.isFinite(generatedAt) && Date.now() - generatedAt < CACHE_STALE_MS) {
        return new Response(JSON.stringify(cached.totals), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'max-age=300',
          },
        });
      }
    }

    // Cache miss or stale — rebuild from individual hit blobs
    const popular = await rebuildPopular(store, threeDayCutoff);

    return new Response(JSON.stringify(popular.totals), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=300',
      },
    });
  } catch (err) {
    console.error('Popular fetch error:', err);
    return new Response(JSON.stringify({}), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60',
      },
    });
  }
};

async function getPopularCache(store: ReturnType<typeof getStore>): Promise<PopularCache | null> {
  try {
    const raw = await store.get(POPULAR_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PopularCache;
    if (!parsed || typeof parsed !== 'object' || !parsed.totals) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function rebuildPopular(
  store: ReturnType<typeof getStore>,
  threeDayCutoff: string
): Promise<PopularCache> {
  const { blobs } = await store.list();
  const popular: Record<string, number> = {};

  for (const blob of blobs) {
    if (blob.key.startsWith('__')) continue;
    try {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      const data: Record<string, number> = JSON.parse(raw);
      const total = Object.entries(data)
        .filter(([d]) => d >= threeDayCutoff)
        .reduce((sum, [, n]) => sum + n, 0);
      if (total > 0) popular[blob.key] = total;
    } catch {}
  }

  const cache: PopularCache = {
    generatedAt: new Date().toISOString(),
    windowStart: threeDayCutoff,
    totals: popular,
  };
  await store.set(POPULAR_CACHE_KEY, JSON.stringify(cache));
  return cache;
}
