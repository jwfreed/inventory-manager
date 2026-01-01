// @ts-nocheck
/**
 * EXAMPLE REFACTORED ROUTES - NOT YET FUNCTIONAL
 * 
 * This file demonstrates the refactored pattern using validation middleware.
 * It requires the purchaseOrders service to be modularized first.
 * 
 * The purchaseOrders.service.ts currently only exports from './purchaseOrders'
 * but the modular structure hasn't been fully implemented yet.
 * 
 * To make this functional:
 * 1. Create src/services/purchaseOrders/ directory structure
 * 2. Implement core.service.ts with CRUD operations
 * 3. Implement lifecycle.service.ts with approve/cancel logic
 * 4. Export all functions from the index.ts barrel
 * 
 * For now, use the original purchaseOrders.routes.ts file.
 */

import { Router, type Request, type Response } from 'express';
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrderById,
  listPurchaseOrders,
  updatePurchaseOrder
} from '../services/purchaseOrders.service';
import { purchaseOrderSchema, purchaseOrderUpdateSchema } from '../schemas/purchaseOrders.schema';
import { mapPgErrorToHttp } from '../lib/pgErrors';
import { emitEvent } from '../lib/events';
import {
  validateBody,
  validateUuidParam,
  validatePagination,
  asyncErrorHandler,
  purchaseOrderErrorMap,
  matchErrorPrefix
} from '../middleware/validation';

const router = Router();

// POST /purchase-orders - Create new purchase order
router.post(
  '/purchase-orders',
  validateBody(purchaseOrderSchema),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const purchaseOrder = await createPurchaseOrder(tenantId, req.validatedBody, { 
      type: 'user', 
      id: req.auth!.userId 
    });
    
    const itemIds = Array.from(new Set(purchaseOrder.lines.map((line: any) => line.itemId)));
    const locationIds = Array.from(
      new Set([purchaseOrder.shipToLocationId, purchaseOrder.receivingLocationId].filter(Boolean))
    );
    
    emitEvent(tenantId, 'inventory.purchase_order.created', {
      purchaseOrderId: purchaseOrder.id,
      status: purchaseOrder.status,
      itemIds,
      locationIds
    });
    
    return res.status(201).json(purchaseOrder);
  }, {
    ...purchaseOrderErrorMap,
    ...((error: any) => {
      // Handle PO_SUBMIT_* errors
      const submitError = matchErrorPrefix('PO_SUBMIT_', error.message)?.(error);
      if (submitError) {
        return { status: 409, body: { error: 'Purchase order is not ready to submit.' } };
      }
      
      // Handle database constraints
      const mapped = mapPgErrorToHttp(error, {
        unique: () => ({ status: 409, body: { error: 'PO number must be unique.' } }),
        foreignKey: () => ({ status: 400, body: { error: 'Referenced vendor, item, or location does not exist.' } })
      });
      return mapped ? { status: mapped.status, body: mapped.body } : null;
    })
  } as any)
);

// GET /purchase-orders/:id - Get purchase order by ID
router.get(
  '/purchase-orders/:id',
  validateUuidParam('id'),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const po = await getPurchaseOrderById(req.auth!.tenantId, id);
    if (!po) {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    return res.json(po);
  })
);

// GET /purchase-orders - List purchase orders with pagination
router.get(
  '/purchase-orders',
  validatePagination(20, 100),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { limit, offset } = req.pagination!;
    const rows = await listPurchaseOrders(req.auth!.tenantId, limit, offset);
    return res.json({ data: rows, paging: { limit, offset } });
  })
);

// PUT /purchase-orders/:id - Update purchase order
router.put(
  '/purchase-orders/:id',
  validateUuidParam('id'),
  validateBody(purchaseOrderUpdateSchema),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const tenantId = req.auth!.tenantId;
    
    const po = await updatePurchaseOrder(tenantId, id, req.validatedBody, { 
      type: 'user', 
      id: req.auth!.userId 
    });
    
    const itemIds = Array.from(new Set(po.lines.map((line: any) => line.itemId)));
    const locationIds = Array.from(new Set([po.shipToLocationId, po.receivingLocationId].filter(Boolean)));
    
    emitEvent(tenantId, 'inventory.purchase_order.updated', {
      purchaseOrderId: po.id,
      status: po.status,
      itemIds,
      locationIds
    });
    
    return res.json(po);
  }, {
    ...purchaseOrderErrorMap,
    ...((error: any) => {
      // Handle PO_SUBMIT_* errors
      const submitError = matchErrorPrefix('PO_SUBMIT_', error.message)?.(error);
      if (submitError) {
        return { status: 409, body: { error: 'Purchase order is not ready to submit.' } };
      }
      
      // Handle database constraints
      const mapped = mapPgErrorToHttp(error, {
        foreignKey: () => ({ status: 400, body: { error: 'Referenced vendor, item, or location does not exist.' } })
      });
      return mapped ? { status: mapped.status, body: mapped.body } : null;
    })
  } as any)
);

// POST /purchase-orders/:id/approve - Approve purchase order
router.post(
  '/purchase-orders/:id/approve',
  validateUuidParam('id'),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const tenantId = req.auth!.tenantId;
    
    const po = await approvePurchaseOrder(tenantId, id, { 
      type: 'user', 
      id: req.auth!.userId 
    });
    
    emitEvent(tenantId, 'inventory.purchase_order.approved', {
      purchaseOrderId: po.id,
      status: po.status
    });
    
    return res.json(po);
  }, purchaseOrderErrorMap)
);

// POST /purchase-orders/:id/cancel - Cancel purchase order
router.post(
  '/purchase-orders/:id/cancel',
  validateUuidParam('id'),
  asyncErrorHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const tenantId = req.auth!.tenantId;
    
    const po = await cancelPurchaseOrder(tenantId, id, { 
      type: 'user', 
      id: req.auth!.userId 
    });
    
    emitEvent(tenantId, 'inventory.purchase_order.canceled', {
      purchaseOrderId: po.id,
      status: po.status
    });
    
    return res.json(po);
  }, purchaseOrderErrorMap)
);

export default router;
