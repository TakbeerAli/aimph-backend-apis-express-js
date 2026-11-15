import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';

const app = createApp();

describe('GET /api/v1/health', () => {
  it('reports ok when the database is up', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok', db: 'up' } });
  });
});

describe('error responses', () => {
  it('returns NOT_FOUND in the standard error shape for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /api/v1/nope not found.', details: {} },
    });
  });

  it('returns VALIDATION_ERROR for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"bad json');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
