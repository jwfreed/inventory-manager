import { Router } from 'express';
import { routingsService } from '../services/routings.service';
import { createWorkCenterSchema, updateWorkCenterSchema, createRoutingSchema, updateRoutingSchema } from '../schemas/routings.schema';
import { z } from 'zod';

const router = Router();

// Work Center Routes

router.get('/work-centers', async (req, res) => {
  try {
    const workCenters = await routingsService.getAllWorkCenters();
    res.json(workCenters);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch work centers' });
  }
});

router.get('/work-centers/:id', async (req, res) => {
  try {
    const workCenter = await routingsService.getWorkCenterById(req.params.id);
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
    const workCenter = await routingsService.createWorkCenter(data);
    res.status(201).json(workCenter);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: 'Failed to create work center' });
  }
});

router.patch('/work-centers/:id', async (req, res) => {
  try {
    const data = updateWorkCenterSchema.parse(req.body);
    const workCenter = await routingsService.updateWorkCenter(req.params.id, data);
    if (!workCenter) {
      return res.status(404).json({ error: 'Work center not found' });
    }
    res.json(workCenter);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: 'Failed to update work center' });
  }
});

// Routing Routes

router.get('/items/:itemId/routings', async (req, res) => {
  try {
    const routings = await routingsService.getRoutingsByItemId(req.params.itemId);
    res.json(routings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch routings' });
  }
});

router.get('/routings/:id', async (req, res) => {
  try {
    const routing = await routingsService.getRoutingById(req.params.id);
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
    const routing = await routingsService.createRouting(data);
    res.status(201).json(routing);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: 'Failed to create routing' });
  }
});

router.patch('/routings/:id', async (req, res) => {
  try {
    const data = updateRoutingSchema.parse(req.body);
    const routing = await routingsService.updateRouting(req.params.id, data);
    if (!routing) {
      return res.status(404).json({ error: 'Routing not found' });
    }
    res.json(routing);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: 'Failed to update routing' });
  }
});

export default router;
