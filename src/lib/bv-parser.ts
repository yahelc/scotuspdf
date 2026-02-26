import type { ParsedOpinion } from './types';

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

/**
 * Find the front matter offset for a bound volume PDF.
 * Scans pages looking for the first page with a "Cite as:" header containing
 * an Arabic page number. Returns the offset: (PDF page index) - (printed page number).
 */
async function findFrontMatterOffset(doc: any): Promise<number> {
  const numPages = doc.numPages;
  // Scan first 400 pages. Most volumes have < 50 pages of front matter, but some
  // large volumes (e.g. vol 562) have 220+ pages of table-of-cases and indices
  // before the first opinion, so 100 is not always sufficient.
  const scanLimit = Math.min(numPages, 400);

  for (let i = 1; i <= scanLimit; i++) {
    const page = await doc.getPage(i);
    const textContent: PageTextContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;

    // Collect items from both the slip-opinion top area (y > 90%) and the bound
    // volume header band (y ≈ 80–84%). Bound volumes put "Cite as:" in the band,
    // not at the very top of the page.
    const headerItems: { text: string; y: number; x: number }[] = [];
    for (const item of textContent.items) {
      if ('str' in item && item.str.trim()) {
        const y = item.transform[5];
        if (y >= pageHeight * 0.80) {
          headerItems.push({ text: item.str.trim(), y, x: item.transform[4] });
        }
      }
    }

    const headerText = headerItems.map(it => it.text).join(' ');
    const citeMatch = headerText.match(/Cite as:\s*\d+\s+U\.\s*S\.\s+(\d+)/);
    if (!citeMatch) continue;

    // For slip opinions the "Cite as: X U.S. Y" line is the CURRENT page's number,
    // so offset = pdfIndex - Y.
    // For bound volumes "Cite as: X U.S. Y" is the CASE START page, not the current
    // printed page. The actual printed page number appears as a standalone 3+-digit
    // number at the left or right margin of the upper band row (y > 83%).
    const upperItems = headerItems.filter(it => it.y > pageHeight * 0.83);
    const pageNumItem = upperItems.find(
      it => /^\d+$/.test(it.text) && (it.x < 200 || it.x > 400)
    );
    if (pageNumItem) {
      // Bound volume: offset = pdfIndex - printed page number
      return i - parseInt(pageNumItem.text);
    }

    // Slip opinion: offset = pdfIndex - case start page
    return i - parseInt(citeMatch[1]);
  }

  // Fallback: no offset found, assume 0
  return 0;
}

/**
 * Extract the "Cite as" page number from a given PDF page's header.
 * Returns the starting page of the case on that page, or null if not found.
 */
async function getCiteAsPage(doc: any, pageIndex: number): Promise<number | null> {
  if (pageIndex < 1 || pageIndex > doc.numPages) return null;
  const page = await doc.getPage(pageIndex);
  const textContent: PageTextContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1.0 });
  const pageHeight = viewport.height;

  const headerItems: { text: string }[] = [];
  for (const item of textContent.items) {
    if ('str' in item && item.str.trim()) {
      const y = item.transform[5];
      // Check both slip-opinion top area (> 90%) and bound-volume band (80–84%)
      if (y >= pageHeight * 0.80) {
        headerItems.push({ text: item.str.trim() });
      }
    }
  }

  const headerText = headerItems.map(it => it.text).join(' ');
  // "Cite as: 553 U. S. 285 (2008)" — we want 285
  const match = headerText.match(/Cite as:\s*\d+\s+U\.\s*S\.\s+(\d+)/);
  return match ? parseInt(match[1]) : null;
}

/**
 * Parse a single case from a bound volume PDF.
 *
 * @param pdfData - The full bound volume PDF as ArrayBuffer
 * @param volume - The volume number (e.g., 553)
 * @param startPage - The starting printed page number of the case (e.g., 285)
 * @returns ParsedOpinion for the cited case
 */
export async function parseBoundVolumeCase(
  pdfData: ArrayBuffer,
  volume: number,
  startPage: number
): Promise<ParsedOpinion> {
  // Pre-load the worker on the main thread (same pattern as parser.ts)
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

  // Compute rough offset from early pages, then refine by searching near the target.
  // The offset isn't constant: blank separator pages accumulate between cases, so the
  // early-pages estimate may be off by a few pages relative to the target location.
  const roughOffset = await findFrontMatterOffset(doc);
  const roughEstimate = startPage + roughOffset;

  // Refine firstPdfPage: search for a page near the estimate that has
  // "Cite as: X U.S. startPage" in the upper band row.
  // That page's standalone printed-page number gives the exact offset.
  let firstPdfPage = roughEstimate;
  const searchStart = Math.max(1, roughEstimate - 5);
  // Wide forward window: blank separator pages accumulate throughout a bound volume,
  // causing the offset to drift by up to ~80 pages between the front matter
  // (where roughOffset was measured) and later cases in the volume.
  const searchEnd = Math.min(doc.numPages, roughEstimate + 80);
  for (let si = searchStart; si <= searchEnd; si++) {
    const sp = await doc.getPage(si);
    const sh = sp.getViewport({ scale: 1.0 }).height;
    const sc: PageTextContent = await sp.getTextContent();
    const upperItems: { text: string; x: number }[] = [];
    for (const item of sc.items) {
      if ('str' in item && item.str.trim() && item.transform[5] > sh * 0.83) {
        upperItems.push({ text: item.str.trim(), x: item.transform[4] });
      }
    }
    const upperText = upperItems.map(it => it.text).join(' ');

    // Early exit: if the band shows "Cite as: X U.S. Y" where Y > startPage,
    // we've scanned past our target case into the next one.
    const anyBvCite = upperText.match(/Cite\s+as:\s*\d+\s+U\.\s*S\.\s+(\d+)/);
    if (anyBvCite && parseInt(anyBvCite[1]) > startPage) break;

    if (!new RegExp(`Cite\\s+as:\\s*\\d+\\s+U\\.\\s*S\\.\\s+${startPage}\\b`).test(upperText)) continue;

    // Found the "Cite as: X U.S. startPage" page. The standalone page number
    // at left (x < 200) or right (x > 400) margin gives the current printed page.
    const pageNumItem = upperItems.find(it => /^\d+$/.test(it.text) && (it.x < 200 || it.x > 400));
    if (pageNumItem) {
      firstPdfPage = startPage + (si - parseInt(pageNumItem.text));
    } else {
      // Fallback: for even startPage "Cite as:" is on page 2 (si-1);
      // for odd startPage it's on page 3 (si-2, since odd pages carry "Cite as:").
      firstPdfPage = si - (startPage % 2 === 0 ? 1 : 2);
    }
    break;
  }

  if (firstPdfPage < 1 || firstPdfPage > doc.numPages) {
    throw new Error(`Page ${startPage} not found in volume ${volume} (estimated PDF page ${roughEstimate})`);
  }

  // Find case boundaries: stop when the band shows a new case starting.
  // "OCTOBER TERM, YYYY" in the band marks the very first page of each new case.
  // A different "Cite as: X U.S. Y" (Y ≠ startPage) also signals a new case.
  let lastPdfPage = firstPdfPage;
  for (let i = firstPdfPage + 1; i <= doc.numPages; i++) {
    const lp = await doc.getPage(i);
    const lh = lp.getViewport({ scale: 1.0 }).height;
    const lc: PageTextContent = await lp.getTextContent();
    const bandText = lc.items
      .filter(item => 'str' in item && item.str.trim() && item.transform[5] >= lh * 0.80)
      .map(item => (item as TextItem).str.trim())
      .join(' ');

    if (/OCTOBER TERM/.test(bandText)) break; // first page of a new case
    const citeMatch = bandText.match(/Cite as:\s*\d+\s+U\.\s*S\.\s+(\d+)/);
    if (citeMatch && parseInt(citeMatch[1]) !== startPage) break;

    lastPdfPage = i;
  }

  let caseTitle = `${volume} U.S. ${startPage}`;

  // Find the case name in the upper band row (y > 83%) on an even-printed-page.
  // Odd printed pages carry "Cite as: X U.S. Y"; even pages carry the case name.
  // The first page (startPage) shows "OCTOBER TERM" — its upper band is just a page number.
  // Scan up to 4 pages past firstPdfPage to find the first even-printed-page with the name.
  {
    const titleSearchEnd = Math.min(doc.numPages, firstPdfPage + 4);
    for (let ti = firstPdfPage; ti <= titleSearchEnd; ti++) {
      const tp = await doc.getPage(ti);
      const th = tp.getViewport({ scale: 1.0 }).height;
      const tc: PageTextContent = await tp.getTextContent();

      const upperBandItems: { text: string; x: number }[] = [];
      for (const item of tc.items) {
        // Stay within the header band (80–90%): avoids typesetter codes at the very top (> 90%)
        if ('str' in item && item.str.trim() &&
            item.transform[5] > th * 0.83 && item.transform[5] <= th * 0.90) {
          upperBandItems.push({ text: item.str.trim(), x: item.transform[4] });
        }
      }

      // Skip odd printed pages (they show "Cite as:") and first page (shows "OCTOBER TERM")
      const upperText = upperBandItems.map(it => it.text).join(' ');
      if (/Cite\s+as:/i.test(upperText) || /OCTOBER TERM/.test(upperText)) continue;

      // Exclude standalone page numbers at left/right margins
      const nameItems = upperBandItems.filter(
        it => !(/^\d+$/.test(it.text) && (it.x < 200 || it.x > 400))
      );
      const candidateText = nameItems.map(it => it.text.trim()).join(' ').trim();
      if (!candidateText) continue; // first case page or page with only a page number

      caseTitle = candidateText.replace(/\s+/g, ' ').trim();
      break;
    }
  }

  // Extract text from our page range using the same approach as parsePdf
  const { buildParagraphs, tagBoilerplate, parseSectionHeader, dehyphenate, markCitations } = await import('./parser');

  interface PageResult {
    sectionHeader: { raw: string; normalized: string; id: string; title: string; author: string | null } | null;
    bodyLines: string[];
    footnotes: Map<number, string>;
    footnoteContinuation: string;
  }

  const pages: PageResult[] = [];

  for (let i = firstPdfPage; i <= lastPdfPage; i++) {
    const page = await doc.getPage(i);
    const textContent: PageTextContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;

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

    // Extract section header using lowest-y-row approach.
    // Bound volumes (and prelim prints) have two rows in the band:
    //   upper row (y ≈ 83–84%): page number + "Cite as:" or case name
    //   lower row (y ≈ 80–81%): section label (Syllabus, Opinion of the Court, etc.)
    // By selecting only the lowest-y row we isolate the section label.
    const headerItems = allItems.filter(it => it.y >= hYMin && it.y <= hYMax);
    let sectionHeader = null;
    if (headerItems.length > 0) {
      const snapY = (y: number) => Math.round(y / 2) * 2;
      const minY = Math.min(...headerItems.map(it => snapY(it.y)));
      const lowestRow = headerItems.filter(it => snapY(it.y) <= minY + 4);
      lowestRow.sort((a, b) => a.x - b.x);
      const headerText = lowestRow.map(it => it.text.trim()).join(' ');
      sectionHeader = parseSectionHeader(headerText);
    }

    // Body text
    const bodyItems = allItems.filter(it => {
      const y = it.y;
      if (y >= hYMin) return false;
      if (y < 60) return false;
      if (y > pageHeight - 60) {
        const t = it.text.trim();
        if (/^Cite as:/.test(t)) return false;
        if (/^\d+$/.test(t)) return false;
        if (/^\(Slip Opinion\)/.test(t)) return false;
      }
      return true;
    });

    bodyItems.sort((a, b) => {
      const dy = Math.round(b.y) - Math.round(a.y);
      return dy !== 0 ? dy : a.x - b.x;
    });

    // Dominant body font size
    const itemFSFreq = new Map<number, number>();
    for (const item of bodyItems) {
      const fs = Math.round(item.fontSize);
      itemFSFreq.set(fs, (itemFSFreq.get(fs) || 0) + 1);
    }
    let bodyFS = 0;
    let maxFreq = 0;
    for (const [fs, freq] of itemFSFreq) {
      if (freq > maxFreq) { maxFreq = freq; bodyFS = fs; }
    }

    // Find footnote separator
    let separatorY = -1;
    for (const item of bodyItems) {
      if (/^——+$/.test(item.text.trim()) && bodyFS > 0 && item.fontSize < bodyFS - 1) {
        separatorY = item.y;
        break;
      }
    }

    // Snap superscript footnote refs
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

    bodyItems.sort((a, b) => {
      const dy = Math.round(b.y) - Math.round(a.y);
      return dy !== 0 ? dy : a.x - b.x;
    });

    // Build text lines
    const textLines: { text: string; avgFontSize: number; startX: number }[] = [];
    let curText = '';
    let curStartX = 0;
    let lastY = -1;
    let lastFontSize = 0;
    let fsSum = 0;
    let fsCount = 0;

    for (const item of bodyItems) {
      const trimmedItem = item.text.trim();
      const isAboveSeparator = separatorY < 0 || item.y > separatorY + 2;
      const isSuperscriptRef = (
        isAboveSeparator &&
        /^\d{1,2}$/.test(trimmedItem) &&
        bodyFS > 0 &&
        item.fontSize < bodyFS - 2.5
      );

      if (lastY >= 0 && Math.abs(item.y - lastY) > 2) {
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
        const isSmallCap = (
          trimmedItem.length > 0 &&
          /^[A-Z]+$/.test(trimmedItem) &&
          item.fontSize < lastFontSize - 0.5 &&
          curText.length > 0 &&
          /[A-Z]$/.test(curText)
        );

        if (isSuperscriptRef) {
          curText += `{{fn:${trimmedItem}}}`;
        } else if (isSmallCap) {
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

    // Find dominant left margin
    const bodyFontLines = textLines.filter(
      l => l.avgFontSize > 0 && bodyFS > 0 && l.avgFontSize >= bodyFS - 1
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

    // Split into body and footnotes
    const bodyLines: string[] = [];
    const footnotes = new Map<number, string>();

    let separatorIdx = -1;
    for (let li = 0; li < textLines.length; li++) {
      if (/^——+$/.test(textLines[li].text.trim())) {
        const isSmall = textLines[li].avgFontSize > 0 && bodyFS > 0 && textLines[li].avgFontSize < bodyFS - 1;
        if (isSmall) {
          separatorIdx = li;
          break;
        }
      }
    }

    const bodyEnd = separatorIdx >= 0 ? separatorIdx : textLines.length;
    for (let li = 0; li < bodyEnd; li++) {
      const line = textLines[li];
      const trimmed = line.text.trim();

      const indent = line.startX - bodyLeftMargin;
      const isBodyFont = Math.abs(line.avgFontSize - bodyFS) < 1.5;
      const isCentered = bodyLeftMargin > 0 && indent > 50 && isBodyFont;

      if (isCentered && /^(I{1,4}V?|VI{0,3}|IX|X{0,3})$/.test(trimmed)) {
        bodyLines.push('');
        bodyLines.push(`{{h1:${trimmed}}}`);
        bodyLines.push('');
        continue;
      }
      if (isCentered && /^[A-Z]$/.test(trimmed)) {
        bodyLines.push('');
        bodyLines.push(`{{h2:${trimmed}}}`);
        bodyLines.push('');
        continue;
      }
      if (isCentered && /^\d{1,2}$/.test(trimmed)) {
        bodyLines.push('');
        bodyLines.push(`{{h3:${trimmed}}}`);
        bodyLines.push('');
        continue;
      }

      const isParagraphIndent = bodyLeftMargin > 0 && indent > 5 && indent < 50 && isBodyFont;
      if (isParagraphIndent && bodyLines.length > 0) {
        bodyLines.push('');
      }

      bodyLines.push(line.text);
    }

    let footnoteContinuation = '';
    if (separatorIdx >= 0) {
      let fnId = 0;
      let fnText = '';

      for (let li = separatorIdx + 1; li < textLines.length; li++) {
        const line = textLines[li];
        const trimmed = line.text.trim();

        if (/^\d{1,2}$/.test(trimmed) && line.avgFontSize < bodyFS - 3) {
          if (fnId > 0) footnotes.set(fnId, fnText.trim());
          fnId = parseInt(trimmed);
          fnText = '';
          continue;
        }

        if (/^——+$/.test(trimmed)) continue;

        if (fnId > 0) {
          fnText += ' ' + trimmed;
        } else {
          footnoteContinuation += ' ' + trimmed;
        }
      }
      if (fnId > 0) footnotes.set(fnId, fnText.trim());
      footnoteContinuation = footnoteContinuation.trim();
    }

    pages.push({ sectionHeader, bodyLines, footnotes, footnoteContinuation });
  }

  // Group pages into chapters (same logic as parsePdf)
  interface ChapterData {
    header: { raw: string; normalized: string; id: string; title: string; author: string | null };
    text: string;
    footnotes: Map<number, string>;
  }

  const chapterDatas: ChapterData[] = [];
  let currentHeader: ChapterData['header'] | null = null;
  let currentLines: string[] = [];
  let currentFootnotes = new Map<number, string>();

  for (const page of pages) {
    const header = page.sectionHeader;

    if (header && (!currentHeader || header.id !== currentHeader.id)) {
      if (currentHeader) {
        chapterDatas.push({ header: currentHeader, text: currentLines.join('\n'), footnotes: currentFootnotes });
      } else if (currentLines.length > 0) {
        chapterDatas.push({
          header: { raw: 'Opinion', normalized: 'Opinion', id: 'opinion', title: 'Opinion', author: null },
          text: currentLines.join('\n'),
          footnotes: currentFootnotes,
        });
      }
      currentHeader = header;
      currentLines = [];
      currentFootnotes = new Map();
    }

    currentLines.push(...page.bodyLines);

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

  if (currentHeader && currentLines.length > 0) {
    chapterDatas.push({ header: currentHeader, text: currentLines.join('\n'), footnotes: currentFootnotes });
  }

  // Build final chapters
  const finalChapters = chapterDatas.map(cd => {
    const footnotes: { id: number; text: string }[] = [];
    for (const [id, text] of cd.footnotes) {
      footnotes.push({ id, text: markCitations(dehyphenate(text)) });
    }
    footnotes.sort((a, b) => a.id - b.id);

    return {
      id: cd.header.id,
      title: cd.header.title,
      author: cd.header.author,
      paragraphs: tagBoilerplate(buildParagraphs(cd.text)),
      footnotes,
    };
  });

  if (finalChapters.length === 0) {
    const allText = pages.map(p => p.bodyLines.join('\n')).join('\n\n');
    finalChapters.push({
      id: 'opinion',
      title: 'Opinion',
      author: null,
      paragraphs: buildParagraphs(allText),
      footnotes: [],
    });
  }

  const sourceUrl = `https://www.supremecourt.gov/opinions/boundvolumes/${volume}bv.pdf`;

  return {
    caseTitle,
    docketNumber: '',
    decidedDate: '',
    sourceUrl,
    chapters: finalChapters,
  };
}
