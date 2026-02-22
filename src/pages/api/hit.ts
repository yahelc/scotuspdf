import type { APIRoute } from 'astro';
import { getStore } from '@netlify/blobs';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const { caseKey } = await request.json();
    if (!caseKey || typeof caseKey !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing caseKey' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const store = getStore('hits');
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    // Read existing data
    let data: Record<string, number> = {};
    try {
      const existing = await store.get(caseKey);
      if (existing) data = JSON.parse(existing);
    } catch {}

    // Increment today
    data[today] = (data[today] || 0) + 1;

    // Prune old entries
    for (const date of Object.keys(data)) {
      if (date < cutoff) delete data[date];
    }

    await store.set(caseKey, JSON.stringify(data));

    // Compute 3-day rolling total
    const threeDayCutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const total = Object.entries(data)
      .filter(([d]) => d >= threeDayCutoff)
      .reduce((sum, [, n]) => sum + n, 0);

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
