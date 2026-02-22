import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const store = getStore('hits');
    const { blobs } = await store.list();
    const threeDayCutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

    const popular: Record<string, number> = {};

    for (const blob of blobs) {
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

    return new Response(JSON.stringify(popular), {
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
