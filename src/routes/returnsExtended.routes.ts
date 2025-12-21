import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  returnDispositionLineSchema,
  returnDispositionSchema,
  returnReceiptLineSchema,
  returnReceiptSchema,
} from '../schemas/returnsExtended.schema';
import {
  addReturnDispositionLine,
  addReturnReceiptLine,
  createReturnDisposition,
  createReturnReceipt,
  getReturnDisposition,
  getReturnReceipt,
  listReturnDispositions,
  listReturnReceipts,
} from '../services/returnsExtended.service';

const router = Router();
const uuidSchema = z.string().uuid();

router.post('/return-receipts', async (req: Request, res: Response) => {
  const parsed = returnReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const receipt = await createReturnReceipt(req.auth!.tenantId, parsed.data);
    return res.status(201).json(receipt);
  } catch (error: any) {
    if (error?.http) return res.status(error.http.status).json(error.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create return receipt.' });
  }
});

router.get('/return-receipts', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await listReturnReceipts(req.auth!.tenantId, limit, offset);
  return res.json({ data: rows, paging: { limit, offset } });
});

router.get('/return-receipts/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid return receipt id.' });
  }
  const receipt = await getReturnReceipt(req.auth!.tenantId, id);
  if (!receipt) return res.status(404).json({ error: 'Return receipt not found.' });
  return res.json(receipt);
});

router.post('/return-receipts/:id/lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid return receipt id.' });
  }
  const parsed = returnReceiptLineSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const line = await addReturnReceiptLine(req.auth!.tenantId, id, parsed.data);
    return res.status(201).json(line);
  } catch (error: any) {
    if (error?.http) return res.status(error.http.status).json(error.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to add return receipt line.' });
  }
});

router.post('/return-dispositions', async (req: Request, res: Response) => {
  const parsed = returnDispositionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const disposition = await createReturnDisposition(req.auth!.tenantId, parsed.data);
    return res.status(201).json(disposition);
  } catch (error: any) {
    if (error?.http) return res.status(error.http.status).json(error.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to create return disposition.' });
  }
});

router.get('/return-dispositions', async (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await listReturnDispositions(req.auth!.tenantId, limit, offset);
  return res.json({ data: rows, paging: { limit, offset } });
});

router.get('/return-dispositions/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid return disposition id.' });
  }
  const disposition = await getReturnDisposition(req.auth!.tenantId, id);
  if (!disposition) return res.status(404).json({ error: 'Return disposition not found.' });
  return res.json(disposition);
});

router.post('/return-dispositions/:id/lines', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid return disposition id.' });
  }
  const parsed = returnDispositionLineSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const line = await addReturnDispositionLine(req.auth!.tenantId, id, parsed.data);
    return res.status(201).json(line);
  } catch (error: any) {
    if (error?.http) return res.status(error.http.status).json(error.http.body);
    console.error(error);
    return res.status(500).json({ error: 'Failed to add return disposition line.' });
  }
});

export default router;
