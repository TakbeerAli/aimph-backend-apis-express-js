import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { newId } from '../../common/utils/ids.js';
import { syncPlugin, type SyncFields } from '../../db/syncPlugin.js';

/** HOLIDAY: no attendance on these days. WORKING_DAY: a weekly off day that is worked (make-up). */
export const CALENDAR_EVENT_TYPES = ['HOLIDAY', 'WORKING_DAY'] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

export interface CalendarEventAttrs extends SyncFields {
  _id: string;
  sessionId: string;
  type: CalendarEventType;
  /** Holiday name, or the reason for the make-up working day. */
  name: string;
  /** "YYYY-MM-DD" (Asia/Karachi calendar dates), inclusive. One day: start = end. */
  startDate: string;
  endDate: string;
  /**
   * Deleted events are kept with this flag (and a new syncSeq), so phones that pull changes
   * learn about the deletion. They are ignored everywhere else.
   */
  isDeleted: boolean;
}

const ymd = { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ };

const calendarEventSchema = new Schema<CalendarEventAttrs>(
  {
    _id: { type: String, default: newId },
    sessionId: { type: String, required: true },
    type: { type: String, enum: CALENDAR_EVENT_TYPES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    startDate: ymd,
    endDate: ymd,
    isDeleted: { type: Boolean, default: false },
  },
  { collection: 'calendar_events', timestamps: true, versionKey: false },
);
calendarEventSchema.plugin(syncPlugin);
calendarEventSchema.index({ sessionId: 1, startDate: 1 });

export const CalendarEvent = mongoose.model<CalendarEventAttrs>(
  'CalendarEvent',
  calendarEventSchema,
);
export type CalendarEventDoc = HydratedDocument<CalendarEventAttrs>;
