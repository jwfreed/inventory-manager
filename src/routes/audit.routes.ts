import { Router, type Request, type Response } from 'express';
import { auditListQuerySchema } from '../schemas/audit.schema';
import { listAuditLog } from '../services/audit.service';

const router = Router();

router.get('/audit-log', async (req: Request, res: Response) => {
  const parsed = auditListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  const { entityType, entityId, limit = 50, offset = 0 } = parsed.data;

  try {
    const data = await listAuditLog(req.auth!.tenantId, { entityType, entityId, limit, offset });
    return res.json({ data, paging: { limit, offset } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list audit log entries.' });
  }
});

export default router;
