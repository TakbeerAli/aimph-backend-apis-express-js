import type { Request, Response } from 'express';
import { authUser } from '../../common/middleware/auth.js';
import { sendData } from '../../common/respond.js';
import type {
  ClassWiseQuery,
  CollectionQuery,
  DailyCollectionQuery,
  DefaultersQuery,
  PreviousSessionDuesQuery,
  StatusListQuery,
} from './reports.schemas.js';
import * as reports from './reports.service.js';

const query = <T>(req: Request) => req.query as unknown as T;

export async function dailyCollection(req: Request, res: Response): Promise<void> {
  const { date } = query<DailyCollectionQuery>(req);
  sendData(res, await reports.dailyCollection(authUser(req), date));
}

export async function collection(req: Request, res: Response): Promise<void> {
  sendData(res, await reports.collectionReport(query<CollectionQuery>(req)));
}

export async function classWise(req: Request, res: Response): Promise<void> {
  sendData(res, await reports.classWise(query<ClassWiseQuery>(req)));
}

export async function defaulters(req: Request, res: Response): Promise<void> {
  sendData(res, await reports.defaulters(query<DefaultersQuery>(req)));
}

export async function statusList(req: Request, res: Response): Promise<void> {
  sendData(res, await reports.statusList(query<StatusListQuery>(req)));
}

export async function previousSessionDues(req: Request, res: Response): Promise<void> {
  sendData(res, await reports.previousSessionDues(query<PreviousSessionDuesQuery>(req)));
}
