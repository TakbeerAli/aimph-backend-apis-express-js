import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  admit,
  bearer,
  createUser,
  login,
  resetDatabase,
  setupSchool,
  type Tokens,
} from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { SchoolClass } from './classes.model.js';

const api = '/api/v1/classes';

describe('classes and sections', () => {
  let app: ReturnType<typeof createApp>;
  let school: Awaited<ReturnType<typeof setupSchool>>;
  let adminTokens: Tokens;
  let staffTokens: Tokens;

  beforeEach(async () => {
    await resetDatabase();
    app = createApp();
    school = await setupSchool();
    adminTokens = await login(app, school.admin);
    staffTokens = await login(app, await createUser());
  });

  const as = (tokens: Tokens) => ({
    get: (path: string) => request(app).get(path).set('Authorization', bearer(tokens)),
    post: (path: string, body: object) =>
      request(app).post(path).set('Authorization', bearer(tokens)).send(body),
    patch: (path: string, body: object) =>
      request(app).patch(path).set('Authorization', bearer(tokens)).send(body),
  });

  it('lists classes by sortOrder with active student counts', async () => {
    await admit(school.actor, { classId: school.class5Id, sectionId: school.s5A });
    await admit(school.actor, { classId: school.class5Id, sectionId: school.s5A });
    await admit(school.actor, { classId: school.class5Id, sectionId: school.s5B });

    const res = await as(staffTokens).get(api);

    expect(res.status).toBe(200);
    const [class5, class6] = res.body.data;
    expect(class5).toMatchObject({ name: 'Class 5', activeStudents: 3 });
    expect(class5.sections).toEqual([
      expect.objectContaining({ name: 'A', activeStudents: 2 }),
      expect.objectContaining({ name: 'B', activeStudents: 1 }),
    ]);
    expect(class6.activeStudents).toBe(0);
  });

  it('Admin creates a class; Staff cannot', async () => {
    const body = { name: 'Class 7', sortOrder: 10, sections: ['a', 'B'] };

    expect((await as(staffTokens).post(api, body)).status).toBe(403);
    const res = await as(adminTokens).post(api, body);
    expect(res.status).toBe(201);
    expect(res.body.data.sections.map((s: { name: string }) => s.name)).toEqual(['A', 'B']);
  });

  it('rejects duplicate section names, a self link and an unknown next class', async () => {
    expect(
      (await as(adminTokens).post(api, { name: 'X', sortOrder: 1, sections: ['A', 'a'] })).status,
    ).toBe(400);
    expect(
      (await as(adminTokens).patch(`${api}/${school.class5Id}`, { nextClassId: school.class5Id }))
        .status,
    ).toBe(400);
    expect(
      (await as(adminTokens).patch(`${api}/${school.class5Id}`, { nextClassId: 'nope' })).status,
    ).toBe(400);
  });

  it('adds, renames and deactivates a section', async () => {
    const added = await as(adminTokens).post(`${api}/${school.class5Id}/sections`, { name: 'c' });
    expect(added.status).toBe(201);
    const sectionC = added.body.data.sections.find((s: { name: string }) => s.name === 'C');

    expect(
      (await as(adminTokens).post(`${api}/${school.class5Id}/sections`, { name: 'A' })).status,
    ).toBe(409);
    expect(
      (
        await as(adminTokens).patch(`${api}/${school.class5Id}/sections/${sectionC._id}`, {
          name: 'B',
        })
      ).status,
    ).toBe(409);

    const renamed = await as(adminTokens).patch(
      `${api}/${school.class5Id}/sections/${sectionC._id}`,
      { name: 'D', isActive: false },
    );
    expect(renamed.status).toBe(200);
    const stored = await SchoolClass.findById(school.class5Id).lean();
    expect(stored?.sections.find((s) => s._id === sectionC._id)).toMatchObject({
      name: 'D',
      isActive: false,
    });
  });

  it('a class or section with active students cannot be deactivated', async () => {
    await admit(school.actor, { classId: school.class5Id, sectionId: school.s5A });

    const cls = await as(adminTokens).patch(`${api}/${school.class5Id}`, { isActive: false });
    const section = await as(adminTokens).patch(
      `${api}/${school.class5Id}/sections/${school.s5A}`,
      { isActive: false },
    );
    const emptySection = await as(adminTokens).patch(
      `${api}/${school.class5Id}/sections/${school.s5B}`,
      { isActive: false },
    );

    expect(cls.status).toBe(409);
    expect(section.status).toBe(409);
    expect(emptySection.status).toBe(200);
  });
});
