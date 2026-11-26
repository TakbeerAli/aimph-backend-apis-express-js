import { describe, expect, it } from 'vitest';
import {
  dayInfo,
  eachDay,
  getWorkingDays,
  isWorkingDay,
  monthRange,
  weekdayOf,
  type CalendarRuleEvent,
} from './calendar.rules.js';

const SUNDAY = [0];
const holiday = (name: string, startDate: string, endDate = startDate): CalendarRuleEvent => ({
  type: 'HOLIDAY',
  name,
  startDate,
  endDate,
});
const makeUp = (name: string, date: string): CalendarRuleEvent => ({
  type: 'WORKING_DAY',
  name,
  startDate: date,
  endDate: date,
});

describe('calendar rules (shared with the app)', () => {
  it('knows weekdays and month lengths', () => {
    expect(weekdayOf('2026-11-01')).toBe(0); // Sunday
    expect(weekdayOf('2026-11-26')).toBe(4); // Thursday
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(eachDay('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
  });

  it('1–26 Nov 2026, Sundays off, holidays 9 and 25 Nov: 20 working days (Ali Raza example)', () => {
    const events = [holiday('Iqbal Day', '2026-11-09'), holiday('Quaid Day', '2026-11-25')];
    const days = getWorkingDays('2026-11-01', '2026-11-26', SUNDAY, events);
    expect(days).toHaveLength(20);
    expect(days).not.toContain('2026-11-08'); // Sunday
    expect(days).not.toContain('2026-11-09'); // holiday
    expect(days).toContain('2026-11-19'); // a working day ("not marked" is decided later)
  });

  it('a weekend date made a working day counts; a holiday always wins', () => {
    const events = [makeUp('Make-up for flood day', '2026-11-15')];
    expect(isWorkingDay('2026-11-15', SUNDAY, events)).toBe(true);
    expect(dayInfo('2026-11-15', SUNDAY, events)).toMatchObject({
      type: 'WORKING',
      isException: true,
      names: ['Make-up for flood day'],
    });
    const both = [...events, holiday('Winter vacation', '2026-11-14', '2026-11-16')];
    expect(dayInfo('2026-11-15', SUNDAY, both)).toMatchObject({
      type: 'HOLIDAY',
      names: ['Winter vacation'],
    });
  });

  it('uses any weekly off days, and ignores deleted events', () => {
    const satSun = [6, 0];
    expect(dayInfo('2026-11-28', satSun, []).type).toBe('WEEKEND'); // Saturday
    expect(dayInfo('2026-11-28', SUNDAY, []).type).toBe('WORKING');
    const deleted = { ...holiday('Cancelled', '2026-11-10'), isDeleted: true };
    expect(isWorkingDay('2026-11-10', SUNDAY, [deleted])).toBe(true);
  });

  it('a holiday range covers every day in it', () => {
    const winter = holiday('Winter vacation', '2026-12-20', '2026-12-31');
    // December 2026: 1–19 Dec are 19 days with 2 Sundays (6, 13); 20–31 Dec are holiday.
    expect(getWorkingDays('2026-12-01', '2026-12-31', SUNDAY, [winter])).toHaveLength(17);
    expect(dayInfo('2026-12-31', SUNDAY, [winter]).names).toEqual(['Winter vacation']);
  });
});
