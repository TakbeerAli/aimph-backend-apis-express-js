import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { diffFields, writeAudit } from '../../common/audit.js';
import { authUser, requireRole, type AuthUser } from '../../common/middleware/auth.js';
import { singleImage } from '../../common/middleware/upload.js';
import { validate } from '../../common/middleware/validate.js';
import { sendData } from '../../common/respond.js';
import { processInkImage } from '../../common/storage/imageProcessing.js';
import { newImageKey, uploadImage } from '../../common/storage/storage.js';
import { SETTINGS_ID } from '../../db/counters.js';
import { withTransaction } from '../../db/transaction.js';
import type { CertificateSettings } from './settings.model.js';
import { getSettings } from './settings.service.js';

/*
 * Certificate settings: who signs certificates, and the signature/stamp images (Admin only).
 * Issued certificates copy these into their snapshot, so changes here never alter them.
 * Old image files are never deleted.
 */

export const updateCertificateSettingsBody = z
  .object({
    principalName: z.string().trim().min(1).max(80),
    designation: z.string().trim().min(1).max(60),
    printSignature: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

export type UpdateCertificateSettingsInput = z.infer<typeof updateCertificateSettingsBody>;

const plain = (c: CertificateSettings): CertificateSettings => ({
  principalName: c.principalName,
  designation: c.designation,
  signatureUrl: c.signatureUrl ?? null,
  stampUrl: c.stampUrl ?? null,
  printSignature: c.printSignature,
  version: c.version,
});

export async function getCertificateSettings(): Promise<CertificateSettings> {
  return plain((await getSettings()).certificate);
}

/** Applies a change to settings.certificate in one transaction, bumping its version and auditing. */
async function changeCertificate(
  user: AuthUser,
  action: 'CERT_SETTINGS_UPDATE' | 'CERT_SIGNATURE_CHANGE' | 'CERT_STAMP_CHANGE',
  patch: Partial<CertificateSettings>,
): Promise<CertificateSettings> {
  return withTransaction(async (session) => {
    const settings = await getSettings(session);
    const before = plain(settings.certificate);
    const after = { ...before, ...patch };
    if (Object.keys(diffFields({ ...before }, { ...after }).after).length === 0) return before;

    after.version = before.version + 1;
    const diff = diffFields({ ...before }, { ...after });
    settings.set('certificate', after);
    await settings.save({ session });
    await writeAudit(session, {
      action,
      userId: user.id,
      entity: 'settings',
      entityId: SETTINGS_ID,
      ...diff,
    });
    return plain(settings.certificate);
  });
}

export const updateCertificateSettings = (user: AuthUser, input: UpdateCertificateSettingsInput) =>
  changeCertificate(user, 'CERT_SETTINGS_UPDATE', input);

/** Cleans the photo, stores it as a new file, and points the settings at it. */
export async function uploadCertificateImage(
  user: AuthUser,
  kind: 'signature' | 'stamp',
  file: Buffer,
): Promise<CertificateSettings> {
  const png = await processInkImage(file);
  const url = await uploadImage(png, newImageKey(kind));
  return kind === 'signature'
    ? changeCertificate(user, 'CERT_SIGNATURE_CHANGE', { signatureUrl: url })
    : changeCertificate(user, 'CERT_STAMP_CHANGE', { stampUrl: url });
}

/** Stops printing the stamp. The file itself is kept for certificates already issued. */
export const removeStamp = (user: AuthUser) =>
  changeCertificate(user, 'CERT_STAMP_CHANGE', { stampUrl: null });

/* ---------- Routes: /api/v1/settings/certificate (Admin only) ---------- */

export const certificateSettingsRouter = Router();
certificateSettingsRouter.use(requireRole('ADMIN'));

certificateSettingsRouter.get('/', async (_req: Request, res: Response) => {
  sendData(res, await getCertificateSettings());
});

certificateSettingsRouter.patch(
  '/',
  validate({ body: updateCertificateSettingsBody }),
  async (req: Request, res: Response) => {
    const body = req.body as UpdateCertificateSettingsInput;
    sendData(res, await updateCertificateSettings(authUser(req), body));
  },
);

for (const kind of ['signature', 'stamp'] as const) {
  certificateSettingsRouter.post(`/${kind}`, singleImage, async (req: Request, res: Response) => {
    // singleImage guarantees the file is present.
    sendData(res, await uploadCertificateImage(authUser(req), kind, req.file!.buffer));
  });
}

certificateSettingsRouter.delete('/stamp', async (req: Request, res: Response) => {
  sendData(res, await removeStamp(authUser(req)));
});
