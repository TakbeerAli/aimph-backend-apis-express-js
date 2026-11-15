import type { Response } from 'express';

/** Sends the standard success envelope: `{ data }`. */
export function sendData<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data });
}
