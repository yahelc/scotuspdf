import type { APIRoute } from 'astro';

export const prerender = false;

// Fetch the slip opinion listing for an OT term and find the PDF URL for a docket or case name.
// The supremecourt.gov listing pages (/opinions/slipopinion/{term}) have been
// accessible with full PDF links starting from OT2019 (term code "19").
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const docket = url.searchParams.get('docket');
  const name = url.searchParams.get('name');    // alternative to docket: fuzzy case-name match
  const term = url.searchParams.get('term'); // 4-digit year string, e.g. "2021"

  if ((!docket && !name) || !term) {
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

  // Pre-compute name match parts (split "Merrill v. Milligan" → ["merrill", "milligan"])
  let nameParts: string[] = [];
  if (name) {
    const [p1 = '', p2 = ''] = name.split(/\s+v\.\s+/i);
    nameParts = [p1.trim().toLowerCase(), p2.trim().toLowerCase()].filter(Boolean);
  }

  // The page is an HTML table. Each row has: #, date, docket, case-name+PDF-link.
  const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[1];

    const pdfMatch = row.match(/href='(\/opinions\/(\d+)pdf\/([\w\-_.]+\.pdf))'/i);
    if (!pdfMatch) continue;

    // Match by docket number (exact substring)
    if (docket && row.includes(docket)) {
      return new Response(
        JSON.stringify({ term: pdfMatch[2], filename: pdfMatch[3] }),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400, s-maxage=86400' } }
      );
    }

    // Match by case name: extract text from the PDF anchor tag (the case name link).
    // Do NOT use a generic text-node scan — the first text node in the row is the date.
    if (nameParts.length > 0) {
      const anchorMatch = row.match(/<a\s[^>]*href='[^']*\.pdf'[^>]*>([^<]+)<\/a>/i);
      const linkText = (anchorMatch?.[1] ?? '').toLowerCase();
      // Primary: both party fragments present (handles stable names)
      // Fallback: only p2 matches when p2 is specific (≥7 chars) — handles cases where
      // the petitioner changed between the stay and the merits (e.g. Merrill→Allen)
      const [p1, p2] = nameParts;
      const bothMatch = nameParts.every(p => linkText.includes(p));
      const p2OnlyMatch = p2 && p2.length >= 7 && linkText.includes(p2);
      if (bothMatch || p2OnlyMatch) {
        return new Response(
          JSON.stringify({ term: pdfMatch[2], filename: pdfMatch[3] }),
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400, s-maxage=86400' } }
        );
      }
    }
  }

  return new Response(JSON.stringify({ error: 'Case not found in listing' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
};
