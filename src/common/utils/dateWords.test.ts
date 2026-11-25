import { describe, expect, it } from 'vitest';
import { dateOnly } from './dates.js';
import { dateToWords, dayToOrdinalWords, numberToWords } from './dateWords.js';

describe('dateToWords (certificates)', () => {
  it('writes the dates from the specification', () => {
    expect(dateToWords(dateOnly('2016-03-12'))).toBe('Twelfth March, Two Thousand Sixteen');
    expect(dateToWords(dateOnly('2000-01-01'))).toBe('First January, Two Thousand');
    expect(dateToWords(dateOnly('2019-12-31'))).toBe(
      'Thirty-First December, Two Thousand Nineteen',
    );
  });

  it('writes the dates on the design', () => {
    expect(dateToWords('2016-06-08')).toBe('Eighth June, Two Thousand Sixteen');
    expect(dateToWords('2016-09-02')).toBe('Second September, Two Thousand Sixteen');
  });

  it('reads the calendar date, whatever the server time zone', () => {
    // Stored as UTC midnight; in Pakistan (UTC+5) that is still 12 March.
    expect(dateToWords(new Date('2016-03-12T00:00:00.000Z'))).toMatch(/^Twelfth March/);
  });

  it('covers every day of a month', () => {
    expect(dayToOrdinalWords(1)).toBe('First');
    expect(dayToOrdinalWords(11)).toBe('Eleventh');
    expect(dayToOrdinalWords(20)).toBe('Twentieth');
    expect(dayToOrdinalWords(22)).toBe('Twenty-Second');
    expect(dayToOrdinalWords(30)).toBe('Thirtieth');
    expect(() => dayToOrdinalWords(32)).toThrow(RangeError);
  });

  it('writes years from earlier centuries', () => {
    expect(numberToWords(1999)).toBe('One Thousand Nine Hundred Ninety-Nine');
    expect(numberToWords(2010)).toBe('Two Thousand Ten');
    expect(numberToWords(2105)).toBe('Two Thousand One Hundred Five');
  });

  it('rejects an invalid date', () => {
    expect(() => dateToWords('not-a-date')).toThrow(RangeError);
  });
});
