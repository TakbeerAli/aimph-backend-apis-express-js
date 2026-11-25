/*
 * Dates in words for certificates: 12 Mar 2016 → "Twelfth March, Two Thousand Sixteen".
 * Date-only values are stored as UTC midnight (see dates.ts), so the UTC parts are the
 * calendar date and the server's time zone cannot shift the day.
 */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const ORDINAL_ONES = [
  '',
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Ninth',
  'Tenth',
  'Eleventh',
  'Twelfth',
  'Thirteenth',
  'Fourteenth',
  'Fifteenth',
  'Sixteenth',
  'Seventeenth',
  'Eighteenth',
  'Nineteenth',
];
const ORDINAL_TENS: Record<number, string> = { 2: 'Twentieth', 3: 'Thirtieth' };

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 0–99 in words: 16 → "Sixteen", 31 → "Thirty-One". */
function underHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const ones = n % 10;
  const tens = TENS[Math.floor(n / 10)] ?? '';
  return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
}

/** 1–9999 in words, British school style without "and": 2016 → "Two Thousand Sixteen". */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 9999) {
    throw new RangeError(`numberToWords supports 1–9999, got ${n}`);
  }
  const parts: string[] = [];
  const thousands = Math.floor(n / 1000);
  const hundreds = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (thousands) parts.push(`${ONES[thousands]} Thousand`);
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(underHundred(rest));
  return parts.join(' ');
}

/** Day of the month as an ordinal: 1 → "First", 21 → "Twenty-First", 30 → "Thirtieth". */
export function dayToOrdinalWords(day: number): string {
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new RangeError(`Day must be 1–31, got ${day}`);
  }
  if (day < 20) return ORDINAL_ONES[day] ?? '';
  const ones = day % 10;
  const tens = Math.floor(day / 10);
  return ones === 0 ? (ORDINAL_TENS[tens] ?? '') : `${TENS[tens]}-${ORDINAL_ONES[ones]}`;
}

/** 12 Mar 2016 → "Twelfth March, Two Thousand Sixteen". Accepts a Date or "YYYY-MM-DD". */
export function dateToWords(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00.000Z`) : date;
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid date');
  return `${dayToOrdinalWords(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}, ${numberToWords(
    d.getUTCFullYear(),
  )}`;
}
