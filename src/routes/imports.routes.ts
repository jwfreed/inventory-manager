import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  applyImportJob,
  createImportJobFromUpload,
  getImportJob,
  validateImportJob
} from '../services/imports.service';

const router = Router();

const typeSchema = z.enum(['items', 'locations', 'on_hand']);

router.post(
  '/admin/imports/upload',
  express.text({ type: '*/*', limit: '12mb' }),
  async (req: Request, res: Response) => {
    if (req.auth?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const typeResult = typeSchema.safeParse(req.query.type);
    if (!typeResult.success) {
      return res.status(400).json({ error: 'Invalid import type.' });
    }

    const csvText = typeof req.body === 'string' ? req.body : '';
    if (!csvText) {
      return res.status(400).json({ error: 'CSV content is required.' });
    }

    const fileName = typeof req.query.fileName === 'string' ? req.query.fileName : null;

    try {
      const result = await createImportJobFromUpload({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        type: typeResult.data,
        fileName,
        csvText
      });
      return res.status(201).json(result);
    } catch (error: any) {
      if (error?.message === 'IMPORT_FILE_TOO_LARGE') {
        return res.status(413).json({ error: 'CSV file exceeds size limit.' });
      }
      if (error?.message === 'IMPORT_ROW_LIMIT') {
        return res.status(413).json({ error: 'CSV exceeds row limit.' });
      }
      if (error?.message === 'IMPORT_NO_HEADERS') {
        return res.status(400).json({ error: 'CSV must include headers.' });
      }
      if (error?.message === 'IMPORT_FORBIDDEN_COLUMN') {
        return res.status(400).json({ error: 'Lot/serial columns are not supported in this import.' });
      }
      console.error(error);
      return res.status(500).json({ error: 'Failed to upload import file.' });
    }
  }
);

router.get('/admin/imports/:id', async (req: Request, res: Response) => {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  const idSchema = z.string().uuid();
  if (!idSchema.safeParse(req.params.id).success) {
    return res.status(400).json({ error: 'Invalid import id.' });
  }
  const job = await getImportJob(req.auth.tenantId, req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Import not found.' });
  }
  return res.json({ data: job });
});

router.post('/admin/imports/:id/validate', async (req: Request, res: Response) => {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const schema = z.object({
    mapping: z.record(z.string(), z.string()),
    countedAt: z.string().datetime().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await validateImportJob({
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
      jobId: req.params.id,
      mapping: parsed.data.mapping,
      countedAt: parsed.data.countedAt
    });
    return res.json({ data: result });
  } catch (error: any) {
    if (error?.message?.startsWith('IMPORT_MAPPING_MISSING')) {
      return res.status(400).json({ error: 'Required field mapping missing.' });
    }
    if (error?.message?.startsWith('IMPORT_MAPPING_INVALID')) {
      return res.status(400).json({ error: 'Mapping references unknown header.' });
    }
    if (error?.message === 'IMPORT_FORBIDDEN_COLUMN') {
      return res.status(400).json({ error: 'Lot/serial columns are not supported in this import.' });
    }
    if (error?.message === 'IMPORT_ROW_LIMIT') {
      return res.status(413).json({ error: 'CSV exceeds row limit.' });
    }
    if (error?.message === 'IMPORT_JOB_NOT_FOUND') {
      return res.status(404).json({ error: 'Import not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to validate import.' });
  }
});

router.post('/admin/imports/:id/apply', async (req: Request, res: Response) => {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  try {
    const job = await applyImportJob({
      tenantId: req.auth.tenantId,
      userId: req.auth.userId,
      jobId: req.params.id
    });
    return res.status(202).json({ data: job });
  } catch (error: any) {
    if (error?.message === 'IMPORT_HAS_ERRORS') {
      return res.status(409).json({ error: 'Fix validation errors before applying.' });
    }
    if (error?.message === 'IMPORT_JOB_NOT_FOUND') {
      return res.status(404).json({ error: 'Import not found.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to start import.' });
  }
});

export default router;
