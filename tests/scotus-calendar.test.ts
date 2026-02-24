import { describe, it, expect } from 'vitest';
import { parseConferenceDays, toEasternTime } from '../src/lib/scotus-calendar';

describe('parseConferenceDays', () => {
  it('extracts conference days from specialDaysArray', () => {
    const html = `
      <script>
      var defined = [[2025,5,2,"Conference Day"],[2025,5,9,"Non-argument Day"],[2025,5,15,"Conference Day"]]
      </script>
    `;
    expect(parseConferenceDays(html)).toEqual([2, 15]);
  });

  it('matches "Conference/Non-argument Day" label', () => {
    const html = `
      var defined = [[2025,6,12,"Conference/Non-argument Day"],[2025,6,19,"Argument Day"]]
    `;
    expect(parseConferenceDays(html)).toEqual([12]);
  });

  it('returns empty array when no match found', () => {
    expect(parseConferenceDays('<html>no calendar here</html>')).toEqual([]);
  });

  it('returns empty array when no conference days in calendar', () => {
    const html = `var defined = [[2025,7,1,"Argument Day"],[2025,7,8,"Non-argument Day"]]`;
    expect(parseConferenceDays(html)).toEqual([]);
  });

  it('handles specialDaysArray variable name', () => {
    const html = `specialDaysArray = [[2025,3,10,"Conference Day"]]`;
    expect(parseConferenceDays(html)).toEqual([10]);
  });
});

describe('toEasternTime', () => {
  it('converts UTC to EST (winter)', () => {
    // Jan 15, 2025 at 3pm UTC = 10am EST
    const date = new Date(Date.UTC(2025, 0, 15, 15, 0, 0));
    const et = toEasternTime(date);
    expect(et.hours).toBe(10);
    expect(et.minutes).toBe(0);
    expect(et.dayOfMonth).toBe(15);
  });

  it('converts UTC to EDT (summer)', () => {
    // Jun 15, 2025 at 2pm UTC = 10am EDT
    const date = new Date(Date.UTC(2025, 5, 15, 14, 0, 0));
    const et = toEasternTime(date);
    expect(et.hours).toBe(10);
    expect(et.minutes).toBe(0);
    expect(et.dayOfMonth).toBe(15);
  });

  it('handles day boundary crossing', () => {
    // Jan 1, 2025 at 3am UTC = Dec 31 at 10pm EST
    const date = new Date(Date.UTC(2025, 0, 1, 3, 0, 0));
    const et = toEasternTime(date);
    expect(et.hours).toBe(22);
    expect(et.dayOfMonth).toBe(31);
    expect(et.month).toBe(11); // December
    expect(et.year).toBe(2024);
  });
});
