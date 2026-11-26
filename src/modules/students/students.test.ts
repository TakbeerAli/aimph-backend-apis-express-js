import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  admit,
  bearer,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  studentBody,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { Settings } from '../settings/settings.model.js';
import { Student } from './students.model.js';

const api = '/api/v1/students';

describe('students', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;
  let staffTokens: Tokens;
  let in5A: { classId: string; sectionId: string };

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    in5A = { classId: school.class5Id, sectionId: school.s5A };
    adminTokens = await login(app, school.admin);
    staffTokens = await login(app, await createUser());
  });

  const as = (tokens: Tokens) => ({
    get: (path: string) => request(app).get(path).set('Authorization', bearer(tokens)),
    post: (path: string, body: unknown) =>
      request(app)
        .post(path)
        .set('Authorization', bearer(tokens))
        .send(body as object),
    patch: (path: string, body: object) =>
      request(app).patch(path).set('Authorization', bearer(tokens)).send(body),
  });

  describe('admission (POST /students)', () => {
    it('creates the student with admission no. 1001, first history entry and audit', async () => {
      const res = await as(adminTokens).post(api, studentBody(in5A, { rollNo: 12 }));

      expect(res.status).toBe(201);
      const { student, duplicate } = res.body.data;
      expect(duplicate).toBe(false);
      expect(student).toMatchObject({
        admissionNo: 1001,
        status: 'ACTIVE',
        dateOfBirth: '2015-05-10T00:00:00.000Z',
        current: { sessionId: school.sessionId, ...in5A, rollNo: 12 },
        classHistory: [
          {
            sessionId: school.sessionId,
            ...in5A,
            rollNo: 12,
            entryType: 'NEW_ADMISSION',
            outcome: 'IN_PROGRESS',
            startDate: '2026-04-05T00:00:00.000Z',
            endDate: null,
            sectionChanges: [],
          },
        ],
        withdrawal: null,
        version: 1,
      });
      expect(student.searchText).toBe('ali raza ahmed raza 1001 0345-1112233 03451112233');
      expect(await AuditLog.countDocuments({ action: 'STUDENT_CREATE' })).toBe(1);
    });

    it('charges the admission voucher with amounts the Admin changed, or none', async () => {
      const changed = await as(adminTokens).post(
        api,
        studentBody(in5A, { admissionFees: { tuitionFee: 1500, admissionFee: 0 } }),
      );
      expect(changed.status).toBe(201);
      const { voucher, student } = changed.body.data;
      expect(voucher.lines).toEqual([expect.objectContaining({ code: 'TUITION', amount: 1500 })]);
      expect(voucher.totalAmount).toBe(1500);
      expect(student).not.toHaveProperty('admissionFees');

      const free = await as(adminTokens).post(
        api,
        studentBody(in5A, { admissionFees: { tuitionFee: 0, admissionFee: 0 } }),
      );
      expect(free.status).toBe(201);
      expect(free.body.data.voucher).toBeNull();

      const bad = await as(adminTokens).post(
        api,
        studentBody(in5A, { admissionFees: { tuitionFee: -1, admissionFee: 0 } }),
      );
      expect(bad.status).toBe(400);
    });

    it('Staff cannot admit students', async () => {
      expect((await as(staffTokens).post(api, studentBody(in5A))).status).toBe(403);
    });

    it('validates input and placement', async () => {
      const bad = await as(adminTokens).post(
        api,
        studentBody(in5A, { gender: 'X', bFormNo: '123' }),
      );
      expect(bad.status).toBe(400);

      const wrongSection = await as(adminTokens).post(
        api,
        studentBody({ classId: school.class5Id, sectionId: school.s6A }),
      );
      expect(wrongSection.status).toBe(400);
    });

    it('accepts an unused offline admission number and continues after it', async () => {
      const offline = await as(adminTokens).post(api, studentBody(in5A, { admissionNo: 1050 }));
      expect(offline.status).toBe(201);
      expect(offline.body.data.student.admissionNo).toBe(1050);

      const next = await as(adminTokens).post(api, studentBody(in5A));
      expect(next.body.data.student.admissionNo).toBe(1051);

      const reused = await as(adminTokens).post(api, studentBody(in5A, { admissionNo: 1050 }));
      expect(reused.status).toBe(409);
    });

    it('returns the existing student when the same _id is sent again', async () => {
      const body = studentBody(in5A, { _id: '01900000-0000-7000-8000-000000000001' });
      const first = await as(adminTokens).post(api, body);
      const second = await as(adminTokens).post(api, body);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.data.duplicate).toBe(true);
      expect(second.body.data.student.admissionNo).toBe(first.body.data.student.admissionNo);
      expect(await Student.countDocuments()).toBe(1);
    });

    it('gives unique admission numbers to concurrent admissions (#17)', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => admit(school.actor, in5A)),
      );

      const numbers = results.map((s) => s.admissionNo).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => 1001 + i));
      const settings = await Settings.findById(SETTINGS_ID).lean();
      expect(settings?.counters.admissionNo).toBe(1010);
    });

    it('keeps roll numbers unique within a section', async () => {
      await admit(school.actor, in5A, { rollNo: 7 });

      const clash = await as(adminTokens).post(api, studentBody(in5A, { rollNo: 7 }));
      expect(clash.status).toBe(409);
      const otherSection = await as(adminTokens).post(
        api,
        studentBody({ classId: school.class5Id, sectionId: school.s5B }, { rollNo: 7 }),
      );
      expect(otherSection.status).toBe(201);
    });
  });

  describe('search and view', () => {
    beforeEach(async () => {
      await admit(school.actor, in5A, { fullName: 'Ali Raza' });
      await admit(school.actor, in5A, {
        fullName: 'Sara Khan',
        gender: 'FEMALE',
        guardian: { fatherName: 'Imran Khan', relation: 'FATHER', phone: '0300-5556677' },
      });
      await admit(
        school.actor,
        { classId: school.class6Id, sectionId: school.s6A },
        {
          fullName: 'Bilal Ahmed',
          guardian: { fatherName: 'Raza Ahmed', relation: 'FATHER', phone: '0333-9998877' },
        },
      );
    });

    const names = (res: request.Response) =>
      (res.body.data.items as { fullName: string }[]).map((s) => s.fullName);

    it.each([
      ['raza', ['Ali Raza', 'Bilal Ahmed']], // name and father name
      ['imran', ['Sara Khan']],
      ['1003', ['Bilal Ahmed']],
      ['03005556677', ['Sara Khan']], // phone without dashes
      ['0333-999', ['Bilal Ahmed']],
      ['ali raza', ['Ali Raza']], // every word must match
    ])('q=%s', async (q, expected) => {
      const res = await as(staffTokens).get(`${api}?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(names(res)).toEqual(expected);
    });

    it('filters by class and status, and pages', async () => {
      const byClass = await as(staffTokens).get(`${api}?classId=${school.class5Id}&sort=-fullName`);
      expect(names(byClass)).toEqual(['Sara Khan', 'Ali Raza']);

      const page2 = await as(staffTokens).get(`${api}?limit=2&page=2`);
      expect(page2.body.data).toMatchObject({ page: 2, limit: 2, total: 3 });
      expect(names(page2)).toEqual(['Bilal Ahmed']);

      const withdrawn = await as(staffTokens).get(`${api}?status=WITHDRAWN`);
      expect(withdrawn.body.data.total).toBe(0);
    });

    it('treats regex characters in q as plain text', async () => {
      const res = await as(staffTokens).get(`${api}?q=${encodeURIComponent('.*')}`);
      expect(res.body.data.total).toBe(0);
    });

    it('GET /students/:id returns the profile, or 404', async () => {
      const student = await Student.findOne({ admissionNo: 1001 }).lean();
      const ok = await as(staffTokens).get(`${api}/${student?._id}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data.fullName).toBe('Ali Raza');
      expect((await as(staffTokens).get(`${api}/missing`)).status).toBe(404);
    });
  });

  describe('edit (PATCH /students/:id)', () => {
    it('updates personal and guardian fields and bumps the version', async () => {
      const student = await admit(school.actor, in5A, { bFormNo: '12345-1234567-1' });

      const res = await as(adminTokens).patch(`${api}/${student._id}`, {
        version: 1,
        fullName: 'Ali Raza Khan',
        bFormNo: null,
        guardian: { phone: '0311-2223344' },
        current: { classId: school.class6Id }, // not editable here: stripped
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        fullName: 'Ali Raza Khan',
        version: 2,
        guardian: { fatherName: 'Ahmed Raza', phone: '0311-2223344' },
        current: { classId: school.class5Id },
      });
      expect(res.body.data.bFormNo).toBeUndefined();
      expect(res.body.data.searchText).toContain('03112223344');

      const audit = await AuditLog.findOne({ action: 'STUDENT_UPDATE' }).lean();
      expect(audit?.before).toMatchObject({ fullName: 'Ali Raza', bFormNo: '12345-1234567-1' });
      expect(audit?.after).toMatchObject({ fullName: 'Ali Raza Khan' });
    });

    it('returns VERSION_CONFLICT with the server copy for an old version (#20)', async () => {
      const student = await admit(school.actor, in5A);
      await as(adminTokens).patch(`${api}/${student._id}`, { version: 1, address: 'New address' });

      const stale = await as(adminTokens).patch(`${api}/${student._id}`, {
        version: 1,
        fullName: 'Lost edit',
      });

      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect(stale.body.error.details.current).toMatchObject({
        version: 2,
        address: 'New address',
        fullName: 'Ali Raza',
      });
    });

    it('requires a version and is Admin only', async () => {
      const student = await admit(school.actor, in5A);
      expect((await as(adminTokens).patch(`${api}/${student._id}`, { fullName: 'X' })).status).toBe(
        400,
      );
      expect(
        (await as(staffTokens).patch(`${api}/${student._id}`, { version: 1, fullName: 'X' }))
          .status,
      ).toBe(403);
    });
  });

  describe('change section', () => {
    it('moves the student, records the change in history and drops the old roll no.', async () => {
      const student = await admit(school.actor, in5A, { rollNo: 12 });

      const res = await as(adminTokens).post(`${api}/${student._id}/change-section`, {
        toSectionId: school.s5B,
        date: '2026-08-01',
        reason: 'Parent request',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.current).toEqual({
        sessionId: school.sessionId,
        classId: school.class5Id,
        sectionId: school.s5B,
      });
      expect(res.body.data.classHistory).toHaveLength(1);
      expect(res.body.data.classHistory[0]).toMatchObject({
        sectionId: school.s5B,
        sectionChanges: [
          {
            fromSectionId: school.s5A,
            toSectionId: school.s5B,
            date: '2026-08-01T00:00:00.000Z',
            by: school.admin._id,
            reason: 'Parent request',
          },
        ],
      });
      expect(await AuditLog.countDocuments({ action: 'SECTION_CHANGE' })).toBe(1);
    });

    it('rejects another class, the same section, and non-active students', async () => {
      const student = await admit(school.actor, in5A);
      const change = (toSectionId: string) =>
        as(adminTokens).post(`${api}/${student._id}/change-section`, {
          toSectionId,
          reason: 'Testing',
        });

      expect((await change(school.s6A)).status).toBe(400);
      expect((await change(school.s5A)).status).toBe(400);

      await Student.updateOne({ _id: student._id }, { $set: { status: 'WITHDRAWN' } });
      const withdrawn = await change(school.s5B);
      expect(withdrawn.status).toBe(422);
      expect(withdrawn.body.error.code).toBe('STUDENT_NOT_ACTIVE');
    });
  });

  describe('import (POST /students/import)', () => {
    it('creates all rows with sequential admission numbers', async () => {
      const rows = [
        studentBody(in5A, { fullName: 'Row One', rollNo: 1 }),
        studentBody(in5A, { fullName: 'Row Two', admissionNo: 2000 }),
        studentBody(in5A, { fullName: 'Row Three' }),
      ];

      const res = await as(adminTokens).post(`${api}/import`, rows);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ created: 3, errors: [] });
      const stored = await Student.find().sort({ admissionNo: 1 }).lean();
      expect(stored.map((s) => [s.fullName, s.admissionNo])).toEqual([
        ['Row Two', 2000],
        ['Row One', 2001],
        ['Row Three', 2002],
      ]);
      expect(stored.every((s) => s.searchText.includes('ahmed raza'))).toBe(true);
      expect(await AuditLog.countDocuments({ action: 'STUDENTS_IMPORT' })).toBe(1);
    });

    it('saves nothing and lists every bad row when any row is invalid', async () => {
      await admit(school.actor, in5A, { rollNo: 3 }); // takes 1001 and roll 3 in 5-A
      const rows = [
        studentBody(in5A, { fullName: 'Good' }),
        studentBody(in5A, { gender: 'UNKNOWN' }),
        studentBody(in5A, { admissionNo: 1001 }),
        studentBody(in5A, { rollNo: 3 }),
        studentBody({ classId: school.class5Id, sectionId: 'nope' }),
        studentBody(in5A, { admissionNo: 3000 }),
        studentBody(in5A, { admissionNo: 3000 }),
      ];

      const res = await as(adminTokens).post(`${api}/import`, rows);

      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(0);
      expect(res.body.data.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4, 5, 7]);
      expect(res.body.data.errors[0].message).toMatch(/gender/);
      expect(await Student.countDocuments()).toBe(1);
    });

    it('is Admin only', async () => {
      expect((await as(staffTokens).post(`${api}/import`, [studentBody(in5A)])).status).toBe(403);
    });
  });
});
