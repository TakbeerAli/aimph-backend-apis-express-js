import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { newId } from '../../common/utils/ids.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

export interface SectionAttrs {
  _id: string;
  name: string;
  isActive: boolean;
}

export interface ClassAttrs extends SyncFields {
  _id: string;
  name: string;
  /** Short label used in "5-A". Falls back to `name`. */
  shortName: string | null;
  sortOrder: number;
  nextClassId: string | null;
  isActive: boolean;
  sections: Types.DocumentArray<SectionAttrs>;
}

const sectionSchema = new Schema<SectionAttrs>({
  _id: { type: String, default: newId },
  name: { type: String, required: true, trim: true, uppercase: true, maxlength: 10 },
  isActive: { type: Boolean, default: true },
});

const classSchema = new Schema<ClassAttrs>(
  {
    _id: { type: String, default: newId },
    name: { type: String, required: true, unique: true, trim: true, maxlength: 40 },
    shortName: { type: String, default: null, trim: true, maxlength: 10 },
    sortOrder: { type: Number, required: true, min: 1 },
    nextClassId: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    sections: { type: [sectionSchema], default: [] },
  },
  { collection: 'classes', timestamps: true, versionKey: false },
);
classSchema.plugin(syncPlugin);

classSchema.path('sections').validate(function (sections: SectionAttrs[]) {
  return new Set(sections.map((s) => s.name)).size === sections.length;
}, 'Section names must be unique within a class.');

export const SchoolClass = mongoose.model<ClassAttrs>('SchoolClass', classSchema);
export type ClassDoc = HydratedDocument<ClassAttrs>;

/** "5-A" style label. */
export const sectionLabel = (cls: Pick<ClassAttrs, 'name' | 'shortName'>, section: SectionAttrs) =>
  `${cls.shortName ?? cls.name}-${section.name}`;
