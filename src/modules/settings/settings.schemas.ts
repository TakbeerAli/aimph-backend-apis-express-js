import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);

export const updateSettingsBody = z
  .object({
    schoolName: text(120).min(1),
    address: text(250),
    phone: text(30),
    logoUrl: z.union([z.url(), z.literal('')]),
    bank: z
      .object({
        bankName: text(80),
        accountTitle: text(120),
        accountNo: text(40),
        branch: text(120),
      })
      .partial(),
    voucherIssueDay: z.int().min(1).max(28),
    voucherDueDay: z.int().min(1).max(28),
    receiptFooter: text(300),
    openingBalancesSkipped: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

/** A PNG or JPEG as a data URI, at most ~500 KB of image data. */
export const putLogoBody = z.object({
  dataUri: z
    .string()
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/, 'Send a PNG or JPEG image.')
    .max(700_000, 'The logo is too large. Use an image under 500 KB.'),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsBody>;
export type PutLogoInput = z.infer<typeof putLogoBody>;
