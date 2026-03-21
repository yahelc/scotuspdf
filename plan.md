# Plan: Reading Time Estimates per Chapter (#37)

## Goal
Show estimated reading time (e.g. "~18 min") for each chapter in the chapter navigation dropdown. Helps readers plan their time across lengthy SCOTUS opinions.

## Approach

Compute word counts at parse time (server-side), store on the `Chapter` object, and display in the existing chapter nav UI. No new dependencies needed.

## Changes

### 1. Add `wordCount` field to `Chapter` interface
**File:** `src/lib/types.ts`

Add `wordCount: number` to the `Chapter` interface. Store raw word count rather than pre-computed minutes so consumers can use any WPM rate.

### 2. Count words during parsing
**File:** `src/lib/parser.ts`

Add a `countWords(paragraphs: Paragraph[]): number` helper that:
- Iterates each paragraph's `.text`
- Strips tagged markers (`{{bp:…}}`, `{{bpj:…}}`, `{{fn:N}}`) so boilerplate and footnote refs don't inflate the count
- Splits on whitespace and sums the total
- Also counts words in `chapter.footnotes[].text` (footnotes are real content readers consume)

Call it when building each chapter object (~line 890-914) and assign the result to `chapter.wordCount`.

### 3. Display reading time in chapter nav dropdown
**File:** `src/components/Reader.svelte`

Add a small helper: `readingTime(wordCount: number): string` that divides by 250 WPM (per issue spec), rounds up, and returns `"~N min"` (or `"< 1 min"` for very short chapters).

In the chapter nav button (lines ~700-711), render the reading time as a new `<span class="chapter-time">` alongside the existing title and author spans. Style it in muted secondary text, right-aligned or inline after the author.

### 4. Show total reading time for the full opinion
In the chapter nav header area, display the sum of all chapter reading times as a total (e.g. "~72 min total"). This gives readers an at-a-glance sense of the full opinion's length.

## Files Modified
| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `wordCount: number` to `Chapter` |
| `src/lib/parser.ts` | Add `countWords()` helper, call it when building chapters |
| `src/components/Reader.svelte` | Add `readingTime()` helper, display in chapter nav + total |

## Testing
- Run `npm test` to verify parser tests still pass
- Manually test against the reference opinions listed in CLAUDE.md (23-939, 24-1287, 24-808) to confirm reasonable reading time numbers appear in the chapter nav
