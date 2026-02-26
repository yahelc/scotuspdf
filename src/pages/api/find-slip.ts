import type { APIRoute } from 'astro';

export const prerender = false;

// Fetch the slip opinion listing for an OT term and find the PDF URL for a docket.
// The supremecourt.gov listing pages (/opinions/slipopinion/{term}) have been
// accessible with full PDF links starting from OT2019 (term code "19").
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const docket = url.searchParams.get('docket');
  const term = url.searchParams.get('term'); // 4-digit year string, e.g. "2021"

  if (!docket || !term) {
    return new Response(JSON.stringify({ error: 'Missing parameters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const termCode = term.slice(-2); // "2021" → "21"
  if (parseInt(termCode) < 19) {
    return new Response(JSON.stringify({ error: 'Term listing not available' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let html: string;
  try {
    const resp = await fetch(
      `https://www.supremecourt.gov/opinions/slipopinion/${termCode}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to fetch listing' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // The page is an HTML table. Each row has: #, date, docket, case-name+PDF-link.
  // Find the row containing this docket number and extract its PDF href.
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[1];
    // Check if this row's docket cell contains our docket number
    if (!row.includes(docket)) continue;

    const pdfMatch = row.match(/href='(\/opinions\/(\d+)pdf\/([\w\-_.]+\.pdf))'/i);
    if (pdfMatch) {
      return new Response(
        JSON.stringify({ term: pdfMatch[2], filename: pdfMatch[3] }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'max-age=86400, s-maxage=86400',
          },
        }
      );
    }
  }

  return new Response(JSON.stringify({ error: 'Case not found in listing' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
};
