import { Router } from 'express';
import { routingsService } from '../services/routings.service';
import { createWorkCenterSchema, updateWorkCenterSchema, createRoutingSchema, updateRoutingSchema } from '../schemas/routings.schema';
import { z } from 'zod';

const router = Router();

// Work Center Routes

router.get('/work-centers', async (req, res) => {
  try {
    const workCenters = await routingsService.getAllWorkCenters(req.auth!.tenantId);
    res.json(workCenters);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch work centers' });
  }
});

router.get('/work-centers/:id', async (req, res) => {
  try {
    const workCenter = await routingsService.getWorkCenterById(req.auth!.tenantId, req.params.id);
    if (!workCenter) {
      return res.status(404).json({ error: 'Work center not found' });
    }
    res.json(workCenter);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch work center' });
  }
});

router.post('/work-centers', async (req, res) => {
  try {
    const data = createWorkCenterSchema.parse(req.body);
    const workCenter = await routingsService.createWorkCenter(req.auth!.tenantId, data);
    res.status(201).json(workCenter);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    if (error?.message === 'WORK_CENTER_LOCATION_NOT_FOUND') {
      return res.status(400).json({ error: 'Location not found for tenant.' });
    }
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Production area code already exists.' });
    }
    res.status(500).json({ error: 'Failed to create work center' });
  }
});

router.patch('/work-centers/:id', async (req, res) => {
  try {
    const data = updateWorkCenterSchema.parse(req.body);
    const workCenter = await routingsService.updateWorkCenter(req.auth!.tenantId, req.params.id, data);
    if (!workCenter) {
      return res.status(404).json({ error: 'Work center not found' });
    }
    res.json(workCenter);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    if (error?.message === 'WORK_CENTER_LOCATION_NOT_FOUND') {
      return res.status(400).json({ error: 'Location not found for tenant.' });
    }
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Production area code already exists.' });
    }
    res.status(500).json({ error: 'Failed to update work center' });
  }
});

// Routing Routes

router.get('/items/:itemId/routings', async (req, res) => {
  try {
    const routings = await routingsService.getRoutingsByItemId(req.auth!.tenantId, req.params.itemId);
    res.json(routings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch routings' });
  }
});

router.get('/routings/:id', async (req, res) => {
  try {
    const routing = await routingsService.getRoutingById(req.auth!.tenantId, req.params.id);
    if (!routing) {
      return res.status(404).json({ error: 'Routing not found' });
    }
    res.json(routing);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch routing' });
  }
});

router.post('/routings', async (req, res) => {
  try {
    const data = createRoutingSchema.parse(req.body);
    const routing = await routingsService.createRouting(req.auth!.tenantId, data);
    res.status(201).json(routing);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    if (error?.message === 'ROUTING_ITEM_NOT_FOUND' || error?.message === 'WORK_CENTER_NOT_FOUND') {
      return res.status(400).json({ error: 'Routing references items or production areas outside tenant scope.' });
    }
    res.status(500).json({ error: 'Failed to create routing' });
  }
});

router.patch('/routings/:id', async (req, res) => {
  try {
    const data = updateRoutingSchema.parse(req.body);
    const routing = await routingsService.updateRouting(req.auth!.tenantId, req.params.id, data);
    if (!routing) {
      return res.status(404).json({ error: 'Routing not found' });
    }
    res.json(routing);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    if (error?.message === 'WORK_CENTER_NOT_FOUND') {
      return res.status(400).json({ error: 'Routing references production areas outside tenant scope.' });
    }
    res.status(500).json({ error: 'Failed to update routing' });
  }
});

export default router;
