import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { itemUomPolicyPatchSchema, uomConvertPreviewSchema } from '../schemas/masterData.schema';

const uuidSchema = z.string().uuid();

type UomLikeError = Error & {
  code?: string;
  context?: Record<string, unknown>;
};

type UomConvertDeps = {
  enforceUomRegistry: boolean;
  assertUomActive: (code: string) => Promise<any>;
  convertQty: (input: any) => Promise<any>;
  warn?: (event: string, meta?: Record<string, unknown>) => void;
};

type PatchItemUomDeps = {
  enforceUomRegistry: boolean;
  assertUomActive: (code: string) => Promise<any>;
  updateItemUomPolicy: (tenantId: string, itemId: string, body: any) => Promise<any>;
};

function stableContextFromError(error: UomLikeError): Record<string, unknown> | undefined {
  const raw = error.context;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const context: Record<string, unknown> = { ...raw };
  if (!('suggestedCodes' in context) && Array.isArray(context.suggestions)) {
    context.suggestedCodes = context.suggestions;
  }
  return context;
}

export function toStableUomErrorPayload(error: unknown): {
  code: string;
  message: string;
  context?: Record<string, unknown>;
} {
  const typed = (error instanceof Error ? error : new Error(String(error ?? 'UOM_ERROR'))) as UomLikeError;
  const code = typeof typed.code === 'string' && typed.code.length > 0 ? typed.code : 'UOM_ERROR';
  const message = typeof typed.message === 'string' && typed.message.length > 0 ? typed.message : code;
  const context = stableContextFromError(typed);
  return {
    code,
    message,
    ...(context ? { context } : {})
  };
}

function isUomCodeError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('UOM_');
}

function asTenantId(req: Request) {
  return req.auth?.tenantId;
}

export function createUomConvertHandler(deps: UomConvertDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    const parsed = uomConvertPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      if (deps.enforceUomRegistry) {
        await Promise.all([
          deps.assertUomActive(parsed.data.fromUom),
          deps.assertUomActive(parsed.data.toUom)
        ]);
      } else {
        await Promise.all([
          deps.assertUomActive(parsed.data.fromUom).catch((error) => {
            deps.warn?.('uom_registry_warning_from', {
              code: (error as { code?: string })?.code,
              input: parsed.data.fromUom
            });
          }),
          deps.assertUomActive(parsed.data.toUom).catch((error) => {
            deps.warn?.('uom_registry_warning_to', {
              code: (error as { code?: string })?.code,
              input: parsed.data.toUom
            });
          })
        ]);
      }

      const converted = await deps.convertQty({
        qty: parsed.data.qty,
        fromUom: parsed.data.fromUom,
        toUom: parsed.data.toUom,
        roundingContext: parsed.data.roundingContext,
        contextPrecision: parsed.data.contextPrecision,
        tenantId: asTenantId(req),
        itemId: parsed.data.itemId
      });
      return res.json(converted);
    } catch (error) {
      if (isUomCodeError(error)) {
        return res.status(400).json({ error: toStableUomErrorPayload(error) });
      }
      console.error(error);
      return res.status(500).json({ error: 'Failed to convert quantity.' });
    }
  };
}

export function createPatchItemUomHandler(deps: PatchItemUomDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!uuidSchema.safeParse(id).success) {
      return res.status(400).json({ error: 'Invalid item id.' });
    }

    const parsed = itemUomPolicyPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      if (deps.enforceUomRegistry) {
        const resolved = await deps.assertUomActive(parsed.data.stockingUom);
        if (resolved.dimension !== parsed.data.uomDimension) {
          return res.status(400).json({
            error: {
              code: 'UOM_DIMENSION_MISMATCH',
              message: `Stocking UOM ${resolved.code} does not match dimension ${parsed.data.uomDimension}.`,
              context: {
                stockingUom: resolved.code,
                expectedDimension: parsed.data.uomDimension,
                actualDimension: resolved.dimension
              }
            }
          });
        }
      }

      const tenantId = asTenantId(req);
      if (!tenantId) {
        return res.status(401).json({ error: 'Unauthorized.' });
      }

      const updated = await deps.updateItemUomPolicy(tenantId, id, parsed.data);
      if (!updated) {
        return res.status(404).json({ error: 'Item not found.' });
      }
      return res.json(updated);
    } catch (error) {
      if (isUomCodeError(error)) {
        return res.status(400).json({ error: toStableUomErrorPayload(error) });
      }
      console.error(error);
      return res.status(500).json({ error: 'Failed to update item UOM policy.' });
    }
  };
}
