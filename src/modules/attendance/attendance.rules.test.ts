import { describe, expect, it } from 'vitest';
import type { CalendarRuleEvent } from '../calendar/calendar.rules.js';
import {
  attendancePercent,
  countEntries,
  sectionOnDate,
  studentDays,
  summarize,
  type AttendanceStatus,
  type HistorySpan,
} from './attendance.rules.js';

/*
 * The same cases are in the app (__tests__/attendanceRules.test.ts), so the phone and the
 * server always agree.
 */

const SUNDAY = [0];
const holidays: CalendarRuleEvent[] = [
  { type: 'HOLIDAY', name: 'Iqbal Day', startDate: '2026-11-09', endDate: '2026-11-09' },
  { type: 'HOLIDAY', name: 'Quaid Day', startDate: '2026-11-25', endDate: '2026-11-25' },
];
const inFiveA: HistorySpan[] = [
  { sectionId: '5A', startDate: '2026-04-05', endDate: null, sectionChanges: [] },
];

/** 5-A sheets for 1–26 Nov: every working day except 19 Nov; Ali's special days. */
function novemberSheets() {
  const special: Record<string, AttendanceStatus> = {
    '2026-11-04': 'ABSENT',
    '2026-11-18': 'ABSENT',
    '2026-11-10': 'LEAVE',
    '2026-11-12': 'LATE',
  };
  const dates = new Map<string, { studentId: string; status: AttendanceStatus }[]>();
  for (let d = 1; d <= 26; d += 1) {
    const date = `2026-11-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    if (['2026-11-09', '2026-11-25', '2026-11-19'].includes(date)) continue;
    dates.set(date, [{ studentId: 'ali', status: special[date] ?? 'PRESENT' }]);
  }
  return new Map([['5A', dates]]);
}

describe('attendance rules (shared with the app)', () => {
  it('Ali Raza, 1–26 Nov 2026 → 20 working days, 19 counted, 84%', () => {
    const days = studentDays('2026-11-01', '2026-11-26', inFiveA, 'ali', novemberSheets());
    expect(summarize(days, SUNDAY, holidays)).toEqual({
      workingDays: 20,
      counted: 19,
      notMarked: 1,
      present: 15,
      late: 1,
      absent: 2,
      leave: 1,
      percent: 84,
    });
  });

  it('a sheet on a day that became a holiday is not counted', () => {
    const days = studentDays('2026-11-01', '2026-11-26', inFiveA, 'ali', novemberSheets());
    const rain: CalendarRuleEvent = {
      type: 'HOLIDAY',
      name: 'Rain day',
      startDate: '2026-11-04',
      endDate: '2026-11-04',
    };
    expect(summarize(days, SUNDAY, [...holidays, rain])).toMatchObject({
      counted: 18,
      absent: 1,
      percent: 89,
    });
  });

  it('nothing counted shows "—" (null); late counts as present, leave does not', () => {
    expect(attendancePercent(0, 0)).toBeNull();
    expect(attendancePercent(2, 3)).toBe(67);
    expect(countEntries([{ status: 'PRESENT' }, { status: 'LATE' }, { status: 'LEAVE' }])).toEqual({
      present: 1,
      absent: 0,
      leave: 1,
      late: 1,
      total: 3,
    });
  });

  it('knows the section on a date: admission, section change, withdrawal, promotion', () => {
    const history: HistorySpan[] = [
      {
        sectionId: '5B',
        startDate: '2026-04-05',
        endDate: '2027-03-31',
        sectionChanges: [{ fromSectionId: '5A', toSectionId: '5B', date: '2026-11-16' }],
      },
      { sectionId: '6A', startDate: '2027-04-01', endDate: '2027-05-10', sectionChanges: [] },
    ];
    expect(sectionOnDate(history, '2026-04-04')).toBeNull(); // before admission
    expect(sectionOnDate(history, '2026-11-15')).toBe('5A');
    expect(sectionOnDate(history, '2026-11-16')).toBe('5B'); // from the change date
    expect(sectionOnDate(history, '2027-04-01')).toBe('6A');
    expect(sectionOnDate(history, '2027-05-10')).toBe('6A'); // withdrawal day still counts
    expect(sectionOnDate(history, '2027-05-11')).toBeNull();
  });
});
