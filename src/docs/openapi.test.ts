import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bearer, createUser, login, resetDatabase } from '../../test/helpers.js';
import { createApp } from '../app.js';

const app = createApp();

describe('API docs', () => {
  it('serves the OpenAPI document with every endpoint from Section 7', async () => {
    const res = await request(app).get('/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const operations = Object.values(res.body.paths as Record<string, object>).reduce<number>(
      (n, ops) => n + Object.keys(ops).length,
      0,
    );
    // 58 from Section 7, plus 4 for Admin set-up (logo get/put/delete, setup status).
    expect(operations).toBe(73);
    // Request schemas come from the Zod schemas used for validation.
    const login = res.body.paths['/auth/login'].post;
    expect(login.requestBody.content['application/json'].schema.required).toEqual([
      'username',
      'password',
      'deviceCode',
    ]);
    expect(res.body.paths['/payments'].post.security).toEqual([{ bearerAuth: [] }]);
  });

  it('every documented path is a real route', async () => {
    await resetDatabase();
    // Logged in as Admin, so requests reach the router instead of stopping at 401.
    const tokens = await login(app, await createUser({ role: 'ADMIN' }));
    const doc = (await request(app).get('/docs/openapi.json')).body as {
      paths: Record<string, Record<string, unknown>>;
    };

    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        if (path === '/auth/logout') continue; // would end this test's session
        const url = `/api/v1${path.replace(/\{\w+\}/g, 'x')}`;
        const res = await request(app)[method as 'get'](url).set('Authorization', bearer(tokens));
        // Real routes answer (often 400/404 from validation or lookups); unknown ones say so.
        expect(res.body.error?.message ?? '', `${method.toUpperCase()} ${path}`).not.toMatch(
          /^Route .* not found/,
        );
      }
    }
    expect(
      (await request(app).get('/api/v1/nope').set('Authorization', bearer(tokens))).body.error
        .message,
    ).toMatch(/^Route .* not found/);
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
