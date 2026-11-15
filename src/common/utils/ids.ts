import { v7 as uuidv7, validate, version } from 'uuid';

/** New time-ordered id for any document `_id`. */
export const newId = (): string => uuidv7();

export const isUuidV7 = (value: string): boolean => validate(value) && version(value) === 7;
