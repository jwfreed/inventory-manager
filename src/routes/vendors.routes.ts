import { Router, type Request, type Response } from 'express';
import { vendorSchema } from '../schemas/vendors.schema';
import { createVendor, listVendors } from '../services/vendors.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();

router.post('/vendors', async (req: Request, res: Response) => {
  const parsed = vendorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const vendor = await createVendor(parsed.data);
    return res.status(201).json(vendor);
  } catch (error: any) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Vendor code must be unique.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create vendor.' });
  }
});

router.get('/vendors', async (_req: Request, res: Response) => {
  try {
    const rows = await listVendors();
    return res.json({ data: rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list vendors.' });
  }
});

export default router;
