import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  admit,
  bearer,
  login,
  resetDatabase,
  setupSchool,
  studentBody,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { Settings } from '../settings/settings.model.js';
import { backfillAdmissionClass } from './students.migrations.js';
import { Student } from './students.model.js';

/** Certificates module, stage C1: new student and settings fields. */
describe('certificate fields (C1)', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let tokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    tokens = await login(app, school.admin);
  });

  const placement = () => ({ classId: school.class5Id, sectionId: school.s5A });

  it('stores religion, nationality and place of birth; nationality defaults to Pakistani', async () => {
    const res = await request(app)
      .post('/api/v1/students')
      .set('Authorization', bearer(tokens))
      .send(studentBody(placement(), { religion: 'Islam', placeOfBirth: 'Rawalpindi' }));
    expect(res.status).toBe(201);
    expect(res.body.data.student).toMatchObject({
      religion: 'Islam',
      nationality: 'Pakistani',
      placeOfBirth: 'Rawalpindi',
      // Admitted to Class 5 now, so that is the admission class.
      admissionClassId: school.class5Id,
    });
  });

  it('keeps an earlier admission class for old records', async () => {
    const res = await request(app)
      .post('/api/v1/students')
      .set('Authorization', bearer(tokens))
      .send(studentBody(placement(), { admissionClassId: school.class6Id }));
    expect(res.status).toBe(201);
    expect(res.body.data.student.admissionClassId).toBe(school.class6Id);

    const bad = await request(app)
      .post('/api/v1/students')
      .set('Authorization', bearer(tokens))
      .send(studentBody(placement(), { admissionClassId: 'no-such-class' }));
    expect(bad.status).toBe(400);
  });

  it('edits and clears the new fields', async () => {
    const student = await admit(school.actor, placement(), { religion: 'Islam' });
    const res = await request(app)
      .patch(`/api/v1/students/${student._id}`)
      .set('Authorization', bearer(tokens))
      .send({ version: student.version, religion: null, nationality: 'Afghan' });
    expect(res.status).toBe(200);
    expect(res.body.data.religion).toBeUndefined();
    expect(res.body.data.nationality).toBe('Afghan');

    const tooLong = await request(app)
      .patch(`/api/v1/students/${student._id}`)
      .set('Authorization', bearer(tokens))
      .send({ version: res.body.data.version, placeOfBirth: 'x'.repeat(61) });
    expect(tooLong.status).toBe(400);
  });

  it('the migration fills admissionClassId from the first class-history entry', async () => {
    const student = await admit(school.actor, placement());
    // A record made before the field existed.
    await Student.collection.updateOne({ _id: student._id } as never, {
      $unset: { admissionClassId: '' },
    });
    const before = await Student.findById(student._id);

    const dry = await backfillAdmissionClass({ dryRun: true });
    expect(dry).toMatchObject({ checked: 1, updated: 1 });
    expect((await Student.findById(student._id))?.admissionClassId).toBeUndefined();

    const run = await backfillAdmissionClass();
    expect(run).toMatchObject({ updated: 1 });
    const after = await Student.findById(student._id);
    expect(after?.admissionClassId).toBe(school.class5Id);
    // Saved through the sync plugin, so phones pull the change.
    expect(after?.version).toBe((before?.version ?? 0) + 1);

    expect(await backfillAdmissionClass()).toMatchObject({ updated: 0, alreadySet: 1 });
  });

  it('settings have certificate defaults; counters stay private', async () => {
    const res = await request(app).get('/api/v1/settings').set('Authorization', bearer(tokens));
    expect(res.body.data.certificate).toEqual({
      principalName: '',
      designation: 'Principal',
      signatureUrl: null,
      stampUrl: null,
      printSignature: true,
      version: 1,
    });
    expect(res.body.data.counters).toBeUndefined();

    // Certificate counters are created by the first atomic $inc.
    await Settings.collection.updateOne({ _id: 'school' } as never, {
      $inc: { 'counters.certificates.SLC-2026': 1 },
    });
    const doc = await Settings.collection.findOne({ _id: 'school' } as never);
    expect(doc?.counters.certificates['SLC-2026']).toBe(1);
  });
});
