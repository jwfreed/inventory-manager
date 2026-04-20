import Decimal from 'decimal.js';
import { query } from '../db';
import { canonicalizeRequiredUom } from './uomCanonical.service';
import {
  resolveUomWithMeta,
  suggestUomCodes,
  type UomDef,
  type UomResolutionMeta
} from './uomRegistry.service';
import { mapUomStatusToRouting } from './uomSeverityRouting.service';
import type {
  UomDiagnosticSeverity,
  UomNormalizationStatus,
  UomResolutionTrace
} from '../types/uomNormalization';

export type UomRoundingContext = 'receipt' | 'issue' | 'count' | 'transfer';

export type ConvertQtyInput = {
  qty: number | string;
  fromUom: string;
  toUom: string;
  roundingContext?: UomRoundingContext;
  contextPrecision?: number;
  tenantId?: string;
  itemId?: string;
  analyticsPrecisionMode?: boolean;
};

export type ConvertQtyResult = {
  qty: string;
  exactQty: string;
  warnings: string[];
  status: UomNormalizationStatus;
  severity: UomDiagnosticSeverity;
  canAggregate: boolean;
  traces: UomResolutionTrace[];
};

export type UomConversionErrorCode =
  | 'UOM_UNKNOWN'
  | 'UOM_INACTIVE'
  | 'UOM_DIMENSION_MISMATCH'
  | 'UOM_INVALID_QTY'
  | 'UOM_CONVERSION_MISSING';

export type UomConversionError = Error & {
  code: UomConversionErrorCode;
  context?: Record<string, unknown>;
};

function conversionError(
  code: UomConversionErrorCode,
  detail: string,
  context?: Record<string, unknown>
): UomConversionError {
  const error = new Error(detail) as UomConversionError;
  error.code = code;
  if (context) {
    error.context = context;
  }
  return error;
}

function parseDecimalQty(value: number | string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) {
      throw new Error('not finite');
    }
    return parsed;
  } catch {
    throw conversionError('UOM_INVALID_QTY', `Invalid conversion qty: ${value}`, {
      inputQty: value
    });
  }
}

function normalizePrecision(targetPrecision: number, contextPrecision?: number) {
  const boundedTarget = Number.isFinite(targetPrecision) ? Math.max(0, Math.floor(targetPrecision)) : 6;
  if (contextPrecision === undefined || contextPrecision === null) return boundedTarget;
  const boundedContext = Math.max(0, Math.floor(contextPrecision));
  return Math.min(boundedTarget, boundedContext);
}

function roundingModeForContext(context: UomRoundingContext) {
  switch (context) {
    case 'receipt':
      return Decimal.ROUND_FLOOR;
    case 'issue':
      return Decimal.ROUND_CEIL;
    case 'count':
      return Decimal.ROUND_HALF_UP;
    case 'transfer':
    default:
      return Decimal.ROUND_HALF_UP;
  }
}

type ActiveResolvedUom = {
  def: UomDef;
  meta: UomResolutionMeta;
};

async function resolveActiveDefinition(code: string): Promise<ActiveResolvedUom> {
  const resolved = await resolveUomWithMeta(code);
  if (!resolved.def) {
    const suggestions = await suggestUomCodes(code, 5);
    const routing = mapUomStatusToRouting('UNKNOWN_UOM');
    throw conversionError('UOM_UNKNOWN', `Unknown UOM code: ${code}`, {
      inputUomCode: code,
      suggestions,
      status: 'UNKNOWN_UOM',
      severity: routing.severity,
      canAggregate: routing.canAggregate
    });
  }
  if (!resolved.def.active) {
    throw conversionError('UOM_INACTIVE', `Inactive UOM code: ${code}`, {
      inputUomCode: code,
      resolvedCanonical: resolved.def.code
    });
  }
  return {
    def: resolved.def,
    meta: resolved.meta
  };
}

function resolveRegistryTrace(input: {
  status: UomNormalizationStatus;
  source: UomResolutionTrace['source'];
  fromMeta: UomResolutionMeta;
  toMeta: UomResolutionMeta;
  itemId?: string;
  detailCode?: string;
  detail?: string;
}): UomResolutionTrace {
  const routing = mapUomStatusToRouting(input.status);
  return {
    status: input.status,
    severity: routing.severity,
    canAggregate: routing.canAggregate,
    source: input.source,
    inputUomCode: input.fromMeta.inputUomCode,
    resolvedFromUom: input.fromMeta.resolvedCanonical ?? undefined,
    resolvedToUom: input.toMeta.resolvedCanonical ?? undefined,
    itemId: input.itemId,
    detailCode: input.detailCode,
    detail: input.detail
  };
}

async function resolveKnownUoms(fromUom: string, toUom: string): Promise<{
  from: ActiveResolvedUom;
  to: ActiveResolvedUom;
}> {
  const [from, to] = await Promise.all([resolveActiveDefinition(fromUom), resolveActiveDefinition(toUom)]);
  if (from.def.dimension !== to.def.dimension) {
    const routing = mapUomStatusToRouting('DIMENSION_MISMATCH');
    throw conversionError(
      'UOM_DIMENSION_MISMATCH',
      `Dimension mismatch: ${from.def.code}(${from.def.dimension}) -> ${to.def.code}(${to.def.dimension})`,
      {
        fromUom: from.def.code,
        toUom: to.def.code,
        fromDimension: from.def.dimension,
        toDimension: to.def.dimension,
        status: 'DIMENSION_MISMATCH',
        severity: routing.severity,
        canAggregate: routing.canAggregate
      }
    );
  }
  return { from, to };
}

function convertUsingRegistry(qty: Decimal, defs: { from: UomDef; to: UomDef }) {
  const qtyBase = qty.mul(new Decimal(defs.from.toBaseFactor));
  return qtyBase.div(new Decimal(defs.to.toBaseFactor));
}

async function lookupItemOverrideFactor(
  tenantId: string,
  itemId: string,
  fromUom: string,
  toUom: string
): Promise<Decimal | null> {
  const direct = await query<{ multiplier: string }>(
    `SELECT multiplier::text
       FROM item_uom_overrides
      WHERE tenant_id = $1
        AND item_id = $2
        AND active = true
        AND LOWER(from_uom) = LOWER($3)
        AND LOWER(to_uom) = LOWER($4)
      LIMIT 1`,
    [tenantId, itemId, fromUom, toUom]
  );
  if (direct.rowCount && direct.rows[0]) {
    return new Decimal(direct.rows[0].multiplier);
  }

  const reverse = await query<{ multiplier: string }>(
    `SELECT multiplier::text
       FROM item_uom_overrides
      WHERE tenant_id = $1
        AND item_id = $2
        AND active = true
        AND LOWER(from_uom) = LOWER($4)
        AND LOWER(to_uom) = LOWER($3)
      LIMIT 1`,
    [tenantId, itemId, fromUom, toUom]
  );
  if (reverse.rowCount && reverse.rows[0]) {
    return new Decimal(1).div(new Decimal(reverse.rows[0].multiplier));
  }
  return null;
}

function buildResult(input: {
  exactQty: Decimal;
  targetPrecision: number;
  roundingContext: UomRoundingContext;
  contextPrecision?: number;
  warnings?: string[];
  analyticsPrecisionMode?: boolean;
  traces: UomResolutionTrace[];
  status: UomNormalizationStatus;
}): ConvertQtyResult {
  const effectivePrecision = normalizePrecision(input.targetPrecision, input.contextPrecision);
  const roundingMode = roundingModeForContext(input.roundingContext);
  const roundedQty = input.exactQty.toDecimalPlaces(effectivePrecision, roundingMode);
  const routing = mapUomStatusToRouting(input.status);

  return {
    qty: input.analyticsPrecisionMode ? input.exactQty.toString() : roundedQty.toString(),
    exactQty: input.exactQty.toString(),
    warnings: input.warnings ?? [],
    status: input.status,
    severity: routing.severity,
    canAggregate: routing.canAggregate,
    traces: input.traces
  };
}

export async function convertQty(input: ConvertQtyInput): Promise<ConvertQtyResult> {
  const roundingContext = input.roundingContext ?? 'transfer';
  const qty = parseDecimalQty(input.qty);
  const fromUom = canonicalizeRequiredUom(input.fromUom);
  const toUom = canonicalizeRequiredUom(input.toUom);
  const warnings: string[] = [];
  let targetPrecision = 6;

  let registryError: UomConversionError | null = null;
  try {
    const defs = await resolveKnownUoms(fromUom, toUom);
    targetPrecision = defs.to.def.precision;
    const exact = convertUsingRegistry(qty, { from: defs.from.def, to: defs.to.def });
    const source: UomResolutionTrace['source'] = defs.from.meta.aliasMatched || defs.to.meta.aliasMatched ? 'alias' : 'registry';
    const trace = resolveRegistryTrace({
      status: 'OK',
      source,
      fromMeta: defs.from.meta,
      toMeta: defs.to.meta,
      itemId: input.itemId,
      detailCode: source === 'alias' ? 'UOM_ALIAS_RESOLVED' : undefined,
      detail:
        source === 'alias'
          ? `Resolved alias to canonical codes (${defs.from.def.code} -> ${defs.to.def.code})`
          : undefined
    });

    return buildResult({
      exactQty: exact,
      targetPrecision,
      roundingContext,
      contextPrecision: input.contextPrecision,
      warnings,
      analyticsPrecisionMode: input.analyticsPrecisionMode,
      traces: [trace],
      status: 'OK'
    });
  } catch (error) {
    registryError = error as UomConversionError;
    if (registryError.code === 'UOM_DIMENSION_MISMATCH') {
      throw registryError;
    }
  }

  if (!input.tenantId || !input.itemId) {
    if (registryError?.code === 'UOM_UNKNOWN') {
      throw registryError;
    }
    throw conversionError('UOM_CONVERSION_MISSING', `Conversion missing for ${fromUom} -> ${toUom}`, {
      fromUom,
      toUom,
      status: 'INCONSISTENT',
      ...mapUomStatusToRouting('INCONSISTENT')
    });
  }

  const overrideFactor = await lookupItemOverrideFactor(input.tenantId, input.itemId, fromUom, toUom);
  if (overrideFactor && overrideFactor.gt(0)) {
    warnings.push('UOM_REGISTRY_FALLBACK_ITEM_OVERRIDE');
    const trace = resolveRegistryTrace({
      status: 'OK',
      source: 'item_override',
      fromMeta: {
        inputUomCode: fromUom,
        normalizedInput: fromUom.toLowerCase(),
        resolvedCanonical: fromUom,
        aliasMatched: false
      },
      toMeta: {
        inputUomCode: toUom,
        normalizedInput: toUom.toLowerCase(),
        resolvedCanonical: toUom,
        aliasMatched: false
      },
      itemId: input.itemId,
      detailCode: 'UOM_OVERRIDE_USED',
      detail: `Conversion resolved via item_uom_overrides (${fromUom}->${toUom})`
    });

    return buildResult({
      exactQty: qty.mul(overrideFactor),
      targetPrecision,
      roundingContext,
      contextPrecision: input.contextPrecision,
      warnings,
      analyticsPrecisionMode: input.analyticsPrecisionMode,
      traces: [trace],
      status: 'OK'
    });
  }

  if (registryError?.code === 'UOM_UNKNOWN') {
    throw registryError;
  }
  throw conversionError(
    'UOM_CONVERSION_MISSING',
    `Conversion missing for ${fromUom} -> ${toUom} (item ${input.itemId})`,
    {
      fromUom,
      toUom,
      itemId: input.itemId,
      tenantId: input.tenantId,
      status: 'INCONSISTENT',
      ...mapUomStatusToRouting('INCONSISTENT')
    }
  );
}
