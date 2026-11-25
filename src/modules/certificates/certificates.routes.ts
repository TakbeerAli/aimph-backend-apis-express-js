import { Router, type Request, type Response } from 'express';
import { authUser, requireRole } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { sendData } from '../../common/respond.js';
import {
  cancelCertificateBody,
  certificateIdParams,
  checkCertificateBody,
  issueCertificateBody,
  listCertificatesQuery,
  reprintBody,
  type CancelCertificateInput,
  type CheckCertificateInput,
  type IssueCertificateInput,
  type ListCertificatesQuery,
  type ReprintInput,
} from './certificates.schemas.js';
import {
  cancelCertificate,
  checkCertificate,
  getCertificate,
  issueCertificate,
  listCertificates,
  reprintCertificate,
} from './certificates.service.js';

// Mounted behind requireAuth in app.ts. Every certificate endpoint is Admin only.
export const certificatesRouter = Router();
certificatesRouter.use(requireRole('ADMIN'));

certificatesRouter.post(
  '/check',
  validate({ body: checkCertificateBody }),
  async (req: Request, res: Response) => {
    sendData(res, await checkCertificate(req.body as CheckCertificateInput));
  },
);

certificatesRouter.post(
  '/',
  validate({ body: issueCertificateBody }),
  async (req: Request, res: Response) => {
    const body = req.body as IssueCertificateInput;
    sendData(res, await issueCertificate(authUser(req), body), 201);
  },
);

certificatesRouter.get(
  '/',
  validate({ query: listCertificatesQuery }),
  async (req: Request, res: Response) => {
    sendData(res, await listCertificates(req.query as unknown as ListCertificatesQuery));
  },
);

certificatesRouter.get(
  '/:id',
  validate({ params: certificateIdParams }),
  async (req: Request<{ id: string }>, res: Response) => {
    sendData(res, await getCertificate(req.params.id));
  },
);

certificatesRouter.post(
  '/:id/reprint',
  validate({ params: certificateIdParams, body: reprintBody }),
  async (req: Request<{ id: string }>, res: Response) => {
    const body = req.body as ReprintInput;
    sendData(res, await reprintCertificate(authUser(req), req.params.id, body));
  },
);

certificatesRouter.post(
  '/:id/cancel',
  validate({ params: certificateIdParams, body: cancelCertificateBody }),
  async (req: Request<{ id: string }>, res: Response) => {
    const body = req.body as CancelCertificateInput;
    sendData(res, await cancelCertificate(authUser(req), req.params.id, body));
  },
);
