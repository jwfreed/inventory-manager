import { Router, type Request, type Response } from 'express';
import { activeEventClientCount, registerEventStream } from '../lib/events';

const router = Router();

router.get('/events', (req: Request, res: Response) => {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  registerEventStream(req, res, tenantId);
});

router.get('/events/clients', (_req: Request, res: Response) => {
  const tenantId = _req.auth?.tenantId;
  if (!tenantId) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  return res.json({ connected: activeEventClientCount(tenantId) });
});

export default router;
