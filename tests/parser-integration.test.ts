import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePdf } from '../src/lib/parser';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function loadFixture(filename: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURES, filename));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('Learning Resources (24-1287)', () => {
  let result: Awaited<ReturnType<typeof parsePdf>>;

  it('parses without error', async () => {
    const data = loadFixture('24-1287_4gcj.pdf');
    result = await parsePdf(data, 'https://www.supremecourt.gov/opinions/25pdf/24-1287_4gcj.pdf');
  }, 30000);

  it('has 8 chapters', () => {
    expect(result.chapters).toHaveLength(8);
  });

  it('extracts case title containing "LEARNING RESOURCES" and "v."', () => {
    expect(result.caseTitle).toContain('v.');
    expect(result.caseTitle.toUpperCase()).toContain('LEARNING RESOURCES');
  });

  it('Syllabus has SCOTUS header tagged as boilerplate', () => {
    const syllabus = result.chapters.find(c => c.id === 'syllabus');
    expect(syllabus).toBeDefined();
    const bpParas = syllabus!.paragraphs.filter(p => /^\{\{bp:/.test(p.text));
    expect(bpParas.length).toBeGreaterThanOrEqual(3); // SCOTUS header, case name, cert, docket/date
  });

  it('Syllabus body is NOT tagged as boilerplate', () => {
    const syllabus = result.chapters.find(c => c.id === 'syllabus');
    expect(syllabus).toBeDefined();
    // Find first non-bp, non-heading paragraph — should be body text
    const bodyParas = syllabus!.paragraphs.filter(
      p => !/^\{\{bp/.test(p.text) && !/^\{\{bpj/.test(p.text) && !/^\{\{h[1-3]:/.test(p.text)
    );
    expect(bodyParas.length).toBeGreaterThan(0);
  });

  it('Opinion chapter has {{bpj:}} justice delivery line', () => {
    const opinion = result.chapters.find(c => c.id === 'opinion-majority');
    expect(opinion).toBeDefined();
    const bpjParas = opinion!.paragraphs.filter(p => /^\{\{bpj:/.test(p.text));
    expect(bpjParas.length).toBeGreaterThan(0);
  });

  it('Thomas dissent has "I join JUSTICE KAVANAUGH" in correct word order (sub-pixel y-sort regression)', () => {
    const thomas = result.chapters.find(c => c.id.includes('thomas'));
    expect(thomas).toBeDefined();
    const allText = thomas!.paragraphs.map(p => p.text).join(' ');
    // Should contain "I join" — not garbled by y-sort reordering
    expect(allText).toContain('I join');
    expect(allText).toContain('KAVANAUGH');
  });
});

describe('Trump v. US (23-939)', () => {
  let result: Awaited<ReturnType<typeof parsePdf>>;

  it('parses without error', async () => {
    const data = loadFixture('23-939_e2pg.pdf');
    result = await parsePdf(data, 'https://www.supremecourt.gov/opinions/23pdf/23-939_e2pg.pdf');
  }, 30000);

  it('has 6 chapters', () => {
    expect(result.chapters).toHaveLength(6);
  });

  it('extracts case title "TRUMP v. UNITED STATES"', () => {
    expect(result.caseTitle.toUpperCase()).toContain('TRUMP');
    expect(result.caseTitle).toContain('v.');
    expect(result.caseTitle.toUpperCase()).toContain('UNITED STATES');
  });

  it('Sotomayor dissent has multi-line joinder tagged {{bpj:}}', () => {
    const sotomayor = result.chapters.find(c => c.id.includes('sotomayor'));
    expect(sotomayor).toBeDefined();
    const bpjParas = sotomayor!.paragraphs.filter(p => /^\{\{bpj:/.test(p.text));
    expect(bpjParas.length).toBeGreaterThan(0);
  });
});

describe('Bowe v. US (24-5438)', () => {
  let result: Awaited<ReturnType<typeof parsePdf>>;

  it('parses without error', async () => {
    const data = loadFixture('24-5438_o7kq.pdf');
    result = await parsePdf(data, 'https://www.supremecourt.gov/opinions/25pdf/24-5438_o7kq.pdf');
  }, 30000);

  it('has 4 chapters', () => {
    expect(result.chapters).toHaveLength(4);
  });

  it('Gorsuch dissent has multi-line joinder', () => {
    const gorsuch = result.chapters.find(c => c.id.includes('gorsuch'));
    expect(gorsuch).toBeDefined();
    const bpjParas = gorsuch!.paragraphs.filter(p => /^\{\{bpj:/.test(p.text));
    expect(bpjParas.length).toBeGreaterThan(0);
  });
});

describe('Doe v. Dynamic Physical Therapy (preliminary print)', () => {
  let result: Awaited<ReturnType<typeof parsePdf>>;

  it('parses without error', async () => {
    const data = loadFixture('607us1r03_10n2.pdf');
    result = await parsePdf(data, 'https://www.supremecourt.gov/opinions/25pdf/607us1r03_10n2.pdf');
  }, 30000);

  it('extracts case title containing "DOE" and "DYNAMIC PHYSICAL THERAPY"', () => {
    expect(result.caseTitle.toUpperCase()).toContain('DOE');
    expect(result.caseTitle.toUpperCase()).toContain('DYNAMIC PHYSICAL THERAPY');
  });

  it('extracts docket number 25-180', () => {
    expect(result.docketNumber).toBe('25-180');
  });
});
