import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getIdempotencyKey } from '../lib/idempotency';
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
  postReturnReceipt,
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

router.post('/return-receipts/:id/post', async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid return receipt id.' });
  }
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header is required.' });
  }
  try {
    const receipt = await postReturnReceipt(req.auth!.tenantId, id, { idempotencyKey });
    return res.json(receipt);
  } catch (error: any) {
    if (error?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' || error?.message === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
      return res.status(409).json({
        error: {
          code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
          message: 'Return receipt posting already in progress for this idempotency key.'
        }
      });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS'
    ) {
      return res.status(409).json({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSE_ACROSS_ENDPOINTS',
          message: 'Idempotency key was already used for a different endpoint.'
        }
      });
    }
    if (
      error?.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
      || error?.message === 'IDEMPOTENCY_HASH_MISMATCH'
    ) {
      return res.status(409).json({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
          message: 'Idempotency key reused with a different request payload.'
        }
      });
    }
    if (error?.message === 'RETURN_RECEIPT_NOT_FOUND') {
      return res.status(404).json({ error: 'Return receipt not found.' });
    }
    if (error?.message === 'RETURN_RECEIPT_CANCELED') {
      return res.status(409).json({ error: 'Canceled return receipts cannot be posted.' });
    }
    if (error?.message === 'RETURN_RECEIPT_NO_LINES') {
      return res.status(400).json({ error: 'Return receipt must have at least one line before posting.' });
    }
    if (error?.message === 'RETURN_AUTH_NOT_FOUND') {
      return res.status(409).json({ error: 'Return authorization is missing for this receipt.' });
    }
    if (error?.message === 'RETURN_AUTH_NOT_POSTABLE') {
      return res.status(409).json({ error: 'Return authorization is not in a postable state.' });
    }
    if (error?.message === 'RETURN_RECEIPT_LINE_INVALID_REFERENCE') {
      return res.status(400).json({ error: 'Return receipt line references an invalid return authorization line.' });
    }
    if (error?.message === 'RETURN_RECEIPT_LINE_REFERENCE_MISMATCH') {
      return res.status(409).json({ error: 'Return receipt line does not match its return authorization line item or UOM.' });
    }
    if (error?.message === 'RETURN_RECEIPT_QTY_EXCEEDS_AUTHORIZED') {
      return res.status(409).json({ error: 'Posting this return receipt would exceed the authorized return quantity.' });
    }
    if (error?.message === 'WAREHOUSE_SCOPE_REQUIRED') {
      return res.status(400).json({
        error: {
          code: 'WAREHOUSE_SCOPE_REQUIRED',
          message: 'Return receipt location must resolve to a warehouse.'
        }
      });
    }
    if (error?.code === 'RETURN_RECEIPT_POST_INCOMPLETE' || error?.message === 'RETURN_RECEIPT_POST_INCOMPLETE') {
      return res.status(409).json({
        error: {
          code: 'RETURN_RECEIPT_POST_INCOMPLETE',
          message: 'Return receipt posting integrity failed closed.',
          details: error?.details ?? null
        }
      });
    }
    if (error?.code === 'REPLAY_CORRUPTION_DETECTED' || error?.message === 'REPLAY_CORRUPTION_DETECTED') {
      return res.status(409).json({
        error: {
          code: 'REPLAY_CORRUPTION_DETECTED',
          message: 'Return receipt replay integrity failed closed.',
          details: error?.details ?? null
        }
      });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to post return receipt.' });
  }
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
