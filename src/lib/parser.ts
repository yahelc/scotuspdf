import type { ParsedOpinion, Chapter, Paragraph, Footnote } from './types';

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

interface PageTextContent {
  items: (TextItem | { type: string })[];
}

// Known justices for name normalization
const KNOWN_JUSTICES: Record<string, string> = {
  REHNQUIST: 'Rehnquist', STEVENS: 'Stevens', OCONNOR: "O'Connor",
  SCALIA: 'Scalia', KENNEDY: 'Kennedy', SOUTER: 'Souter',
  THOMAS: 'Thomas', GINSBURG: 'Ginsburg', BREYER: 'Breyer',
  ROBERTS: 'Roberts', ALITO: 'Alito', SOTOMAYOR: 'Sotomayor',
  KAGAN: 'Kagan', GORSUCH: 'Gorsuch', KAVANAUGH: 'Kavanaugh',
  BARRETT: 'Barrett', JACKSON: 'Jackson',
};

interface SectionHeader {
  raw: string;
  normalized: string;
  id: string;
  title: string;
  author: string | null;
}

/**
 * Parse the section header that appears near the top of each page (around y=640-650
 * on a standard 792pt SCOTUS page). This header identifies which section the page belongs to.
 *
 * Examples: "Syllabus", "Opinion of the Court", "T HOMAS , J., concurring",
 * "S OTOMAYOR , J., dissenting", "B ARRETT , J., concurring in part"
 */
/**
 * Extract a justice name from header text that may have a split drop cap.
 * e.g., "R OBERTS" → "ROBERTS", "THOMAS" → "THOMAS", "K AGAN" → "KAGAN"
 */
function extractJusticeName(text: string): string | null {
  // Split drop cap: "R OBERTS" → "ROBERTS"
  const splitMatch = text.match(/^([A-Z])\s+([A-Z]{2,})$/);
  if (splitMatch) {
    const name = splitMatch[1] + splitMatch[2];
    if (KNOWN_JUSTICES[name]) return name;
  }
  // Direct: "THOMAS"
  const directMatch = text.match(/^([A-Z]{2,})$/);
  if (directMatch && KNOWN_JUSTICES[directMatch[1]]) return directMatch[1];
  return null;
}

export function parseSectionHeader(headerText: string): SectionHeader | null {
  const raw = headerText.trim();
  if (!raw) return null;

  if (raw === 'Syllabus') {
    return { raw, normalized: 'Syllabus', id: 'syllabus', title: 'Syllabus', author: null };
  }

  if (raw === 'Opinion of the Court') {
    return { raw, normalized: 'Opinion of the Court', id: 'opinion-majority', title: 'Opinion of the Court', author: null };
  }

  if (/^Per Curiam$/i.test(raw)) {
    return { raw, normalized: 'Per Curiam', id: 'opinion-per-curiam', title: 'Per Curiam', author: null };
  }

  // "Opinion of R OBERTS , C. J." or "Opinion of K AGAN , J."
  // The chief justice's opinion header is equivalent to "Opinion of the Court"
  // Other justices' "Opinion of" headers are separate opinions (concurring/dissenting
  // determined by context, but we label them generically)
  const opinionOfMatch = raw.match(
    /^Opinion of\s+([A-Z](?:\s+[A-Z]+)?)\s*,\s*(?:C\.\s*)?J\.$/
  );
  if (opinionOfMatch) {
    const name = extractJusticeName(opinionOfMatch[1]);
    if (name) {
      const author = KNOWN_JUSTICES[name]!;
      // Chief Justice's opinion = majority
      if (/C\.\s*J\./.test(raw)) {
        return { raw, normalized: 'Opinion of the Court', id: 'opinion-majority', title: 'Opinion of the Court', author };
      }
      // Other justices: separate opinion
      const id = `opinion-${name.toLowerCase()}`;
      const title = `Opinion of ${author}`;
      return { raw, normalized: title, id, title, author };
    }
  }

  // "T HOMAS , J., concurring" or "S OTOMAYOR , J., dissenting"
  const justiceMatch = raw.match(
    /^([A-Z](?:\s+[A-Z]+)?)\s*,\s*(?:C\.\s*)?J\.\s*,\s*(concurring|dissenting)(?:\s+in\s+(?:the\s+)?(?:judgment|part))?/i
  );
  if (justiceMatch) {
    const name = extractJusticeName(justiceMatch[1]);
    if (name) {
      const type = justiceMatch[2].toLowerCase();
      const author = KNOWN_JUSTICES[name]!;
      const id = `${type}-${name.toLowerCase()}`;
      const title = `${author}, ${type}`;
      return { raw, normalized: title, id, title, author };
    }
  }

  // Direct match without split: "THOMAS , J., concurring"
  const directJusticeMatch = raw.match(
    /^([A-Z]{2,})\s*,\s*(?:C\.\s*)?J\.\s*,\s*(concurring|dissenting)(?:\s+in\s+(?:the\s+)?(?:judgment|part))?/i
  );
  if (directJusticeMatch) {
    const fullName = directJusticeMatch[1];
    if (KNOWN_JUSTICES[fullName]) {
      const type = directJusticeMatch[2].toLowerCase();
      const author = KNOWN_JUSTICES[fullName];
      const id = `${type}-${fullName.toLowerCase()}`;
      const title = `${author}, ${type}`;
      return { raw, normalized: title, id, title, author };
    }
  }

  // Title-case single justice (preliminary print running header format):
  // "Gorsuch, J., concurring" / "Roberts, C. J., dissenting"
  // Extra spaces around commas (e.g. "J. , concurring") are tolerated.
  const titleJusticeMatch = raw.match(
    /^([A-Z][a-z]+)\s*,\s*(?:C\.\s*)?J\.\s*,\s*(concurring|dissenting)(?:\s+in\s+(?:the\s+)?(?:judgment|part))?/i
  );
  if (titleJusticeMatch) {
    const upperName = titleJusticeMatch[1].toUpperCase();
    const type = titleJusticeMatch[2].toLowerCase();
    const author = KNOWN_JUSTICES[upperName] ?? titleJusticeMatch[1];
    const id = `${type}-${upperName.toLowerCase()}`;
    const title = `${author}, ${type}`;
    return { raw, normalized: title, id, title, author };
  }

  // Multi-justice title-case (preliminary print): "Breyer, Sotomayor , and Kagan , JJ., dissenting"
  // "JJ." indicates a joined opinion by multiple justices. First name is used as primary author.
  const multiJusticeMatch = raw.match(
    /^([A-Z][a-z]+)[^.]*JJ\.\s*,\s*(concurring|dissenting)(?:\s+in\s+(?:the\s+)?(?:judgment|part))?/i
  );
  if (multiJusticeMatch) {
    const upperName = multiJusticeMatch[1].toUpperCase();
    const type = multiJusticeMatch[2].toLowerCase();
    const author = KNOWN_JUSTICES[upperName] ?? multiJusticeMatch[1];
    const id = `${type}-${upperName.toLowerCase()}`;
    const title = `${author}, ${type}`;
    return { raw, normalized: title, id, title, author };
  }

  return null;
}

/**
 * Fix small-cap rendering artifacts in text.
 *
 * SCOTUS PDFs render justice names in small caps. pdf.js extracts these as
 * separate text items where the first letter is at body font size and the
 * remaining letters are at a smaller size. During text assembly this creates
 * artifacts like:
 *   "J USTICE", "HIEF", "OBERTS", "HOMAS", "ORSUCH", etc.
 *
 * We fix these by:
 * 1. Collapsing known split patterns (e.g., "J USTICE" → "JUSTICE")
 * 2. Fixing split justice names (e.g., "B ARRETT" → "BARRETT")
 * 3. Handling "CHIEF" splits (e.g., "C HIEF" → "CHIEF")
 */
export function fixSmallCaps(text: string): string {
  let result = text;

  // Fix "J USTICE" → "JUSTICE" and "C HIEF" → "CHIEF"
  result = result.replace(/J\s+USTICE/g, 'JUSTICE');
  result = result.replace(/C\s+HIEF/g, 'CHIEF');

  // Fix split justice names: "R OBERTS" → "ROBERTS", "T HOMAS" → "THOMAS", etc.
  for (const name of Object.keys(KNOWN_JUSTICES)) {
    const first = name[0];
    const rest = name.slice(1);
    const regex = new RegExp(`${first}\\s+${rest}\\b`, 'g');
    result = result.replace(regex, name);
  }

  // Fix orphaned fragments where the first letter was absorbed into preceding text.
  // e.g., "...text USTICE GORSUCH" → "...text JUSTICE GORSUCH"
  // or "...text ORSUCH" → "...text GORSUCH"
  // We match the fragment at a word boundary preceded by a space.
  result = result.replace(/\bUSTICE\b/g, 'JUSTICE');
  result = result.replace(/\bHIEF\b/g, 'CHIEF');
  for (const name of Object.keys(KNOWN_JUSTICES)) {
    const rest = name.slice(1);
    // Only fix if the fragment is at least 4 chars (avoid false positives)
    if (rest.length >= 4) {
      // Replace orphaned fragment with full name, but only when followed by
      // a pattern that suggests it's a name (comma, space+lowercase, etc.)
      const regex = new RegExp(`\\b${rest}\\b(?=\\s*[,.'\\s])`, 'g');
      result = result.replace(regex, name);
    }
  }

  return result;
}

/**
 * Rejoin words that were hyphenated across line breaks in the PDF.
 *
 * SCOTUS PDFs break words at line ends with hyphens. After text extraction
 * these appear as "Eco - nomic" or "con- stitution" (the space comes from
 * joining separate text lines).
 *
 * We only rejoin when the fragment after the hyphen starts with a lowercase
 * letter, which avoids false positives on real hyphens in compound words
 * like "well-known" or "revenue-raising" (where the second part is also
 * a full word starting lowercase — but those words don't have spaces
 * around the hyphen in the PDF text).
 */
export function dehyphenate(text: string): string {
  // Fix footnote-interrupted hyphenations with {{fn:N}} markers:
  // "find - {{fn:2}} ings" → "findings{{fn:2}}" (rejoin word, move marker to end)
  let result = text.replace(/(\w+)\s*-\s+(\{\{fn:\d+\}\})\s+([a-z]\w*)/g, (_, before, marker, after) => {
    return before + after + marker;
  });

  // Fix footnote-interrupted hyphenations without markers (legacy):
  // "con - 1 solidated" → "consolidated" (footnote number embedded mid-word)
  result = result.replace(/(\w)\s*-\s+\d+\s+([a-z])/g, '$1$2');

  // Then fix standard line-break hyphenations:
  // "Eco - nomic" or "con- stitution" → "Economic" or "constitution"
  result = result.replace(/(\w)\s*-\s+([a-z])/g, '$1$2');

  return result;
}

/**
 * Detect US Reports citations and ante/post cross-references in text,
 * wrapping them with inline markers for the frontend to render as links.
 *
 * With case name: `Trump v. United States, 603 U. S. 593`
 *   → `{{cite:603:593:593:Trump v. United States:Trump v. United States, 603 U. S. 593}}`
 * Bare citation:  `553 U. S. 285, 294`
 *   → `{{cite:553:285:294::553 U. S. 285, 294}}`
 * Ante/post:      `ante, at 14` → `{{ref:ante:14}}`
 *
 * Only links volumes ≥ 502 (roughly when supremecourt.gov coverage starts).
 * Marker format: cite:volume:page:pinpoint:caseName:display  (caseName may be empty)
 *
 * ctx: mutable object shared across paragraph calls so that bare `§1701(a)` refs
 * can inherit the title number from a preceding `50 U. S. C. §1701(a)` citation.
 */

export interface CitationContext {
  lastUscTitle: string | null;
}

/** Apply fn only to the non-marker segments of text, leaving {{...}} markers untouched. */
function applyToNonMarkers(text: string, fn: (s: string) => string): string {
  const parts = text.split(/(\{\{.*?\}\})/);
  return parts.map((part, i) => (i % 2 === 0 ? fn(part) : part)).join('');
}

/**
 * Build one or more {{usc:...}} markers for a single- or multi-section citation.
 * Each section in a comma-separated list (e.g. "§§1701(a), 1702(a)(1)(B)") becomes
 * its own marker, with a plain-text ", " between them so parseSegments renders them
 * as two independent clickable links.
 */
function expandUscSections(
  title: string,
  section: string,
  subsRaw: string | undefined,
  continuations: string | undefined,
  firstDisplay: string
): string {
  const sub1 = subsRaw ? subsRaw.replace(/\s+/g, '') : '';
  let result = `{{usc:${title}:${section}:${sub1}:${firstDisplay}}}`;

  if (continuations) {
    const contRe = /,\s*(?:and\s+)?(\d+[a-z]?)((?:\s*\([^)\s]{1,8}\))*)/g;
    let m;
    while ((m = contRe.exec(continuations)) !== null) {
      const sec = m[1];
      const subs = m[2] ? m[2].replace(/\s+/g, '') : '';
      const display = `${sec}${m[2] ?? ''}`;
      result += `, {{usc:${title}:${sec}:${subs}:${display}}}`;
    }
  }

  return result;
}

export function markCitations(text: string, ctx: CitationContext = { lastUscTitle: null }): string {
  // Single pass: optionally match a "Party v. Party, " prefix before the citation.
  // Using one pass prevents Step 2 from re-processing the display text inside markers
  // already written by Step 1 (which would produce nested/broken markers).
  // Group 1 = firstParty, Group 2 = secondParty (both undefined for bare citations)
  // Group 3 = volume, Group 4 = page, Group 5 = optional pinpoint, Group 6 = optional year
  let result = text.replace(
    /(?:([A-Z][\w']+(?:\s+(?:of\s+|the\s+|de\s+)?[A-Z][\w']+){0,4})\s+v\.\s+([A-Z][\w']+(?:\s+(?:of\s+|the\s+)?[A-Z]?[\w']+){0,3}),\s*)?(\d{1,3})\s+U\.\s*S\.\s+(\d{1,4})(?:\s*,\s*(?:at\s+)?(\d{1,4}))?(?:\s*\((\d{4})\))?/g,
    (match, firstParty, secondParty, volume, page, pinpoint, _year) => {
      const vol = parseInt(volume);
      if (vol < 1) return match;
      const pin = pinpoint || page;
      const caseName = firstParty && secondParty
        ? `${firstParty.trim()} v. ${secondParty.trim()}`
        : '';
      return `{{cite:${volume}:${page}:${pin}:${caseName}:${match}}}`;
    }
  );

  // Ante/post cross-references: "ante, at 14" / "post, at 48"
  result = result.replace(
    /\b(ante|post)\s*,\s*at\s+(\d{1,4})/gi,
    (match, direction, page) => `{{ref:${direction.toLowerCase()}:${page}}}`
  );

  // USC citations: "28 U. S. C. § 2254(d)" or "28 U.S.C. §§ 1254, 2241(a)"
  // Captures optional comma-separated continuation sections so each becomes its own marker.
  // Updates ctx.lastUscTitle so subsequent bare §-refs can inherit the title number.
  result = result.replace(
    /(\d+)\s+U\.\s*S\.\s*C\.\s*§§?\s*(\d+[a-z]?)((?:\s*\([^)\s]{1,8}\))+)?((?:,\s*(?:and\s+)?\d+[a-z]?(?:\s*\([^)\s]{1,8}\))*)+)?(?=[\s,;.")]|$)/g,
    (match, title, section, subs, continuations) => {
      ctx.lastUscTitle = title;
      const firstDisplay = continuations
        ? match.slice(0, match.length - continuations.length)
        : match;
      return expandUscSections(title, section, subs, continuations, firstDisplay);
    }
  );

  // Bare section refs: "§§1701(a), 1702(a)(1)(B)" or "§ 1702(a)"
  // Only fires when a USC title has already been established in this chapter.
  // Each comma-separated section becomes its own marker.
  if (ctx.lastUscTitle) {
    const lastTitle = ctx.lastUscTitle;
    result = applyToNonMarkers(result, (segment) =>
      segment.replace(
        /§§?\s*(\d+[a-z]?)((?:\s*\([^)\s]{1,8}\))+)?((?:,\s*(?:and\s+)?\d+[a-z]?(?:\s*\([^)\s]{1,8}\))*)+)?(?=[\s,;.")]|$)/g,
        (match, section, subs, continuations) => {
          const firstDisplay = continuations
            ? match.slice(0, match.length - continuations.length)
            : match;
          return expandUscSections(lastTitle, section, subs, continuations, firstDisplay);
        }
      )
    );
  }

  // Federal Register citations: "90 Fed. Reg. 15625, 15626 (2025)"
  // Each page number becomes its own {{fr:...}} marker; the year stays as plain text after.
  result = result.replace(
    /(\d+)\s+Fed\.\s*Reg\.\s*(\d+)((?:,\s*\d+)+)?(?:\s*\((\d{4})\))?(?=[\s,;."\u2019]|$)/g,
    (match, volume, firstPage, continuations, year) => {
      // Fall back to computing year from FR volume (vol 1 = 1936, so year = 1935 + vol)
      const yr = year || String(1935 + parseInt(volume));
      const firstDisplay = `${volume} Fed. Reg. ${firstPage}`;
      let out = `{{fr:${volume}:${firstPage}:${yr}:${firstDisplay}}}`;
      if (continuations) {
        const pageRe = /,\s*(\d+)/g;
        let m;
        while ((m = pageRe.exec(continuations)) !== null) {
          out += `, {{fr:${volume}:${m[1]}:${yr}:${m[1]}}}`;
        }
      }
      if (year) out += ` (${year})`;
      return out;
    }
  );

  return result;
}

export function buildParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const rawParagraphs = text.split(/\n{2,}/);
  // Shared context so bare §-refs can inherit the last USC title seen in this chapter
  const citationCtx: CitationContext = { lastUscTitle: null };

  for (const raw of rawParagraphs) {
    let trimmed = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;

    // Preserve section heading markers as their own paragraphs
    if (/^\{\{h[1-3]:.+\}\}$/.test(trimmed)) {
      paragraphs.push({ text: trimmed, footnotes: [] });
      continue;
    }

    if (trimmed.length < 3) continue;

    // Rejoin line-break hyphenations
    trimmed = dehyphenate(trimmed);

    // Skip repeated headers
    if (/^\d+\s+[A-Z\s]+v\.\s+[A-Z\s]+$/.test(trimmed)) continue;
    if (/^Cite as:/.test(trimmed)) continue;
    if (/^SUPREME COURT OF THE UNITED STATES$/.test(trimmed)) continue;

    // Fix small-cap rendering artifacts
    trimmed = fixSmallCaps(trimmed);

    // Remove spaces before closing punctuation — artifact of PDF font-boundary splits
    // where e.g. an italic word and its following Roman comma are separate pdfjs items.
    // In standard typography these characters are never preceded by a space.
    trimmed = trimmed.replace(/ ([.,;:!?)\]»\u201d\u2019])/g, '$1');

    // Mark US Reports citations and ante/post cross-references
    trimmed = markCitations(trimmed, citationCtx);

    // Merge with previous paragraph if this is a continuation:
    // previous paragraph doesn't end with sentence-ending punctuation,
    // and this one starts with a lowercase letter.
    // Never merge into a heading marker.
    const prevText = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1].text : '';
    const prevIsHeading = /^\{\{h[1-3]:/.test(prevText);
    if (
      paragraphs.length > 0 &&
      !prevIsHeading &&
      trimmed.length > 0 &&
      /^[a-z]/.test(trimmed) &&
      !/[.!?;:'")\u201d]\s*$/.test(prevText)
    ) {
      // Re-run dehyphenate on the junction in case a hyphenated word was split
      // across the paragraph boundary (e.g., "Am -" + "bassadors")
      paragraphs[paragraphs.length - 1].text = dehyphenate(
        paragraphs[paragraphs.length - 1].text + ' ' + trimmed
      );
    } else {
      paragraphs.push({ text: trimmed, footnotes: [] });
    }
  }

  return paragraphs;
}

/**
 * Split a merged SCOTUS header blob into meaningful segments.
 * Input like: "SUPREME COURT OF THE UNITED STATES Syllabus BOST ET AL . v . ILLINOIS ...
 *   CERTIORARI TO ... No. 24–568. Argued October 8, 2025—Decided January 14, 2026"
 * Returns: ["SUPREME COURT OF THE UNITED STATES", "BOST ET AL. v. ILLINOIS ...",
 *   "CERTIORARI TO ...", "No. 24–568. Argued ... — Decided ..."]
 * Any trailing body text after the date is returned separately as bodyRest.
 */
export function splitSCOTUSHeader(text: string): { bpParts: string[]; bodyRest: string } {
  // First, split off trailing body text after "Decided <date>"
  let headerText = text;
  let bodyRest = '';
  const decidedMatch = text.match(/Decided\s+\w+\s+\d+,\s+\d{4}\s*/);
  if (decidedMatch && decidedMatch.index !== undefined) {
    const cutIdx = decidedMatch.index + decidedMatch[0].length;
    headerText = text.slice(0, cutIdx).trim();
    bodyRest = text.slice(cutIdx).trim();
  }

  let remaining = headerText;
  const segments: string[] = [];

  // Extract SUPREME COURT header first
  const scotusEnd = remaining.indexOf('SUPREME COURT OF THE UNITED STATES') + 'SUPREME COURT OF THE UNITED STATES'.length;
  if (scotusEnd > 0) {
    segments.push(remaining.slice(0, scotusEnd).trim());
    remaining = remaining.slice(scotusEnd).trim();
  }

  // Remove "Syllabus" label if present (it's redundant with chapter title)
  remaining = remaining.replace(/^Syllabus\s*/, '');

  // Split at "CERTIORARI" or "ON WRIT"
  const certMatch = remaining.match(/\s+(CERTIORARI\b|ON WRIT OF\b)/);
  if (certMatch && certMatch.index !== undefined) {
    const before = remaining.slice(0, certMatch.index).trim();
    const after = remaining.slice(certMatch.index).trim();
    if (before) segments.push(before);
    remaining = after;
  }

  // Split at "No." / "Nos."
  const noMatch = remaining.match(/\s+(No(?:s)?\.\s+\d)/);
  if (noMatch && noMatch.index !== undefined) {
    const before = remaining.slice(0, noMatch.index).trim();
    const after = remaining.slice(noMatch.index).trim();
    if (before) segments.push(before);
    if (after) segments.push(after);
  } else if (remaining) {
    segments.push(remaining);
  }

  return { bpParts: segments, bodyRest: bodyRest };
}

/**
 * Tag leading boilerplate paragraphs in a chapter with {{bp:...}} markers.
 * Boilerplate includes the SCOTUS header, case caption, cert details, and
 * the justice delivery/joinder line. Stops at the first non-matching paragraph.
 */
export function tagBoilerplate(paragraphs: Paragraph[]): Paragraph[] {
  // Two-pass approach:
  // 1. Find the JUSTICE delivery line (the definitive end of boilerplate)
  // 2. Tag everything before it as boilerplate

  // First, handle NOTE/NOTICE/SUPREME COURT special cases that need splitting
  for (let i = 0; i < Math.min(paragraphs.length, 3); i++) {
    const text = paragraphs[i].text;
    if (/^\{\{/.test(text)) continue;

    if (/^NOTE: Where it is feasible/.test(text)) {
      // Don't require the period in the search: markCitations may have wrapped
      // "200 U. S. 321, 337" in a {{cite:...}} marker, making it "321, 337}}."
      // The period is found separately by indexOf below.
      const cutoff = text.search(/\b321,\s*337/);
      if (cutoff > 0) {
        const endIdx = text.indexOf('.', cutoff + 4) + 1;
        const note = text.slice(0, endIdx).trim();
        const rest = text.slice(endIdx).trim();
        paragraphs[i].text = `{{bp:${note}}}`;
        if (rest) {
          paragraphs.splice(i + 1, 0, { text: rest, footnotes: [] });
        }
      } else {
        paragraphs[i].text = `{{bp:${text}}}`;
      }
    } else if (/^NOTICE: This opinion/.test(text)) {
      paragraphs[i].text = `{{bp:${text}}}`;
    } else if (/^SUPREME COURT OF THE UNITED STATES/.test(text)) {
      const { bpParts, bodyRest } = splitSCOTUSHeader(text);
      const newParas: Paragraph[] = bpParts.map(p => ({ text: `{{bp:${p}}}`, footnotes: [] as Footnote[] }));
      if (bodyRest) {
        newParas.push({ text: bodyRest, footnotes: [] as Footnote[] });
      }
      paragraphs.splice(i, 1, ...newParas);
      i += bpParts.length - 1;
    }
  }

  // Find the JUSTICE delivery line — the definitive end of boilerplate.
  // Scan a limited range (boilerplate is at most ~10 paragraphs).
  let justiceIdx = -1;
  const scanLimit = Math.min(paragraphs.length, 15);
  for (let i = 0; i < scanLimit; i++) {
    const text = paragraphs[i].text;
    if (/^\{\{/.test(text)) continue; // skip already-tagged or headings

    // "JUSTICE X delivered..." or "CHIEF JUSTICE X delivered..." or "THE CHIEF JUSTICE delivered..."
    if (/^(THE )?(CHIEF )?JUSTICE\b/.test(text) && /delivered|announced|concurring|dissenting/.test(text)) {
      justiceIdx = i;
      break;
    }
    // Multi-line joinder: "join, concurring" / "join, dissenting"
    if (/\bjoin\b/i.test(text) && /concurring|dissenting/.test(text)) {
      justiceIdx = i;
      break;
    }
    // "Per Curiam." as a standalone paragraph (acts like a delivery line)
    if (/^Per Curiam\b/i.test(text)) {
      justiceIdx = i;
      break;
    }
  }

  if (justiceIdx >= 0) {
    // Tag everything before the JUSTICE line as boilerplate.
    // Skip paragraphs that are too long — they've been merged with body text.
    for (let i = 0; i < paragraphs.length && i <= justiceIdx; i++) {
      const text = paragraphs[i].text;
      if (/^\{\{/.test(text)) continue; // already tagged or heading

      if (i === justiceIdx) {
        paragraphs[i].text = `{{bpj:${text}}}`;
      } else if (text.length < 500) {
        paragraphs[i].text = `{{bp:${text}}}`;
      } else {
        // Long merged paragraph — try to split at "Decided DATE" boundary
        const decidedMatch = text.match(/Decided\s+\w+\s+\d{1,2},\s+\d{4}\s*/);
        if (decidedMatch) {
          const splitIdx = decidedMatch.index! + decidedMatch[0].length;
          const bpPart = text.slice(0, splitIdx).trim();
          const bodyPart = text.slice(splitIdx).trim();
          paragraphs[i].text = `{{bp:${bpPart}}}`;
          if (bodyPart) {
            paragraphs.splice(i + 1, 0, { text: bodyPart, footnotes: [] as Footnote[] });
            justiceIdx++; // adjust for inserted paragraph
          }
        }
      }
    }
  } else {
    // No JUSTICE delivery line found (e.g., Syllabus).
    // Tag leading paragraphs that match boilerplate patterns.
    // buildParagraphs often merges caption continuation + CERTIORARI + docket/date
    // + body text into one long paragraph. We detect that and split at the
    // "Decided DATE" boundary so the boilerplate portion gets tagged.
    for (let i = 0; i < scanLimit; i++) {
      const text = paragraphs[i].text;
      if (/^\{\{/.test(text)) continue; // already tagged or heading

      // Case caption: short line ending with "v." or containing "v." before
      // a comma/newline (not mid-sentence citations like "Inc. v. Espinosa")
      const isCaseCaption = text.length < 250 && (
        /\bv\.\s*$/.test(text) ||              // ends with "v."
        /^[A-Z][A-Z\s.,]+\bv\s*\.\s/.test(text) // ALL-CAPS start with "v."
      );
      // Cert/writ/petitioner line — only if short (long = merged with body text)
      const isCertLine = text.length < 350 && (
        /CERTIORARI\b/.test(text) || /PETITIONER/.test(text) || /ON WRIT OF/.test(text)
      );
      // Docket/date line — only if short
      const isDocketDate = text.length < 350 && (
        /^No(?:s)?\.\s+\d{2}[–\-]\d+/.test(text) || /Argued\s+\w+\s+\d/.test(text)
      );

      if (isCaseCaption || isCertLine || isDocketDate) {
        paragraphs[i].text = `{{bp:${text}}}`;
        // Stop after docket/date or cert line — body text follows
        if (isDocketDate || isCertLine) break;
        continue;
      }

      // Check for a long merged paragraph containing "Decided DATE" — split it
      const decidedMatch = text.match(/Decided\s+\w+\s+\d{1,2},\s+\d{4}\s*/);
      if (decidedMatch) {
        const splitIdx = decidedMatch.index! + decidedMatch[0].length;
        const bpPart = text.slice(0, splitIdx).trim();
        const bodyPart = text.slice(splitIdx).trim();
        paragraphs[i].text = `{{bp:${bpPart}}}`;
        if (bodyPart) {
          paragraphs.splice(i + 1, 0, { text: bodyPart, footnotes: [] as Footnote[] });
        }
        break;
      }

      // Stop at first non-matching paragraph
      break;
    }
  }

  return paragraphs;
}

interface ParseOptions {
  maxPages?: number;
}

export async function parsePdf(pdfData: ArrayBuffer, sourceUrl: string, options: ParseOptions = {}): Promise<ParsedOpinion> {
  // Pre-load the worker on the main thread so pdfjs doesn't try to spawn a Web Worker
  // (which isn't available in serverless environments)
  if (!(globalThis as any).pdfjsWorker) {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as any).pdfjsWorker = worker;
  }

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfData),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const numPages = doc.numPages;
  const pagesToProcess = Math.min(numPages, options.maxPages ?? numPages);

  // Detect preliminary print format by scanning page 1 for the
  // "Page Proof Pending Publication" watermark (unique to this format).
  // Preliminary prints have a two-row top header: running page header at y≈83-84%
  // and section label at y≈80-81%. Slip opinions have only the section label.
  let isPrelimPrint = false;
  {
    const p1 = await doc.getPage(1);
    const p1content: PageTextContent = await p1.getTextContent();
    for (const item of p1content.items) {
      if ('str' in item && /Page Proof/.test((item as any).str)) {
        isPrelimPrint = true;
        break;
      }
    }
  }

  // First pass: determine the section header Y position by analyzing page 1
  // The header line (Syllabus, Opinion of the Court, etc.) appears at a consistent Y
  // on SCOTUS PDFs — typically around y=640-650 on a 792pt page
  let headerYMin = 635;
  let headerYMax = 655;

  // Process all pages, extracting section headers and body text
  interface PageResult {
    sectionHeader: SectionHeader | null;
    bodyLines: string[];
    footnotes: Map<number, string>;
    footnoteContinuation: string;
  }

  const pages: PageResult[] = [];

  for (let i = 1; i <= pagesToProcess; i++) {
    // Preliminary prints: page 1 is a cover page (no opinion content).
    if (isPrelimPrint && i === 1) {
      pages.push({ sectionHeader: null, bodyLines: [], footnotes: new Map(), footnoteContinuation: '' });
      continue;
    }

    const page = await doc.getPage(i);
    const textContent: PageTextContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;

    // Header band: section labels appear at ~80-84% from bottom.
    // Preliminary prints: section label at ~80.3-80.8%, running header at ~83-84%.
    //   Use 0.79 floor to catch dissent labels that drop to ~80.3%.
    // Slip opinions: section label at ~81.8-82.3%; keep 0.80 floor so body text
    //   lines just below the header zone don't bleed into the band.
    const hYMin = isPrelimPrint ? pageHeight * 0.79 : pageHeight * 0.80;
    const hYMax = pageHeight * 0.84;

    const allItems: { y: number; x: number; text: string; fontSize: number }[] = [];
    for (const item of textContent.items) {
      if ('str' in item && item.str.trim()) {
        allItems.push({
          y: item.transform[5],
          x: item.transform[4],
          text: item.str,
          fontSize: Math.abs(item.transform[0]),
        });
      }
    }

    // Extract section header from the lowest y-position row in the header band.
    //
    // Preliminary prints have TWO rows in this band:
    //   y≈83-84%: running page header ("OCTOBER TERM, 2021" / case name alternating)
    //   y≈80-81%: section label ("Syllabus", "Per Curiam", "Gorsuch, J., concurring")
    // Slip opinions have only ONE row (the section label at ~81-82%).
    //
    // By selecting only the lowest y row we always get the section label and
    // ignore the alternating recto/verso running header above it.
    const headerItems = allItems.filter((it) => it.y >= hYMin && it.y <= hYMax);
    let sectionHeader: SectionHeader | null = null;
    if (headerItems.length > 0) {
      const snapY = (y: number) => Math.round(y / 2) * 2;
      const minY = Math.min(...headerItems.map((it) => snapY(it.y)));
      const lowestRowItems = headerItems.filter((it) => snapY(it.y) <= minY + 4);
      lowestRowItems.sort((a, b) => a.x - b.x);
      const headerText = lowestRowItems.map((it) => it.text.trim()).join(' ');
      sectionHeader = parseSectionHeader(headerText);
    }

    // Body text: everything below the header band and above the footer
    const bodyItems = allItems.filter((it) => {
      const y = it.y;
      // Skip items in header area (y > hYMin) and footer area (y < 60)
      if (y >= hYMin) return false;
      if (y < 60) return false;
      // Skip "Cite as:" lines and lone page numbers in the top header row
      if (y > pageHeight - 60) {
        const t = it.text.trim();
        if (/^Cite as:/.test(t)) return false;
        if (/^\d+$/.test(t)) return false;
        if (/^\(Slip Opinion\)/.test(t)) return false;
      }
      // Preliminary print watermark ("Page Proof Pending Publication") appears
      // mid-page at large font size — exclude it from body text on all pages.
      if (/Page Proof/.test(it.text)) return false;
      return true;
    });
    // Sort by y descending then x ascending. Use coarse rounding (nearest 2px)
    // to avoid sub-pixel jitter splitting items on the same visual line into
    // different sort groups (e.g., small-caps "HOMAS" at y=307.500 vs body text
    // at y=307.499 — Math.round gives 308 vs 307, breaking line ordering).
    const snapY = (y: number) => Math.round(y / 2) * 2;
    bodyItems.sort((a, b) => {
      const dy = snapY(b.y) - snapY(a.y);
      return dy !== 0 ? dy : a.x - b.x;
    });

    // Determine dominant body font size from all body items (needed for superscript detection).
    // Use the largest font size with significant frequency (≥5 items), not the most frequent,
    // because on footnote-heavy pages the smaller footnote font can outnumber body text.
    const itemFSFreq = new Map<number, number>();
    for (const item of bodyItems) {
      const fs = Math.round(item.fontSize);
      itemFSFreq.set(fs, (itemFSFreq.get(fs) || 0) + 1);
    }
    let bodyFS = 0;
    for (const [fs, freq] of itemFSFreq) {
      if (freq >= 5 && fs > bodyFS) { bodyFS = fs; }
    }
    // Fallback: if no font has ≥5 items, use the most frequent
    if (bodyFS === 0) {
      let maxFreq = 0;
      for (const [fs, freq] of itemFSFreq) {
        if (freq > maxFreq) { maxFreq = freq; bodyFS = fs; }
      }
    }

    // Find the y-position of the footnote separator line (——————) to avoid
    // marking footnote-section numbers as superscript references.
    // The separator is a line of em-dashes at a smaller font than body text.
    let separatorY = -1;
    for (const item of bodyItems) {
      if (/^——+$/.test(item.text.trim()) && bodyFS > 0 && item.fontSize < bodyFS - 1) {
        // In PDF coordinates, y increases upward, and bodyItems are sorted descending by y,
        // so the separator (lower on page) has a smaller y value.
        separatorY = item.y;
        break;
      }
    }

    // Pre-process: snap floating superscript footnote refs to their nearest body
    // text line. Superscripts float between lines (y between two baselines) and
    // would otherwise be treated as separate lines, causing {{fn:N}} markers to
    // appear at the wrong position in the text.
    for (let idx = 0; idx < bodyItems.length; idx++) {
      const item = bodyItems[idx];
      const trimmedText = item.text.trim();
      const isAboveSep = separatorY < 0 || item.y > separatorY + 2;
      const isSuperRef = (
        isAboveSep &&
        /^\d{1,2}$/.test(trimmedText) &&
        bodyFS > 0 &&
        item.fontSize < bodyFS - 2.5
      );
      if (!isSuperRef) continue;

      // Check if already on the same rounded y as a nearby body text item
      let onBodyLine = false;
      for (let j = Math.max(0, idx - 10); j < Math.min(bodyItems.length, idx + 10); j++) {
        if (j === idx) continue;
        const other = bodyItems[j];
        if (/^\d{1,2}$/.test(other.text.trim()) && other.fontSize < bodyFS - 2.5) continue;
        if (Math.abs(Math.round(other.y) - Math.round(item.y)) <= 2) {
          onBodyLine = true;
          break;
        }
      }
      if (onBodyLine) continue;

      // Find nearest body text item by y and snap to it
      let nearestY = item.y;
      let minDist = Infinity;
      for (let j = Math.max(0, idx - 10); j < Math.min(bodyItems.length, idx + 10); j++) {
        if (j === idx) continue;
        const other = bodyItems[j];
        if (/^\d{1,2}$/.test(other.text.trim()) && other.fontSize < bodyFS - 2.5) continue;
        const dist = Math.abs(other.y - item.y);
        if (dist < minDist) {
          minDist = dist;
          nearestY = other.y;
        }
      }
      bodyItems[idx] = { ...item, y: nearestY };
    }

    // Re-sort after snapping superscript y positions
    bodyItems.sort((a, b) => {
      const dy = snapY(b.y) - snapY(a.y);
      return dy !== 0 ? dy : a.x - b.x;
    });

    // Group into text lines, handling small-cap name rendering.
    // SCOTUS PDFs render names in small caps: the first letter is at body font size
    // and remaining letters are ALL-CAPS at a smaller size (e.g., "J" at 11pt + "USTICE" at 9pt).
    // pdf.js returns these as separate items, so we need to join them without a space.
    // Track x-position of first item on each line to detect paragraph indentation.
    // Superscript footnote reference numbers (1-2 digits at much smaller font) in the body
    // area (above separator) are wrapped with {{fn:N}} markers for the frontend.
    const textLines: { text: string; avgFontSize: number; startX: number }[] = [];
    let curText = '';
    let curStartX = 0;
    let lastY = -1;
    let lastFontSize = 0;
    let fsSum = 0;
    let fsCount = 0;

    for (const item of bodyItems) {
      const trimmedItem = item.text.trim();

      // Detect superscript footnote reference numbers in body text (above separator only).
      // These are 1-2 digit numbers at a significantly smaller font than body text.
      const isAboveSeparator = separatorY < 0 || item.y > separatorY + 2;
      const isSuperscriptRef = (
        isAboveSeparator &&
        /^\d{1,2}$/.test(trimmedItem) &&
        bodyFS > 0 &&
        item.fontSize < bodyFS - 2.5
      );

      if (lastY >= 0 && Math.abs(item.y - lastY) > 2) {
        // New line
        if (curText.trim()) textLines.push({ text: curText.trim(), avgFontSize: fsCount > 0 ? fsSum / fsCount : 0, startX: curStartX });
        if (isSuperscriptRef) {
          curText = `{{fn:${trimmedItem}}}`;
        } else {
          curText = item.text;
        }
        curStartX = item.x;
        fsSum = item.fontSize;
        fsCount = 1;
      } else {
        // Same line — check if this is a small-cap continuation
        const isSmallCap = (
          trimmedItem.length > 0 &&
          /^[A-Z]+$/.test(trimmedItem) &&
          item.fontSize < lastFontSize - 0.5 &&
          curText.length > 0 &&
          /[A-Z]$/.test(curText)
        );

        if (isSuperscriptRef) {
          // Footnote reference — append marker without space before it
          curText += `{{fn:${trimmedItem}}}`;
        } else if (isSmallCap) {
          // Join without space — small-cap continuation
          curText += trimmedItem;
        } else if (trimmedItem && /^[.,;:!?)\]»\u201d\u2019]/.test(trimmedItem)) {
          // Closing punctuation that immediately follows the previous word in the PDF
          // (e.g., a Roman comma after an italic word are separate pdfjs items but
          // should have no space between them). Always attach without space.
          curText += trimmedItem;
        } else {
          if (!curText) curStartX = item.x;
          curText += (curText && !curText.endsWith(' ') ? ' ' : '') + item.text;
        }
        fsSum += item.fontSize;
        fsCount++;
      }
      lastY = item.y;
      lastFontSize = item.fontSize;
    }
    if (curText.trim()) textLines.push({ text: curText.trim(), avgFontSize: fsCount > 0 ? fsSum / fsCount : 0, startX: curStartX });

    // Find the dominant left margin for body text lines (most common startX)
    const bodyFontLines = textLines.filter(
      (l) => l.avgFontSize > 0 && bodyFS > 0 && l.avgFontSize >= bodyFS - 1
    );
    const xFreq = new Map<number, number>();
    for (const line of bodyFontLines) {
      const rx = Math.round(line.startX);
      xFreq.set(rx, (xFreq.get(rx) || 0) + 1);
    }
    let bodyLeftMargin = 0;
    let maxXFreq = 0;
    for (const [x, freq] of xFreq) {
      if (freq > maxXFreq) { maxXFreq = freq; bodyLeftMargin = x; }
    }

    // Debug footnote detection
    // Split text lines into body and footnotes.
    // SCOTUS footnotes appear after a "——————" separator line, in smaller font.
    // The footnote number appears on its own line (fs ~6pt), followed by
    // the footnote text on subsequent lines (fs ~9pt, body is ~11pt).
    const bodyLines: string[] = [];
    const footnotes = new Map<number, string>();

    // Find the separator line index
    let separatorIdx = -1;
    for (let li = 0; li < textLines.length; li++) {
      if (/^——+$/.test(textLines[li].text.trim())) {
        // Verify it's in the smaller font region (not body text)
        const isSmall = textLines[li].avgFontSize > 0 && bodyFS > 0 && textLines[li].avgFontSize < bodyFS - 1;
        if (isSmall) {
          separatorIdx = li;
          break;
        }
      }
    }

    // Process body lines (everything before the separator)
    const bodyEnd = separatorIdx >= 0 ? separatorIdx : textLines.length;
    for (let li = 0; li < bodyEnd; li++) {
      const line = textLines[li];
      const trimmed = line.text.trim();

      // Detect centered section headings (Roman numerals, capital letters, digits).
      // These appear on their own centered lines — significantly right of normal indent.
      const indent = line.startX - bodyLeftMargin;
      const isBodyFont = Math.abs(line.avgFontSize - bodyFS) < 1.5;
      const isCentered = bodyLeftMargin > 0 && indent > 50 && isBodyFont;

      if (isCentered && /^(I{1,4}V?|VI{0,3}|IX|X{0,3})$/.test(trimmed)) {
        // Roman numeral heading (level 1): I, II, III, IV, V, VI, VII, VIII, IX, X
        bodyLines.push('');
        bodyLines.push(`{{h1:${trimmed}}}`);
        bodyLines.push('');
        continue;
      }
      if (isCentered && /^[A-Z]$/.test(trimmed)) {
        // Capital letter heading (level 2): A, B, C, D
        bodyLines.push('');
        bodyLines.push(`{{h2:${trimmed}}}`);
        bodyLines.push('');
        continue;
      }
      if (isCentered && /^\d{1,2}$/.test(trimmed)) {
        // Numeric heading (level 3): 1, 2, 3
        bodyLines.push('');
        bodyLines.push(`{{h3:${trimmed}}}`);
        bodyLines.push('');
        continue;
      }

      // Detect paragraph breaks via indentation.
      const isParagraphIndent = bodyLeftMargin > 0 && indent > 5 && indent < 50 && isBodyFont;
      // "Held:" in the Syllabus starts at the flush-left margin (no indent), so it
      // won't trigger isParagraphIndent — detect it explicitly as a paragraph starter.
      const isHeldMarker = /^(?:Held|HELD)\s*:/.test(trimmed);
      if ((isParagraphIndent || isHeldMarker) && bodyLines.length > 0) {
        bodyLines.push(''); // blank line = paragraph break
      }

      bodyLines.push(line.text);
    }

    // Process footnotes (everything after the separator)
    let footnoteContinuation = '';
    if (separatorIdx >= 0) {
      let fnId = 0;
      let fnText = '';

      for (let li = separatorIdx + 1; li < textLines.length; li++) {
        const line = textLines[li];
        const trimmed = line.text.trim();

        // Footnote number on its own line (very small font ~6pt, just a digit).
        // This is the ONLY reliable way to detect a new footnote start in SCOTUS PDFs.
        // The number appears at a distinctly smaller font than both body (~11pt) and
        // footnote text (~9pt).
        if (/^\d{1,2}$/.test(trimmed) && line.avgFontSize < bodyFS - 3) {
          // Save previous footnote
          if (fnId > 0) footnotes.set(fnId, fnText.trim());
          fnId = parseInt(trimmed);
          fnText = '';
          continue;
        }

        // Skip separator lines
        if (/^——+$/.test(trimmed)) continue;

        if (fnId > 0) {
          // Continuation of current footnote
          fnText += ' ' + trimmed;
        } else {
          // No footnote number seen yet — this is continuation from previous page
          footnoteContinuation += ' ' + trimmed;
        }
      }
      if (fnId > 0) footnotes.set(fnId, fnText.trim());
      footnoteContinuation = footnoteContinuation.trim();
    }

    pages.push({ sectionHeader, bodyLines, footnotes, footnoteContinuation });
  }

  // Group pages into chapters by section header changes
  interface ChapterData {
    header: SectionHeader;
    text: string;
    footnotes: Map<number, string>;
  }

  const chapterDatas: ChapterData[] = [];
  let currentHeader: SectionHeader | null = null;
  let currentLines: string[] = [];
  let currentFootnotes = new Map<number, string>();

  for (const page of pages) {
    const header = page.sectionHeader;

    if (header && (!currentHeader || header.id !== currentHeader.id)) {
      // New chapter
      if (currentHeader) {
        chapterDatas.push({
          header: currentHeader,
          text: currentLines.join('\n'),
          footnotes: currentFootnotes,
        });
      } else if (currentLines.length > 0) {
        // Preamble before first recognized header
        chapterDatas.push({
          header: { raw: 'Preamble', normalized: 'Preamble', id: 'preamble', title: 'Preamble', author: null },
          text: currentLines.join('\n'),
          footnotes: currentFootnotes,
        });
      }
      currentHeader = header;
      currentLines = [];
      currentFootnotes = new Map();
    }

    currentLines.push(...page.bodyLines);

    // Merge footnote continuation text from previous page's last footnote
    if (page.footnoteContinuation) {
      let maxId = 0;
      for (const id of currentFootnotes.keys()) {
        if (id > maxId) maxId = id;
      }
      if (maxId > 0) {
        const existing = currentFootnotes.get(maxId) || '';
        currentFootnotes.set(maxId, (existing + ' ' + page.footnoteContinuation).trim());
      }
    }

    for (const [id, text] of page.footnotes) {
      const existing = currentFootnotes.get(id);
      if (existing) {
        currentFootnotes.set(id, existing + ' ' + text);
      } else {
        currentFootnotes.set(id, text);
      }
    }
  }

  // Save last chapter
  if (currentHeader && currentLines.length > 0) {
    chapterDatas.push({
      header: currentHeader,
      text: currentLines.join('\n'),
      footnotes: currentFootnotes,
    });
  }

  // For preliminary prints: split chapters at inline section openers.
  // Prelim print running headers sometimes don't update when a new section starts mid-page,
  // so body text like "Justice Sotomayor, concurring." may be bundled into the wrong chapter.
  const resolvedDatas: typeof chapterDatas = [];
  if (isPrelimPrint) {
    // Matches: "Justice Sotomayor, concurring." / "Chief Justice Roberts, dissenting."
    // / "Justice Breyer, Justice Sotomayor, and Justice Kagan, dissenting."
    const bodyOpenerRe =
      /^(?:Chief\s+)?Justice\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:\s*,\s*(?:and\s+)?(?:Chief\s+)?Justice\s+[A-Z][a-z]+)*\s*,\s*(concurring|dissenting)(?:\s+in\s+(?:the\s+)?(?:judgment|part))?\.?\s*$/i;

    for (const cd of chapterDatas) {
      const lines = cd.text.split('\n');
      let segStart = 0;
      let segHeader = cd.header;
      let didSplit = false;

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw) continue;
        const m = raw.match(bodyOpenerRe);
        if (!m) continue;

        const nameParts = m[1].trim().split(/\s+/);
        const lastName = nameParts[nameParts.length - 1].toUpperCase();
        const type = m[2].toLowerCase();
        const newId = `${type}-${lastName.toLowerCase()}`;
        if (newId === segHeader.id) continue; // same section, no split needed

        const author = KNOWN_JUSTICES[lastName] ?? nameParts[nameParts.length - 1];
        const newHeader: SectionHeader = {
          raw,
          normalized: `${author}, ${type}`,
          id: newId,
          title: `${author}, ${type}`,
          author,
        };

        const segText = lines.slice(segStart, i).join('\n');
        if (segText.trim()) {
          resolvedDatas.push({ header: segHeader, text: segText, footnotes: didSplit ? new Map() : cd.footnotes });
        }
        segStart = i;
        segHeader = newHeader;
        didSplit = true;
      }

      const remainingText = lines.slice(segStart).join('\n');
      if (remainingText.trim()) {
        resolvedDatas.push({ header: segHeader, text: remainingText, footnotes: didSplit ? new Map() : cd.footnotes });
      }
    }
  } else {
    resolvedDatas.push(...chapterDatas);
  }

  // Build final chapters
  const chapters: Chapter[] = resolvedDatas.map((cd) => {
    // Convert footnote map to sorted array
    const footnotes: { id: number; text: string }[] = [];
    for (const [id, text] of cd.footnotes) {
      footnotes.push({ id, text: markCitations(dehyphenate(text)) });
    }
    footnotes.sort((a, b) => a.id - b.id);

    const paragraphs = tagBoilerplate(buildParagraphs(cd.text));
    let author = cd.header.author;

    // For "Opinion of the Court" chapters, extract the author from the
    // JUSTICE delivery line (e.g. "JUSTICE THOMAS delivered the opinion...")
    if (cd.header.id === 'opinion-majority' && !author) {
      author = extractAuthorFromDeliveryLine(paragraphs);
    }

    return {
      id: cd.header.id,
      title: cd.header.title,
      author,
      paragraphs,
      footnotes,
    };
  });

  // If no chapters, single opinion
  if (chapters.length === 0) {
    const allText = pages.map((p) => p.bodyLines.join('\n')).join('\n\n');
    chapters.push({
      id: 'opinion',
      title: 'Opinion',
      author: null,
      paragraphs: buildParagraphs(allText),
      footnotes: [],
    });
  }

  // Extract metadata from page 1 items
  let caseTitle = await extractCaseTitleFromPage1(doc);
  const firstPagesText = pages.slice(0, 3).map((p) => p.bodyLines.join('\n')).join('\n');
  const docketNumber = extractDocketNumber(firstPagesText);
  const decidedDate = extractDecidedDate(firstPagesText);

  // Fallback: extract case title from body text if page 1 method failed
  if (caseTitle === 'Unknown Case') {
    caseTitle = extractCaseTitleFromText(firstPagesText);
  }

  return { caseTitle, docketNumber, decidedDate, sourceUrl, chapters };
}

function extractAuthorFromDeliveryLine(paragraphs: { text: string }[]): string | null {
  for (const p of paragraphs) {
    const m = p.text.match(/^\{\{bpj:(.+)\}\}$/);
    if (!m) continue;
    const line = m[1];
    // "CHIEF JUSTICE ROBERTS delivered..." or "JUSTICE THOMAS delivered..."
    const justiceMatch = line.match(/(?:CHIEF\s+)?JUSTICE\s+([A-Z]{2,})\b/);
    if (justiceMatch && KNOWN_JUSTICES[justiceMatch[1]]) {
      return KNOWN_JUSTICES[justiceMatch[1]];
    }
    // "THE CHIEF JUSTICE delivered..."
    if (/^THE CHIEF JUSTICE\b/.test(line)) {
      return KNOWN_JUSTICES['ROBERTS'] || null;
    }
  }
  return null;
}

async function extractCaseTitleFromPage1(doc: any): Promise<string> {
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();

    const items = tc.items.filter((i: any) => 'str' in i && i.str.trim());
    items.sort((a: any, b: any) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);

    // Find "SUPREME COURT OF THE UNITED STATES" — the case title appears just below it
    let supremeCourtY = -1;
    for (const item of items) {
      if (item.str.includes('SUPREME COURT OF THE UNITED STATES')) {
        supremeCourtY = item.transform[5];
        break;
      }
    }

    if (supremeCourtY < 0) return 'Unknown Case';

    // Collect all items between SCOTUS header and the CERTIORARI/No. line
    // Find the CERTIORARI or "No." line to bound the bottom
    let certY = supremeCourtY - 100;
    for (const item of items) {
      const y = item.transform[5];
      const t = item.str.trim();
      if (y < supremeCourtY && (t.startsWith('CERTIORARI') || t.startsWith('ON WRIT') || /^No\.\s/.test(t))) {
        certY = Math.max(certY, y);
        break;
      }
    }

    const titleItems: { x: number; y: number; text: string }[] = [];
    for (const item of items) {
      const y = item.transform[5];
      // Between SCOTUS header and certiorari line, skip the "Syllabus" header
      if (y < supremeCourtY && y > certY && item.str.trim() !== 'Syllabus') {
        titleItems.push({ x: item.transform[4], y, text: item.str.trim() });
      }
    }

    if (titleItems.length === 0) return 'Unknown Case';

    // Group by Y position (lines), then join
    titleItems.sort((a, b) => b.y - a.y || a.x - b.x);

    const lines: string[] = [];
    let currentLine = '';
    let lastY = -1;

    for (const item of titleItems) {
      if (lastY >= 0 && Math.abs(item.y - lastY) > 3) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = item.text;
      } else {
        currentLine += (currentLine ? ' ' : '') + item.text;
      }
      lastY = item.y;
    }
    if (currentLine.trim()) lines.push(currentLine.trim());

    // Join lines and clean up
    let title = lines.join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\bET AL\b\.?\s*\.?/gi, 'et al.')  // normalize "ET AL" + stray period
      .replace(/\s+v\s*\.\s*/g, ' v. ')
      .replace(/\s+v\s+(?=[A-Z])/, ' v. ')
      .replace(/\.\s*\./g, '.')  // collapse double periods
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[,\s]+$/, '');

    return title || 'Unknown Case';
  } catch {
    return 'Unknown Case';
  }
}

/**
 * Fallback case title extraction from body text.
 * Looks for "X v. Y" pattern in the first few lines.
 */
export function extractCaseTitleFromText(text: string): string {
  const lines = text.split('\n').filter(l => l.trim());
  for (const line of lines.slice(0, 20)) {
    const trimmed = line.trim();
    // Match "NAME v. NAME" or "NAME v . NAME" patterns (case caption style)
    const match = trimmed.match(/^(.+?)\s+v\s*\.\s+(.+?)(?:\s{2,}|$)/);
    if (match) {
      let title = (match[1] + ' v. ' + match[2])
        .replace(/\s+/g, ' ')
        .replace(/\bET AL\b\.?\s*\.?/gi, 'et al.')
        .replace(/\.\s*\./g, '.')
        .trim()
        .replace(/[,\s]+$/, '');
      return title || 'Unknown Case';
    }
  }
  return 'Unknown Case';
}

export function extractDocketNumber(text: string): string {
  const match = text.match(/No\.\s*([\d\-\u2013]+)/);
  return match ? match[1].replace('\u2013', '-') : '';
}

export function extractDecidedDate(text: string): string {
  // "Argued ... — Decided July 1, 2024"
  const decidedMatch = text.match(/Decided\s+(\w+\s+\d+,\s+\d{4})/);
  if (decidedMatch) return decidedMatch[1];
  const bracketMatch = text.match(/\[(\w+\s+\d+,\s+\d{4})\]/);
  if (bracketMatch) return bracketMatch[1];
  return '';
}
