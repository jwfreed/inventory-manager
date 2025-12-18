import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { bomActivationSchema, bomCreateSchema } from '../schemas/boms.schema';
import {
  activateBomVersion,
  createBom,
  fetchBomById,
  listBomsByItem,
  listNextStepBomsByComponentItem,
  resolveEffectiveBom
} from '../services/boms.service';
import { mapPgErrorToHttp } from '../lib/pgErrors';

const router = Router();
const uuidSchema = z.string().uuid();

function parseDateInput(value: string): Date | null {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return null;
  }
  return date;
}

router.post('/boms', async (req: Request, res: Response) => {
  const parsed = bomCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const bom = await createBom(parsed.data);
    return res.status(201).json(bom);
  } catch (error: any) {
    if (error?.message === 'BOM_COMPONENT_DUPLICATE_LINE') {
      return res.status(400).json({ error: 'Component line numbers must be unique per BOM version.' });
    }
    const mapped = mapPgErrorToHttp(error, {
      unique: (err) => {
        if (err.constraint === 'boms_bom_code_key') {
          return { status: 409, body: { error: 'bomCode must be unique.' } };
        }
        if (err.constraint === 'bom_version_lines_line_unique') {
          return { status: 400, body: { error: 'Component line numbers must be unique per BOM version.' } };
        }
        return null;
      },
      foreignKey: () => ({ status: 400, body: { error: 'Referenced item does not exist.' } })
    });
    if (mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    if (error?.message === 'BOM_NOT_FOUND_AFTER_CREATE') {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load BOM after creation.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create BOM.' });
  }
});

router.get('/boms/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!uuidSchema.safeParse(id).success) {
    return res.status(400).json({ error: 'Invalid BOM id.' });
  }

  try {
    const bom = await fetchBomById(id);
    if (!bom) {
      return res.status(404).json({ error: 'BOM not found.' });
    }
    return res.json(bom);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to load BOM.' });
  }
});

router.get('/items/:id/boms', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  if (!uuidSchema.safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }

  try {
    const summary = await listBomsByItem(itemId);
    return res.json(summary);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list BOMs for item.' });
  }
});

router.get('/items/:id/next-step-boms', async (req: Request, res: Response) => {
  const componentItemId = req.params.id;
  if (!uuidSchema.safeParse(componentItemId).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }
  try {
    const boms = await listNextStepBomsByComponentItem(componentItemId);
    return res.json({ data: boms });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to list next-step BOMs.' });
  }
});

router.post('/boms/:id/activate', async (req: Request, res: Response) => {
  const versionId = req.params.id;
  if (!uuidSchema.safeParse(versionId).success) {
    return res.status(400).json({ error: 'Invalid BOM version id.' });
  }

  const parsed = bomActivationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const effectiveFrom = parseDateInput(parsed.data.effectiveFrom);
  const effectiveTo = parsed.data.effectiveTo ? parseDateInput(parsed.data.effectiveTo) : null;
  if (!effectiveFrom) {
    return res.status(400).json({ error: 'effectiveFrom must be a valid ISO datetime.' });
  }
  if (parsed.data.effectiveTo && !effectiveTo) {
    return res.status(400).json({ error: 'effectiveTo must be a valid ISO datetime.' });
  }

  try {
    const bom = await activateBomVersion(versionId, parsed.data, effectiveFrom, effectiveTo);
    return res.json(bom);
  } catch (error: any) {
    if (error?.message === 'BOM_VERSION_NOT_FOUND') {
      return res.status(404).json({ error: 'BOM version not found.' });
    }
    if (error?.message === 'BOM_VERSION_ALREADY_ACTIVE') {
      return res.status(409).json({ error: 'BOM version is already active.' });
    }
    if (error?.message === 'BOM_EFFECTIVE_RANGE_OVERLAP') {
      return res
        .status(409)
        .json({ error: 'Another BOM version is active for this item during the requested range.' });
    }
    if (error?.message === 'BOM_NOT_FOUND_AFTER_UPDATE') {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load BOM after activation.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to activate BOM version.' });
  }
});

router.get('/items/:id/bom', async (req: Request, res: Response) => {
  const itemId = req.params.id;
  if (!uuidSchema.safeParse(itemId).success) {
    return res.status(400).json({ error: 'Invalid item id.' });
  }

  const asOfParam = typeof req.query.asOf === 'string' ? req.query.asOf : undefined;
  let asOfDate: Date;
  if (asOfParam) {
    const parsedAsOf = parseDateInput(asOfParam);
    if (!parsedAsOf) {
      return res.status(400).json({ error: 'asOf must be a valid ISO datetime or date.' });
    }
    asOfDate = parsedAsOf;
  } else {
    asOfDate = new Date();
  }

  const asOfIso = asOfDate.toISOString();

  try {
    const result = await resolveEffectiveBom(itemId, asOfIso);
    if (!result) {
      return res.status(404).json({ error: 'No active BOM found for the specified date.' });
    }
    return res.json(result);
  } catch (error: any) {
    if (error?.message === 'BOM_NOT_FOUND') {
      return res.status(404).json({ error: 'BOM not found.' });
    }
    if (error?.message === 'BOM_VERSION_NOT_FOUND') {
      return res.status(404).json({ error: 'BOM version not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to load effective BOM.' });
  }
});

export default router;
