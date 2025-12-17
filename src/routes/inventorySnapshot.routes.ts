import { Router, type Request, type Response } from 'express';
import { inventorySnapshotQuerySchema } from '../schemas/inventorySnapshot.schema';
import {
  assertItemExists,
  assertLocationExists,
  getInventorySnapshot
} from '../services/inventorySnapshot.service';

const router = Router();

router.get('/inventory-snapshot', async (req: Request, res: Response) => {
  const parsed = inventorySnapshotQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query params.', details: parsed.error.format() });
  }

  const { itemId, locationId, uom } = parsed.data;

  const [itemExists, locationExists] = await Promise.all([
    assertItemExists(itemId),
    assertLocationExists(locationId)
  ]);

  if (!itemExists) {
    return res.status(404).json({ error: 'Item not found.' });
  }
  if (!locationExists) {
    return res.status(404).json({ error: 'Location not found.' });
  }

  try {
    const snapshot = await getInventorySnapshot({ itemId, locationId, uom });
    return res.json({ data: snapshot });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to compute inventory snapshot.' });
  }
});

export default router;
