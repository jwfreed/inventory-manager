import type { Request, Response, NextFunction } from 'express';

/**
 * Common error handler patterns for route error handling
 */
export type ErrorHandlerMap = Record<string, (error: Error) => { status: number; body: any }>;

/**
 * Higher-order function to create async error handling middleware
 * Catches errors from async route handlers and maps them to HTTP responses
 */
export function asyncErrorHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<any>,
  errorMap?: ErrorHandlerMap
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      // Check custom error map first
      if (errorMap && error?.message && errorMap[error.message]) {
        const mapped = errorMap[error.message](error);
        return res.status(mapped.status).json(mapped.body);
      }
      
      // Default error response
      console.error(error);
      return res.status(500).json({ 
        error: 'An internal server error occurred.',
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
      });
    }
  };
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(status: number, message: string, details?: any) {
  return { status, body: { error: message, ...(details && { details }) } };
}

/**
 * Common service error mappings for adjustments
 */
export const adjustmentErrorMap: ErrorHandlerMap = {
  'ADJUSTMENT_NOT_FOUND': () => createErrorResponse(404, 'Inventory adjustment not found.'),
  'ADJUSTMENT_DUPLICATE_LINE': () => createErrorResponse(400, 'Line numbers must be unique within an adjustment.'),
  'ADJUSTMENT_CORRECTION_NOT_FOUND': () => createErrorResponse(400, 'Correction source adjustment was not found.'),
  'ADJUSTMENT_CORRECTION_NOT_POSTED': () => createErrorResponse(409, 'Only posted adjustments can be corrected.'),
  'ADJUSTMENT_IMMUTABLE': () => createErrorResponse(409, 'Posted adjustments cannot be edited. Create a reversal adjustment instead.'),
  'ADJUSTMENT_CANCELED': () => createErrorResponse(409, 'Canceled adjustments cannot be edited.'),
  'ADJUSTMENT_CORRECTION_SELF': () => createErrorResponse(400, 'Adjustment cannot correct itself.'),
  'ADJUSTMENT_ALREADY_POSTED': () => createErrorResponse(409, 'Adjustment has already been posted.'),
  'ADJUSTMENT_ALREADY_CANCELED': () => createErrorResponse(409, 'Adjustment has already been canceled.'),
  'ADJUSTMENT_NOT_CANCELLABLE': () => createErrorResponse(409, 'Only draft adjustments can be canceled.'),
  'ADJUSTMENT_NO_LINES': () => createErrorResponse(400, 'Adjustment must have at least one line.'),
  'ADJUSTMENT_LINE_ZERO': () => createErrorResponse(400, 'Adjustment line quantity cannot be zero.'),
};

/**
 * Common service error mappings for purchase orders
 */
export const purchaseOrderErrorMap: ErrorHandlerMap = {
  'PO_NOT_FOUND': () => createErrorResponse(404, 'Purchase order not found.'),
  'PO_DUPLICATE_LINE_NUMBERS': () => createErrorResponse(400, 'Line numbers must be unique within a purchase order.'),
  'PO_LINES_LOCKED': () => createErrorResponse(409, 'Purchase order lines are locked after submission.'),
  'PO_EDIT_LOCKED': () => createErrorResponse(409, 'Purchase order is locked after submission.'),
  'PO_STATUS_INVALID_TRANSITION': () => createErrorResponse(409, 'Invalid purchase order status transition.'),
  'PO_CANCEL_USE_ENDPOINT': () => createErrorResponse(409, 'Use the cancel endpoint to cancel a purchase order.'),
  'PO_APPROVE_USE_ENDPOINT': () => createErrorResponse(409, 'Use the approve endpoint to approve a purchase order.'),
  'PO_STATUS_MANAGED_BY_RECEIPTS': () => createErrorResponse(409, 'Purchase order status is managed by receipts.'),
  'PO_ALREADY_APPROVED': () => createErrorResponse(409, 'Purchase order has already been approved.'),
  'PO_ALREADY_CANCELED': () => createErrorResponse(409, 'Purchase order has already been canceled.'),
  'PO_CANCEL_NOT_DRAFT': () => createErrorResponse(409, 'Only draft purchase orders can be canceled.'),
};

/**
 * Common service error mappings for work orders
 */
export const workOrderErrorMap: ErrorHandlerMap = {
  'WO_NOT_FOUND': () => createErrorResponse(404, 'Work order not found.'),
  'WO_BOM_NOT_FOUND': () => createErrorResponse(400, 'BOM not found.'),
  'WO_BOM_ITEM_MISMATCH': () => createErrorResponse(400, 'BOM output item must match work order output item.'),
  'WO_BOM_VERSION_NOT_FOUND': () => createErrorResponse(400, 'BOM version not found.'),
  'WO_BOM_VERSION_MISMATCH': () => createErrorResponse(400, 'BOM version does not belong to the specified BOM.'),
};

/**
 * Check for service errors that start with a specific prefix
 */
export function matchErrorPrefix(prefix: string, message: string): (error: Error) => { status: number; body: any } | null {
  return (error: Error) => {
    if (error?.message?.startsWith?.(prefix)) {
      return createErrorResponse(409, `Operation failed: ${error.message}`);
    }
    return null;
  };
}
