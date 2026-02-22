export interface Footnote {
  id: number;
  text: string;
}

export interface Paragraph {
  text: string;
  footnotes: Footnote[];
}

export interface Chapter {
  id: string;
  title: string;
  author: string | null;
  paragraphs: Paragraph[];
  footnotes: Footnote[];
}

export interface ParsedOpinion {
  caseTitle: string;
  docketNumber: string;
  decidedDate: string;
  sourceUrl: string;
  chapters: Chapter[];
}

export interface RecentOpinion {
  title: string;
  date: string;
  docketNumber: string;
  pdfUrl: string;
  term: string;
  filename: string;
}
