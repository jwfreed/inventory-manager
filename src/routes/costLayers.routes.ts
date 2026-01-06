import express from 'express';
import * as costLayersService from '../services/costLayers.service';

const router = express.Router();

/**
 * GET /api/cost-layers/item/:itemId
 * Get cost layer details for an item
 */
router.get('/item/:itemId', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const { itemId } = req.params;
    const { locationId } = req.query;

    const layers = await costLayersService.getCostLayerDetails(
      tenant_id,
      itemId,
      locationId as string | undefined
    );

    res.json({
      success: true,
      data: layers
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cost-layers/available
 * Get available cost layers for an item/location (FIFO order)
 */
router.get('/available', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const { itemId, locationId, lotId } = req.query;

    if (!itemId || !locationId) {
      return res.status(400).json({
        success: false,
        error: 'itemId and locationId are required'
      });
    }

    const layers = await costLayersService.getAvailableLayers(
      tenant_id,
      itemId as string,
      locationId as string,
      lotId as string | undefined
    );

    res.json({
      success: true,
      data: layers
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cost-layers/average-cost
 * Get current weighted average cost for an item/location
 */
router.get('/average-cost', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const { itemId, locationId } = req.query;

    if (!itemId || !locationId) {
      return res.status(400).json({
        success: false,
        error: 'itemId and locationId are required'
      });
    }

    const costInfo = await costLayersService.getCurrentWeightedAverageCost(
      tenant_id,
      itemId as string,
      locationId as string
    );

    res.json({
      success: true,
      data: costInfo
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cost-layers/:layerId/consumptions
 * Get consumption history for a cost layer
 */
router.get('/:layerId/consumptions', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const { layerId } = req.params;

    const consumptions = await costLayersService.getLayerConsumptions(
      tenant_id,
      layerId
    );

    res.json({
      success: true,
      data: consumptions
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cost-layers/cogs
 * Get COGS for a time period
 */
router.get('/cogs', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const { startDate, endDate, itemId, locationId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate are required'
      });
    }

    const cogs = await costLayersService.getCOGSForPeriod(
      tenant_id,
      new Date(startDate as string),
      new Date(endDate as string),
      itemId as string | undefined,
      locationId as string | undefined
    );

    res.json({
      success: true,
      data: cogs
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cost-layers
 * Create a new cost layer (for receipts, adjustments, etc.)
 */
router.post('/', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const {
      item_id,
      location_id,
      uom,
      quantity,
      unit_cost,
      source_type,
      source_document_id,
      movement_id,
      lot_id,
      layer_date,
      notes
    } = req.body;

    // Validation
    if (!item_id || !location_id || !uom || !quantity || unit_cost === undefined || !source_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: item_id, location_id, uom, quantity, unit_cost, source_type'
      });
    }

    const layer = await costLayersService.createCostLayer({
      tenant_id,
      item_id,
      location_id,
      uom,
      quantity: parseFloat(quantity),
      unit_cost: parseFloat(unit_cost),
      source_type,
      source_document_id,
      movement_id,
      lot_id,
      layer_date: layer_date ? new Date(layer_date) : undefined,
      notes
    });

    res.status(201).json({
      success: true,
      data: layer
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cost-layers/consume
 * Consume from cost layers (FIFO)
 */
router.post('/consume', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const {
      item_id,
      location_id,
      quantity,
      consumption_type,
      consumption_document_id,
      movement_id,
      consumed_at,
      lot_id,
      notes
    } = req.body;

    // Validation
    if (!item_id || !location_id || !quantity || !consumption_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: item_id, location_id, quantity, consumption_type'
      });
    }

    const result = await costLayersService.consumeCostLayers({
      tenant_id,
      item_id,
      location_id,
      quantity: parseFloat(quantity),
      consumption_type,
      consumption_document_id,
      movement_id,
      consumed_at: consumed_at ? new Date(consumed_at) : undefined,
      lot_id,
      notes
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/cost-layers/:layerId
 * Delete a cost layer (only if not consumed)
 */
router.delete('/:layerId', async (req, res, next) => {
  try {
    const tenant_id = (req as any).tenant.id;
    const { layerId } = req.params;

    await costLayersService.deleteCostLayer(tenant_id, layerId);

    res.json({
      success: true,
      message: 'Cost layer deleted successfully'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
