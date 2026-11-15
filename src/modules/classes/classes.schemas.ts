import { z } from 'zod';

const id = z.string().min(1).max(64);
const sectionName = z.string().trim().toUpperCase().min(1).max(10);

export const classIdParams = z.object({ id });
export const sectionParams = z.object({ id, sectionId: id });

export const createClassBody = z.object({
  name: z.string().trim().min(1).max(40),
  shortName: z.string().trim().min(1).max(10).nullable().default(null),
  sortOrder: z.int().min(1),
  nextClassId: id.nullable().default(null),
  sections: z.array(sectionName).max(10).default([]),
});

export const updateClassBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    shortName: z.string().trim().min(1).max(10).nullable(),
    sortOrder: z.int().min(1),
    nextClassId: id.nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

export const addSectionBody = z.object({ name: sectionName });

export const updateSectionBody = z
  .object({ name: sectionName, isActive: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

export type CreateClassInput = z.infer<typeof createClassBody>;
export type UpdateClassInput = z.infer<typeof updateClassBody>;
export type AddSectionInput = z.infer<typeof addSectionBody>;
export type UpdateSectionInput = z.infer<typeof updateSectionBody>;
