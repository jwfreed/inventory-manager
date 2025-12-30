import { getInventoryNegativePolicy } from '../config/inventoryPolicy';
import { getInventorySnapshot } from './inventorySnapshot.service';
import { roundQuantity, toNumber } from '../lib/numbers';

export type StockValidationLine = {
  itemId: string;
  locationId: string;
  uom: string;
  quantityToConsume: number;
};

export type StockValidationContext = {
  actorId?: string | null;
  actorRole?: string | null;
  overrideRequested?: boolean;
  overrideReason?: string | null;
};

export type StockValidationResult = {
  overrideMetadata?: {
    negative_override: true;
    override_reason?: string | null;
    override_actor_id?: string | null;
  };
};

export type StockShortageDetail = {
  itemId: string;
  locationId: string;
  uom: string;
  requested: number;
  available: number;
  shortage: number;
};

export class StockValidationError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 409, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = { message, ...details };
  }
}

export async function validateSufficientStock(
  tenantId: string,
  occurredAt: Date,
  lines: StockValidationLine[],
  context: StockValidationContext = {}
): Promise<StockValidationResult> {
  const policy = getInventoryNegativePolicy();
  const grouped = new Map<string, StockValidationLine>();

  for (const line of lines) {
    const qty = roundQuantity(toNumber(line.quantityToConsume));
    if (qty <= 0) continue;
    const key = `${line.itemId}:${line.locationId}:${line.uom}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantityToConsume = roundQuantity(existing.quantityToConsume + qty);
    } else {
      grouped.set(key, { ...line, quantityToConsume: qty });
    }
  }

  if (grouped.size === 0) {
    return {};
  }

  const shortages: StockShortageDetail[] = [];

  for (const line of grouped.values()) {
    // TODO: inventory snapshot is current-state only; extend to historical as needed for occurredAt fidelity.
    const snapshot = await getInventorySnapshot(tenantId, {
      itemId: line.itemId,
      locationId: line.locationId,
      uom: line.uom
    });
    const availableRow = snapshot.find((row) => row.uom === line.uom);
    const available = roundQuantity(toNumber(availableRow?.available ?? 0));
    const requested = roundQuantity(line.quantityToConsume);
    if (requested - available > 1e-6) {
      shortages.push({
        itemId: line.itemId,
        locationId: line.locationId,
        uom: line.uom,
        requested,
        available,
        shortage: roundQuantity(requested - available)
      });
    }
  }

  if (shortages.length === 0) {
    return {};
  }

  if (!policy.allowNegativeInventory) {
    if (!policy.allowNegativeWithOverride || !context.overrideRequested) {
      throw new StockValidationError(
        'INSUFFICIENT_STOCK',
        'Insufficient usable stock to post this transaction.',
        409,
        {
          occurredAt: occurredAt.toISOString(),
          lines: shortages,
          overrideAllowed: policy.allowNegativeWithOverride,
          overrideRequiresReason: policy.overrideRequiresReason,
          overrideRequiresRole: policy.overrideRequiresRole
        }
      );
    }

    if (policy.overrideRequiresRole) {
      const actorRole = context.actorRole ?? '';
      if (!policy.allowedRolesForOverride.includes(actorRole)) {
        throw new StockValidationError(
          'NEGATIVE_OVERRIDE_NOT_ALLOWED',
          'Negative inventory override is not allowed for this role.',
          403,
          { occurredAt: occurredAt.toISOString(), lines: shortages }
        );
      }
    }

    if (policy.overrideRequiresReason && !context.overrideReason) {
      throw new StockValidationError(
        'NEGATIVE_OVERRIDE_REQUIRES_REASON',
        'Negative inventory override requires a reason.',
        409,
        { occurredAt: occurredAt.toISOString(), lines: shortages }
      );
    }

    return {
      overrideMetadata: {
        negative_override: true,
        override_reason: context.overrideReason ?? null,
        override_actor_id: context.actorId ?? null
      }
    };
  }

  if (policy.allowNegativeWithOverride && context.overrideRequested) {
    if (policy.overrideRequiresReason && !context.overrideReason) {
      throw new StockValidationError(
        'NEGATIVE_OVERRIDE_REQUIRES_REASON',
        'Negative inventory override requires a reason.',
        409,
        { occurredAt: occurredAt.toISOString(), lines: shortages }
      );
    }
    return {
      overrideMetadata: {
        negative_override: true,
        override_reason: context.overrideReason ?? null,
        override_actor_id: context.actorId ?? null
      }
    };
  }

  throw new StockValidationError(
    'INSUFFICIENT_STOCK',
    'Insufficient usable stock to post this transaction.',
    409,
    {
      occurredAt: occurredAt.toISOString(),
      lines: shortages,
      overrideAllowed: policy.allowNegativeWithOverride,
      overrideRequiresReason: policy.overrideRequiresReason,
      overrideRequiresRole: policy.overrideRequiresRole
    }
  );
}
