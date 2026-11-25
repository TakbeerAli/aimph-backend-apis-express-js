import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createUser, login, resetDatabase, type Tokens } from '../../../test/helpers.js';
import { createApp } from '../../app.js';
import { AuditLog } from '../../common/audit.js';
import { detectImageType, processInkImage } from '../../common/storage/imageProcessing.js';
import { storage, type MemoryStorage } from '../../common/storage/storage.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { Settings } from './settings.model.js';

const api = '/api/v1/settings/certificate';
const files = () => (storage as MemoryStorage).files;

/** A photo of dark "ink" (a thick bar) on white paper with a wide margin. */
const inkPhoto = (width = 1600, height = 600, format: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([
      {
        input: {
          create: { width: width / 2, height: height / 4, channels: 3, background: '#202020' },
        },
        top: height / 4,
        left: width / 4,
      },
    ])
    .toFormat(format)
    .toBuffer();

const blankPhoto = () =>
  sharp({ create: { width: 400, height: 200, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();

describe('image processing', () => {
  it('detects PNG and JPEG by their magic bytes only', async () => {
    expect(detectImageType(await inkPhoto(200, 100, 'png'))).toBe('png');
    expect(detectImageType(await inkPhoto(200, 100, 'jpeg'))).toBe('jpeg');
    expect(detectImageType(Buffer.from('<svg></svg>'))).toBeNull();
  });

  it('trims the paper, makes it transparent, keeps the ink dark, and caps the width at 900', async () => {
    const out = await processInkImage(await inkPhoto(2400, 900, 'jpeg'));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
    // The white margin was trimmed: only the bar (1200 x 225) remains, scaled to 900 wide.
    expect(meta.width).toBe(900);
    expect(meta.height).toBeLessThan(250);

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const centre = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect(data[centre + 3]).toBe(255); // ink is opaque
    expect(data[centre]).toBeLessThan(60); // and dark
  });

  it('makes paper transparent when there is margin left after trimming', async () => {
    // A thin ring of ink keeps the white inside it, which must become transparent.
    const ring = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#ffffff' },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="300" height="300"><circle cx="150" cy="150" r="120" fill="none" stroke="#000" stroke-width="12"/></svg>',
          ),
        },
      ])
      .png()
      .toBuffer();
    const out = await processInkImage(ring);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const centre = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect(data[centre + 3]).toBe(0);
  });

  it('rejects a blank page', async () => {
    await expect(processInkImage(await blankPhoto())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('certificate settings', () => {
  let app: ReturnType<typeof createApp>;
  let admin: Tokens;
  let staff: Tokens;
  let png: Buffer;

  beforeAll(async () => {
    png = await inkPhoto();
  });

  beforeEach(async () => {
    await resetDatabase();
    files().clear();
    app = createApp();
    admin = await login(app, await createUser({ role: 'ADMIN' }));
    staff = await login(app, await createUser());
  });

  const upload = (kind: 'signature' | 'stamp', file: Buffer, name: string, type: string) =>
    request(app)
      .post(`${api}/${kind}`)
      .set('Authorization', bearer(admin))
      .attach('file', file, { filename: name, contentType: type });

  it('is Admin only', async () => {
    const auth = { Authorization: bearer(staff) };
    expect((await request(app).get(api).set(auth)).status).toBe(403);
    expect((await request(app).patch(api).set(auth).send({ principalName: 'X' })).status).toBe(403);
    const res = await request(app)
      .post(`${api}/signature`)
      .set(auth)
      .attach('file', png, { filename: 's.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect((await request(app).delete(`${api}/stamp`).set(auth)).status).toBe(403);
  });

  it('starts with defaults', async () => {
    const res = await request(app).get(api).set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      principalName: '',
      designation: 'Principal',
      signatureUrl: null,
      stampUrl: null,
      printSignature: true,
      version: 1,
    });
  });

  it('updates the signer, bumps the version, and audits before/after', async () => {
    const res = await request(app)
      .patch(api)
      .set('Authorization', bearer(admin))
      .send({ principalName: '  Prof. Ahmed Ali ', printSignature: false, signatureUrl: 'x' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      principalName: 'Prof. Ahmed Ali',
      printSignature: false,
      signatureUrl: null, // not settable through PATCH
      version: 2,
    });
    const audit = await AuditLog.findOne({ action: 'CERT_SETTINGS_UPDATE' }).lean();
    expect(audit?.before).toEqual({ principalName: '', printSignature: true, version: 1 });
    expect(audit?.after).toEqual({
      principalName: 'Prof. Ahmed Ali',
      printSignature: false,
      version: 2,
    });

    // Saving the same values again changes nothing.
    const again = await request(app)
      .patch(api)
      .set('Authorization', bearer(admin))
      .send({ principalName: 'Prof. Ahmed Ali' });
    expect(again.body.data.version).toBe(2);
  });

  it('rejects empty updates and an empty principal name', async () => {
    const auth = { Authorization: bearer(admin) };
    expect((await request(app).patch(api).set(auth).send({})).status).toBe(400);
    expect((await request(app).patch(api).set(auth).send({ principalName: ' ' })).status).toBe(400);
  });

  it('the general settings PATCH cannot change certificate settings', async () => {
    await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', bearer(admin))
      .send({ phone: '1', certificate: { principalName: 'Hacker' } });
    const stored = await Settings.findById(SETTINGS_ID).lean();
    expect(stored?.certificate.principalName).toBe('');
  });

  it('uploads a signature as a new file each time and never deletes the old one', async () => {
    const first = await upload('signature', png, 'sig.png', 'image/png');
    expect(first.status).toBe(200);
    const firstUrl = first.body.data.signatureUrl as string;
    expect(firstUrl).toMatch(
      /^https:\/\/storage\.test\/certificates\/signature-\d+-[0-9a-f]{16}\.png$/,
    );
    expect(first.body.data.version).toBe(2);

    const stored = files().get(firstUrl.replace('https://storage.test/', '').replace('.png', ''));
    expect((await sharp(stored).metadata()).hasAlpha).toBe(true);

    const second = await upload(
      'signature',
      await inkPhoto(800, 300, 'jpeg'),
      's.jpg',
      'image/jpeg',
    );
    expect(second.status).toBe(200);
    expect(second.body.data.signatureUrl).not.toBe(firstUrl);
    expect(second.body.data.version).toBe(3);
    // The first file is still there for certificates issued with it.
    expect(files().has(firstUrl.replace('https://storage.test/', '').replace('.png', ''))).toBe(
      true,
    );

    const audits = await AuditLog.find({ action: 'CERT_SIGNATURE_CHANGE' }).sort({ at: 1 }).lean();
    expect(audits).toHaveLength(2);
    expect(audits[1]?.before).toMatchObject({ signatureUrl: firstUrl });
  });

  it('rejects a file over 2 MB, a non-image, and a fake PNG', async () => {
    const big = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    const tooBig = await upload('signature', big, 'big.png', 'image/png');
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.message).toBe('Use a PNG or JPG photo under 2 MB.');

    const pdf = await upload('signature', Buffer.from('%PDF-1.7'), 'a.pdf', 'application/pdf');
    expect(pdf.status).toBe(415);

    const fake = await upload('signature', Buffer.from('not really a png'), 'x.png', 'image/png');
    expect(fake.status).toBe(415);

    const blank = await upload('signature', await blankPhoto(), 'blank.png', 'image/png');
    expect(blank.status).toBe(400);

    const missing = await request(app).post(`${api}/signature`).set('Authorization', bearer(admin));
    expect(missing.status).toBe(400);

    const stored = await Settings.findById(SETTINGS_ID).lean();
    expect(stored?.certificate.signatureUrl).toBeNull();
    expect(files().size).toBe(0);
  });

  it('uploads and removes the stamp, keeping the file', async () => {
    const res = await upload('stamp', png, 'stamp.png', 'image/png');
    expect(res.status).toBe(200);
    const url = res.body.data.stampUrl as string;
    expect(url).toContain('/certificates/stamp-');

    const removed = await request(app).delete(`${api}/stamp`).set('Authorization', bearer(admin));
    expect(removed.status).toBe(200);
    expect(removed.body.data.stampUrl).toBeNull();
    expect(files().size).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'CERT_STAMP_CHANGE' })).toBe(2);
  });

  it('is included in the settings everyone reads', async () => {
    const res = await request(app).get('/api/v1/settings').set('Authorization', bearer(staff));
    expect(res.body.data.certificate).toMatchObject({ designation: 'Principal' });
  });
});
