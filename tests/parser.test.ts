import { describe, it, expect } from 'vitest';
import {
  fixSmallCaps,
  dehyphenate,
  buildParagraphs,
  tagBoilerplate,
  splitSCOTUSHeader,
  extractCaseTitleFromText,
  extractDocketNumber,
  extractDecidedDate,
  parseSectionHeader,
} from '../src/lib/parser';

describe('fixSmallCaps', () => {
  it('fixes "J USTICE" → "JUSTICE"', () => {
    expect(fixSmallCaps('J USTICE THOMAS')).toBe('JUSTICE THOMAS');
  });

  it('fixes "C HIEF" → "CHIEF"', () => {
    expect(fixSmallCaps('C HIEF JUSTICE')).toBe('CHIEF JUSTICE');
  });

  it('fixes split justice names like "R OBERTS"', () => {
    expect(fixSmallCaps('R OBERTS')).toBe('ROBERTS');
    expect(fixSmallCaps('T HOMAS')).toBe('THOMAS');
    expect(fixSmallCaps('G ORSUCH')).toBe('GORSUCH');
    expect(fixSmallCaps('K AVANAUGH')).toBe('KAVANAUGH');
    expect(fixSmallCaps('B ARRETT')).toBe('BARRETT');
  });

  it('fixes orphaned fragments like "USTICE GORSUCH"', () => {
    expect(fixSmallCaps('USTICE GORSUCH')).toBe('JUSTICE GORSUCH');
  });

  it('fixes orphaned "HIEF"', () => {
    expect(fixSmallCaps('HIEF JUSTICE')).toBe('CHIEF JUSTICE');
  });

  it('leaves normal text unchanged', () => {
    expect(fixSmallCaps('The court held that')).toBe('The court held that');
  });
});

describe('dehyphenate', () => {
  it('rejoins line-break hyphenations', () => {
    expect(dehyphenate('Eco - nomic')).toBe('Economic');
  });

  it('rejoins hyphenations without space before', () => {
    expect(dehyphenate('con- stitution')).toBe('constitution');
  });

  it('handles footnote-interrupted hyphenations', () => {
    expect(dehyphenate('find - {{fn:2}} ings')).toBe('findings{{fn:2}}');
  });

  it('preserves real hyphens (no spaces around them)', () => {
    expect(dehyphenate('well-known')).toBe('well-known');
  });

  it('preserves hyphens between capitalized words', () => {
    expect(dehyphenate('revenue-Raising')).toBe('revenue-Raising');
  });
});

describe('parseSectionHeader', () => {
  it('parses "Syllabus"', () => {
    const h = parseSectionHeader('Syllabus');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('syllabus');
    expect(h!.title).toBe('Syllabus');
  });

  it('parses "Opinion of the Court"', () => {
    const h = parseSectionHeader('Opinion of the Court');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('opinion-majority');
  });

  it('parses justice concurring with split name', () => {
    const h = parseSectionHeader('T HOMAS , J., concurring');
    expect(h).not.toBeNull();
    expect(h!.author).toBe('Thomas');
    expect(h!.id).toBe('concurring-thomas');
    expect(h!.title).toContain('concurring');
  });

  it('parses justice dissenting', () => {
    const h = parseSectionHeader('S OTOMAYOR , J., dissenting');
    expect(h).not.toBeNull();
    expect(h!.author).toBe('Sotomayor');
    expect(h!.id).toBe('dissenting-sotomayor');
  });

  it('parses "Opinion of R OBERTS , C. J." as majority', () => {
    const h = parseSectionHeader('Opinion of R OBERTS , C. J.');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('opinion-majority');
    expect(h!.author).toBe('Roberts');
  });

  it('parses "Per Curiam"', () => {
    const h = parseSectionHeader('Per Curiam');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('opinion-per-curiam');
  });

  it('parses concurring in judgment', () => {
    const h = parseSectionHeader('T HOMAS , J., concurring in judgment');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('concurring-thomas');
  });

  it('returns null for unrecognized text', () => {
    expect(parseSectionHeader('Some random text')).toBeNull();
    expect(parseSectionHeader('')).toBeNull();
  });
});

describe('splitSCOTUSHeader', () => {
  it('splits a merged SCOTUS header blob', () => {
    const input =
      'SUPREME COURT OF THE UNITED STATES Syllabus BOST ET AL. v. ILLINOIS CERTIORARI TO THE APPELLATE COURT OF ILLINOIS No. 24–568. Argued October 8, 2025—Decided January 14, 2026';
    const { bpParts, bodyRest } = splitSCOTUSHeader(input);
    expect(bpParts[0]).toBe('SUPREME COURT OF THE UNITED STATES');
    expect(bpParts.some(p => p.includes('BOST'))).toBe(true);
    expect(bpParts.some(p => p.includes('CERTIORARI'))).toBe(true);
    expect(bpParts.some(p => p.includes('No.'))).toBe(true);
    expect(bodyRest).toBe('');
  });

  it('separates trailing body text after the decided date', () => {
    const input =
      'SUPREME COURT OF THE UNITED STATES Syllabus FOO v. BAR CERTIORARI TO THE FIFTH CIRCUIT No. 23–100. Argued March 1, 2024—Decided June 15, 2024 This is the start of the body text.';
    const { bpParts, bodyRest } = splitSCOTUSHeader(input);
    expect(bodyRest).toBe('This is the start of the body text.');
    expect(bpParts.every(p => !p.includes('This is the start'))).toBe(true);
  });
});

describe('tagBoilerplate', () => {
  it('tags NOTE disclaimer', () => {
    const paras = [{ text: 'NOTE: Where it is feasible, a syllabus', footnotes: [] }];
    const result = tagBoilerplate(paras);
    expect(result[0].text).toMatch(/^\{\{bp:/);
  });

  it('tags NOTICE line', () => {
    const paras = [{ text: 'NOTICE: This opinion is subject to formal revision', footnotes: [] }];
    const result = tagBoilerplate(paras);
    expect(result[0].text).toMatch(/^\{\{bp:/);
  });

  it('tags JUSTICE delivery line with {{bpj:}}', () => {
    const paras = [
      { text: 'SUPREME COURT OF THE UNITED STATES', footnotes: [] },
      { text: 'JUSTICE SOTOMAYOR delivered the opinion of the Court.', footnotes: [] },
    ];
    const result = tagBoilerplate(paras);
    const justicePara = result.find(p => p.text.includes('SOTOMAYOR'));
    expect(justicePara!.text).toMatch(/^\{\{bpj:/);
  });

  it('stops at first non-matching paragraph', () => {
    const paras = [
      { text: 'NOTICE: This opinion is subject to formal revision', footnotes: [] },
      { text: 'This is a regular body paragraph about the case.', footnotes: [] },
      { text: 'Another body paragraph.', footnotes: [] },
    ];
    const result = tagBoilerplate(paras);
    expect(result[0].text).toMatch(/^\{\{bp:/);
    expect(result[1].text).not.toMatch(/^\{\{bp/);
    expect(result[2].text).not.toMatch(/^\{\{bp/);
  });

  it('does NOT tag long paragraphs containing v. as boilerplate', () => {
    const longCitation = 'In ' + 'x'.repeat(260) + ' v. ' + 'y'.repeat(10) + ' 24-100 the Court held...';
    const paras = [{ text: longCitation, footnotes: [] }];
    const result = tagBoilerplate(paras);
    expect(result[0].text).not.toMatch(/^\{\{bp:/);
  });
});

describe('extractCaseTitleFromText', () => {
  it('extracts a case title with v.', () => {
    const text = 'DOE v . DYNAMIC PHYSICAL THERAPY  some other text\nMore lines here';
    const title = extractCaseTitleFromText(text);
    expect(title).toContain('DOE');
    expect(title).toContain('v.');
    expect(title).toContain('DYNAMIC PHYSICAL THERAPY');
  });

  it('returns Unknown Case when no v. pattern found', () => {
    expect(extractCaseTitleFromText('No case name here\nJust text')).toBe('Unknown Case');
  });
});

describe('extractDocketNumber', () => {
  it('extracts docket with en-dash', () => {
    expect(extractDocketNumber('No. 24\u2013568')).toBe('24-568');
  });

  it('extracts docket with hyphen', () => {
    expect(extractDocketNumber('No. 23-939')).toBe('23-939');
  });

  it('returns empty string when no match', () => {
    expect(extractDocketNumber('No docket here')).toBe('');
  });
});

describe('extractDecidedDate', () => {
  it('extracts date from "Decided" line', () => {
    expect(extractDecidedDate('Argued October 1, 2025—Decided January 14, 2026')).toBe(
      'January 14, 2026'
    );
  });

  it('extracts date from bracket format', () => {
    expect(extractDecidedDate('[July 1, 2024]')).toBe('July 1, 2024');
  });

  it('returns empty string when no match', () => {
    expect(extractDecidedDate('No date here')).toBe('');
  });
});

describe('buildParagraphs', () => {
  it('splits on double newlines', () => {
    const paras = buildParagraphs('First paragraph.\n\nSecond paragraph.');
    expect(paras).toHaveLength(2);
    expect(paras[0].text).toBe('First paragraph.');
    expect(paras[1].text).toBe('Second paragraph.');
  });

  it('merges continuation lines (lowercase start, no sentence-ending punct)', () => {
    const paras = buildParagraphs('The court held that\n\nthe statute was valid.');
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toContain('The court held that');
    expect(paras[0].text).toContain('the statute was valid.');
  });

  it('skips short fragments under 3 chars', () => {
    const paras = buildParagraphs('OK\n\nA real paragraph here.');
    expect(paras).toHaveLength(1);
  });

  it('preserves heading markers', () => {
    const paras = buildParagraphs('{{h1:I}}\n\nSome text.');
    expect(paras).toHaveLength(2);
    expect(paras[0].text).toBe('{{h1:I}}');
  });

  it('dehyphenates within paragraphs', () => {
    const paras = buildParagraphs('The eco - nomic impact was significant.');
    expect(paras[0].text).toContain('economic');
  });

  it('applies fixSmallCaps', () => {
    const paras = buildParagraphs('J USTICE T HOMAS delivered the opinion.');
    expect(paras[0].text).toContain('JUSTICE');
    expect(paras[0].text).toContain('THOMAS');
  });
});
