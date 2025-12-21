import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { vendorSchema, vendorUpdateSchema } from '../schemas/vendors.schema';
import { createVendor, listVendorsFiltered, updateVendor, deactivateVendor } from '../services/vendors.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/vendors', async (req: Request, res: Response) => {
  const parsed = vendorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const vendor = await createVendor(req.auth!.tenantId, parsed.data);
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
  const activeParam = _req.query.active;
  let active: boolean | undefined;
  if (activeParam !== undefined) {
    active = activeParam === 'true' || activeParam === '1';
  }
  try {
    const rows = await listVendorsFiltered(_req.auth!.tenantId, active);
    return res.json({ data: rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list vendors.' });
  }
});

router.put('/vendors/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid vendor id.' });
  }
  const parsed = vendorUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const updated = await updateVendor(req.auth!.tenantId, id, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }
    return res.json(updated);
  } catch (error: any) {
    const mapped = mapPgErrorToHttp(error, {
      unique: () => ({ status: 409, body: { error: 'Vendor code must be unique.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to update vendor.' });
  }
});

router.delete('/vendors/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid vendor id.' });
  }
  try {
    const updated = await deactivateVendor(req.auth!.tenantId, id);
    if (!updated) {
      return res.status(404).json({ error: 'Vendor not found.' });
    }
    return res.json(updated);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to deactivate vendor.' });
  }
});

export default router;
