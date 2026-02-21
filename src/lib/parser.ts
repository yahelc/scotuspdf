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
  ROBERTS: 'Roberts', THOMAS: 'Thomas', ALITO: 'Alito',
  SOTOMAYOR: 'Sotomayor', KAGAN: 'Kagan', GORSUCH: 'Gorsuch',
  KAVANAUGH: 'Kavanaugh', BARRETT: 'Barrett', JACKSON: 'Jackson',
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

function parseSectionHeader(headerText: string): SectionHeader | null {
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
function fixSmallCaps(text: string): string {
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
function dehyphenate(text: string): string {
  // Fix footnote-interrupted hyphenations first (more specific):
  // "con - 1 solidated" → "consolidated" (footnote number embedded mid-word)
  let result = text.replace(/(\w)\s*-\s+\d+\s+([a-z])/g, '$1$2');

  // Then fix standard line-break hyphenations:
  // "Eco - nomic" or "con- stitution" → "Economic" or "constitution"
  result = result.replace(/(\w)\s*-\s+([a-z])/g, '$1$2');

  return result;
}

function buildParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const rawParagraphs = text.split(/\n{2,}/);

  for (const raw of rawParagraphs) {
    let trimmed = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length < 3) continue;

    // Rejoin line-break hyphenations
    trimmed = dehyphenate(trimmed);

    // Skip repeated headers
    if (/^\d+\s+[A-Z\s]+v\.\s+[A-Z\s]+$/.test(trimmed)) continue;
    if (/^Cite as:/.test(trimmed)) continue;
    if (/^SUPREME COURT OF THE UNITED STATES$/.test(trimmed)) continue;

    // Fix small-cap rendering artifacts
    trimmed = fixSmallCaps(trimmed);

    // Merge with previous paragraph if this is a continuation:
    // previous paragraph doesn't end with sentence-ending punctuation,
    // and this one starts with a lowercase letter.
    if (
      paragraphs.length > 0 &&
      trimmed.length > 0 &&
      /^[a-z]/.test(trimmed) &&
      !/[.!?;:'")\u201d]\s*$/.test(paragraphs[paragraphs.length - 1].text)
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

export async function parsePdf(pdfData: ArrayBuffer, sourceUrl: string): Promise<ParsedOpinion> {
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
  }

  const pages: PageResult[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const textContent: PageTextContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;

    // Adjust header Y range based on page height (proportional)
    const hYMin = pageHeight * 0.80;
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

    // Extract section header from the header band
    const headerItems = allItems.filter((it) => it.y >= hYMin && it.y <= hYMax);
    headerItems.sort((a, b) => a.x - b.x);
    const headerText = headerItems.map((it) => it.text.trim()).join(' ');
    const sectionHeader = parseSectionHeader(headerText);

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
      return true;
    });
    bodyItems.sort((a, b) => b.y - a.y || a.x - b.x);

    // Group into text lines, handling small-cap name rendering.
    // SCOTUS PDFs render names in small caps: the first letter is at body font size
    // and remaining letters are ALL-CAPS at a smaller size (e.g., "J" at 11pt + "USTICE" at 9pt).
    // pdf.js returns these as separate items, so we need to join them without a space.
    // Track x-position of first item on each line to detect paragraph indentation.
    const textLines: { text: string; avgFontSize: number; startX: number }[] = [];
    let curText = '';
    let curStartX = 0;
    let lastY = -1;
    let lastFontSize = 0;
    let fsSum = 0;
    let fsCount = 0;

    for (const item of bodyItems) {
      if (lastY >= 0 && Math.abs(item.y - lastY) > 2) {
        // New line
        if (curText.trim()) textLines.push({ text: curText.trim(), avgFontSize: fsCount > 0 ? fsSum / fsCount : 0, startX: curStartX });
        curText = item.text;
        curStartX = item.x;
        fsSum = item.fontSize;
        fsCount = 1;
      } else {
        // Same line — check if this is a small-cap continuation
        const trimmedItem = item.text.trim();
        const isSmallCap = (
          trimmedItem.length > 0 &&
          /^[A-Z]+$/.test(trimmedItem) &&
          item.fontSize < lastFontSize - 0.5 &&
          curText.length > 0 &&
          /[A-Z]$/.test(curText)
        );

        if (isSmallCap) {
          // Join without space — small-cap continuation
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

    // Find dominant font size for footnote detection
    const fsSizes = textLines.map((l) => Math.round(l.avgFontSize));
    const fsFreq = new Map<number, number>();
    for (const fs of fsSizes) fsFreq.set(fs, (fsFreq.get(fs) || 0) + 1);
    let bodyFS = 0;
    let maxFreq = 0;
    for (const [fs, freq] of fsFreq) {
      if (freq > maxFreq) { maxFreq = freq; bodyFS = fs; }
    }

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

    // Separate footnotes (smaller font, start with number)
    // Mark lines that are indented (paragraph starts) with a preceding blank line
    const bodyLines: string[] = [];
    const footnotes = new Map<number, string>();
    let inFN = false;
    let fnId = 0;
    let fnText = '';
    let lastFnId = 0;

    for (const line of textLines) {
      const isSmall = line.avgFontSize > 0 && bodyFS > 0 && line.avgFontSize < bodyFS - 1;
      const fnMatch = line.text.match(/^(\d{1,2})\s+(.+)/);

      if (fnMatch && isSmall) {
        const num = parseInt(fnMatch[1]);
        if (num > 0 && num < 100 && (num === lastFnId + 1 || lastFnId === 0)) {
          if (fnId > 0) footnotes.set(fnId, fnText.trim());
          fnId = num;
          fnText = fnMatch[2];
          lastFnId = num;
          inFN = true;
          continue;
        }
      }

      if (inFN && isSmall) {
        fnText += ' ' + line.text;
        continue;
      }

      if (inFN) {
        footnotes.set(fnId, fnText.trim());
        inFN = false;
        fnId = 0;
        fnText = '';
      }

      // Detect paragraph breaks via indentation.
      // SCOTUS body text uses a consistent left margin; new paragraphs are indented
      // ~9-11pt from that margin. We avoid triggering on centered headers/titles
      // by requiring the line to be at body font size and the indent to be small
      // (real paragraph indents are 9-25pt, not 100+pt like centered text).
      const indent = line.startX - bodyLeftMargin;
      const isBodyFont = Math.abs(line.avgFontSize - bodyFS) < 1.5;
      const isParagraphIndent = bodyLeftMargin > 0 && indent > 5 && indent < 50 && isBodyFont;
      if (isParagraphIndent && bodyLines.length > 0) {
        bodyLines.push(''); // blank line = paragraph break
      }

      bodyLines.push(line.text);
    }
    if (fnId > 0) footnotes.set(fnId, fnText.trim());

    pages.push({ sectionHeader, bodyLines, footnotes });
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
    for (const [id, text] of page.footnotes) {
      currentFootnotes.set(id, text);
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

  // Build final chapters
  const chapters: Chapter[] = chapterDatas.map((cd) => ({
    id: cd.header.id,
    title: cd.header.title,
    author: cd.header.author,
    paragraphs: buildParagraphs(cd.text),
  }));

  // If no chapters, single opinion
  if (chapters.length === 0) {
    const allText = pages.map((p) => p.bodyLines.join('\n')).join('\n\n');
    chapters.push({
      id: 'opinion',
      title: 'Opinion',
      author: null,
      paragraphs: buildParagraphs(allText),
    });
  }

  // Extract metadata from page 1 items
  const caseTitle = await extractCaseTitleFromPage1(doc);
  const firstPagesText = pages.slice(0, 3).map((p) => p.bodyLines.join('\n')).join('\n');
  const docketNumber = extractDocketNumber(firstPagesText);
  const decidedDate = extractDecidedDate(firstPagesText);

  return { caseTitle, docketNumber, decidedDate, sourceUrl, chapters };
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

function extractDocketNumber(text: string): string {
  const match = text.match(/No\.\s*([\d\-\u2013]+)/);
  return match ? match[1].replace('\u2013', '-') : '';
}

function extractDecidedDate(text: string): string {
  // "Argued ... — Decided July 1, 2024"
  const decidedMatch = text.match(/Decided\s+(\w+\s+\d+,\s+\d{4})/);
  if (decidedMatch) return decidedMatch[1];
  const bracketMatch = text.match(/\[(\w+\s+\d+,\s+\d{4})\]/);
  if (bracketMatch) return bracketMatch[1];
  return '';
}
