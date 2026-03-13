import type { PoolClient } from 'pg';
import { query } from '../db';
import { getItem } from './masterData.service';

export type ManufacturingStageType = 'wrapped_bar' | 'boxing' | 'generic_production' | 'disassembly';

export type RoutingLocationHint = {
  id: string;
  code: string;
  name: string;
  role: string | null;
  warehouseId: string;
};

export type WorkOrderStageRouting = {
  stageType: ManufacturingStageType;
  stageLabel: string;
  defaultConsumeLocation: RoutingLocationHint | null;
  defaultProduceLocation: RoutingLocationHint | null;
  routingLocked: true;
};

type WorkOrderRoutingContext = {
  kind: string;
  outputItemId: string;
  bomId?: string | null;
  defaultConsumeLocationId?: string | null;
  defaultProduceLocationId?: string | null;
  produceToLocationIdSnapshot?: string | null;
};

type ComponentDescriptor = {
  componentItemId: string;
};

type LocationRow = {
  id: string;
  code: string;
  local_code: string | null;
  name: string;
  role: string | null;
  warehouse_id: string | null;
};

async function resolveLocationById(
  tenantId: string,
  locationId: string,
  client?: PoolClient
): Promise<RoutingLocationHint | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<LocationRow>(
    `SELECT id, code, local_code, name, role, warehouse_id
       FROM locations
      WHERE tenant_id = $1
        AND id = $2`,
    [tenantId, locationId]
  );
  const row = res.rows[0];
  if (!row?.warehouse_id) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    role: row.role,
    warehouseId: row.warehouse_id
  };
}

async function resolveWarehouseId(
  tenantId: string,
  context: WorkOrderRoutingContext,
  client?: PoolClient
) {
  const locationsToTry = [
    context.produceToLocationIdSnapshot ?? null,
    context.defaultProduceLocationId ?? null,
    context.defaultConsumeLocationId ?? null
  ].filter((value): value is string => Boolean(value));
  for (const locationId of locationsToTry) {
    const resolved = await resolveLocationById(tenantId, locationId, client);
    if (resolved?.warehouseId) {
      return resolved.warehouseId;
    }
  }
  return null;
}

async function resolveLocationBySemantic(
  tenantId: string,
  warehouseId: string,
  params: {
    roles: string[];
    localCodes: string[];
    codeHints: string[];
  },
  client?: PoolClient
): Promise<RoutingLocationHint | null> {
  const executor = client ? client.query.bind(client) : query;
  const res = await executor<LocationRow>(
    `SELECT id, code, local_code, name, role, warehouse_id
       FROM locations
      WHERE tenant_id = $1
        AND warehouse_id = $2
      ORDER BY
        CASE WHEN role = ANY($3::text[]) THEN 0 ELSE 1 END,
        CASE WHEN local_code = ANY($4::text[]) THEN 0 ELSE 1 END,
        CASE WHEN code = ANY($5::text[]) THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC`,
    [tenantId, warehouseId, params.roles, params.localCodes, params.codeHints]
  );

  const row = res.rows.find((candidate) => {
    const roleMatch = params.roles.includes(candidate.role ?? '');
    const localCodeMatch = params.localCodes.includes(candidate.local_code ?? '');
    const codeMatch = params.codeHints.includes(candidate.code);
    return roleMatch || localCodeMatch || codeMatch;
  });
  if (!row?.warehouse_id) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    role: row.role,
    warehouseId: row.warehouse_id
  };
}

async function inferStageType(
  tenantId: string,
  context: WorkOrderRoutingContext,
  client?: PoolClient
): Promise<ManufacturingStageType> {
  if (context.kind === 'disassembly') return 'disassembly';
  const outputItem = await getItem(tenantId, context.outputItemId);
  if (outputItem?.type === 'wip') return 'wrapped_bar';
  if (outputItem?.type === 'finished' && context.bomId) {
    const executor = client ? client.query.bind(client) : query;
    const componentRes = await executor<{ item_type: string | null }>(
      `SELECT DISTINCT i.type AS item_type
         FROM bom_version_lines bvl
         JOIN bom_versions bv
           ON bv.id = bvl.bom_version_id
          AND bv.tenant_id = bvl.tenant_id
         JOIN items i
           ON i.id = bvl.component_item_id
          AND i.tenant_id = bvl.tenant_id
        WHERE bv.bom_id = $1
          AND bv.tenant_id = $2`,
      [context.bomId, tenantId]
    );
    if (componentRes.rows.some((row) => row.item_type === 'wip')) {
      return 'boxing';
    }
  }
  return 'generic_production';
}

export async function deriveWorkOrderStageRouting(
  tenantId: string,
  context: WorkOrderRoutingContext,
  client?: PoolClient
): Promise<WorkOrderStageRouting> {
  const warehouseId = await resolveWarehouseId(tenantId, context, client);
  const stageType = await inferStageType(tenantId, context, client);
  if (!warehouseId) {
    return {
      stageType,
      stageLabel:
        stageType === 'boxing'
          ? 'Boxed Bar'
          : stageType === 'wrapped_bar'
            ? 'Wrapped Bar'
            : stageType === 'disassembly'
              ? 'Disassembly'
              : 'Production',
      defaultConsumeLocation: null,
      defaultProduceLocation: null,
      routingLocked: true
    };
  }

  const rmStore = await resolveLocationBySemantic(
    tenantId,
    warehouseId,
    {
      roles: ['RM_STORE'],
      localCodes: ['RM_STORE'],
      codeHints: ['FACTORY_RM_STORE', 'RM_STORE']
    },
    client
  );
  const packStore = await resolveLocationBySemantic(
    tenantId,
    warehouseId,
    {
      roles: ['PACKAGING'],
      localCodes: ['PACK_STORE'],
      codeHints: ['FACTORY_PACK_STORE', 'PACK_STORE']
    },
    client
  );
  const wipStore = await resolveLocationBySemantic(
    tenantId,
    warehouseId,
    {
      roles: ['WIP'],
      localCodes: ['PRODUCTION', 'WIP_WRAPPED'],
      codeHints: ['FACTORY_WIP_WRAPPED', 'FACTORY_PRODUCTION', 'WIP_WRAPPED_BAR']
    },
    client
  );
  const fgStage = await resolveLocationBySemantic(
    tenantId,
    warehouseId,
    {
      roles: ['FG_STAGE', 'FG_SELLABLE', 'SELLABLE'],
      localCodes: ['FG_STAGE', 'FG_STORE', 'SELLABLE'],
      codeHints: ['FACTORY_FG_STAGE', 'FACTORY_FG_STORE', 'FG_STORE']
    },
    client
  );

  const stageLabel =
    stageType === 'boxing'
      ? 'Boxed Bar'
      : stageType === 'wrapped_bar'
        ? 'Wrapped Bar'
        : stageType === 'disassembly'
          ? 'Disassembly'
          : 'Production';

  if (stageType === 'wrapped_bar') {
    const snapshotProduceLocation = context.produceToLocationIdSnapshot
      ? await resolveLocationById(tenantId, context.produceToLocationIdSnapshot, client)
      : null;
    return {
      stageType,
      stageLabel,
      defaultConsumeLocation: rmStore,
      defaultProduceLocation: wipStore ?? fgStage ?? snapshotProduceLocation,
      routingLocked: true
    };
  }

  if (stageType === 'boxing') {
    return {
      stageType,
      stageLabel,
      defaultConsumeLocation: wipStore ?? rmStore,
      defaultProduceLocation: fgStage ?? wipStore,
      routingLocked: true
    };
  }

  if (stageType === 'disassembly') {
    const fallbackConsumeLocation = context.defaultConsumeLocationId
      ? await resolveLocationById(tenantId, context.defaultConsumeLocationId, client)
      : null;
    return {
      stageType,
      stageLabel,
      defaultConsumeLocation: fgStage ?? fallbackConsumeLocation,
      defaultProduceLocation: wipStore ?? packStore ?? rmStore ?? fgStage,
      routingLocked: true
    };
  }

  return {
    stageType,
    stageLabel,
    defaultConsumeLocation: context.defaultConsumeLocationId
      ? await resolveLocationById(tenantId, context.defaultConsumeLocationId, client)
      : rmStore,
    defaultProduceLocation: context.produceToLocationIdSnapshot
      ? await resolveLocationById(tenantId, context.produceToLocationIdSnapshot, client)
      : context.defaultProduceLocationId
        ? await resolveLocationById(tenantId, context.defaultProduceLocationId, client)
        : fgStage ?? wipStore,
    routingLocked: true
  };
}

export async function deriveDisassemblyProduceLocation(
  tenantId: string,
  context: WorkOrderRoutingContext,
  component: ComponentDescriptor,
  client?: PoolClient
) {
  const routing = await deriveWorkOrderStageRouting(tenantId, context, client);
  const componentItem = await getItem(tenantId, component.componentItemId);
  const warehouseId = routing.defaultConsumeLocation?.warehouseId ?? routing.defaultProduceLocation?.warehouseId;
  if (!warehouseId) {
    return routing.defaultProduceLocation;
  }
  if (componentItem?.type === 'wip') {
    return resolveLocationBySemantic(
      tenantId,
      warehouseId,
      {
        roles: ['WIP'],
        localCodes: ['PRODUCTION', 'WIP_WRAPPED'],
        codeHints: ['FACTORY_WIP_WRAPPED', 'FACTORY_PRODUCTION', 'WIP_WRAPPED_BAR']
      },
      client
    );
  }
  if (componentItem?.type === 'packaging') {
    return resolveLocationBySemantic(
      tenantId,
      warehouseId,
      {
        roles: ['PACKAGING'],
        localCodes: ['PACK_STORE'],
        codeHints: ['FACTORY_PACK_STORE', 'PACK_STORE']
      },
      client
    );
  }
  if (componentItem?.type === 'finished') {
    return resolveLocationBySemantic(
      tenantId,
      warehouseId,
      {
        roles: ['FG_STAGE', 'FG_SELLABLE', 'SELLABLE'],
        localCodes: ['FG_STAGE', 'FG_STORE', 'SELLABLE'],
        codeHints: ['FACTORY_FG_STAGE', 'FACTORY_FG_STORE', 'FG_STORE']
      },
      client
    );
  }
  return resolveLocationBySemantic(
    tenantId,
    warehouseId,
    {
      roles: ['RM_STORE'],
      localCodes: ['RM_STORE'],
      codeHints: ['FACTORY_RM_STORE', 'RM_STORE']
    },
    client
  );
}

export async function deriveComponentConsumeLocation(
  tenantId: string,
  context: WorkOrderRoutingContext,
  component: ComponentDescriptor,
  client?: PoolClient
) {
  const routing = await deriveWorkOrderStageRouting(tenantId, context, client);
  if (routing.stageType !== 'boxing') {
    return routing.defaultConsumeLocation;
  }
  const componentItem = await getItem(tenantId, component.componentItemId);
  if (componentItem?.type === 'wip') {
    return routing.defaultConsumeLocation;
  }
  const warehouseId = routing.defaultConsumeLocation?.warehouseId ?? routing.defaultProduceLocation?.warehouseId;
  if (!warehouseId) return routing.defaultConsumeLocation;
  if (componentItem?.type === 'packaging') {
    return resolveLocationBySemantic(
      tenantId,
      warehouseId,
      {
        roles: ['PACKAGING'],
        localCodes: ['PACK_STORE'],
        codeHints: ['FACTORY_PACK_STORE', 'PACK_STORE']
      },
      client
    );
  }
  return resolveLocationBySemantic(
    tenantId,
    warehouseId,
    {
      roles: ['RM_STORE'],
      localCodes: ['RM_STORE'],
      codeHints: ['FACTORY_RM_STORE', 'RM_STORE']
    },
    client
  );
}

export async function assertWorkOrderRoutingLine(params: {
  tenantId: string;
  context: WorkOrderRoutingContext;
  componentItemId?: string;
  consumeLocationId?: string | null;
  produceLocationId?: string | null;
  client?: PoolClient;
}) {
  const expectedConsume = params.componentItemId
    ? await deriveComponentConsumeLocation(params.tenantId, params.context, { componentItemId: params.componentItemId }, params.client)
    : null;
  const expectedProduce = await deriveWorkOrderStageRouting(params.tenantId, params.context, params.client);

  if (params.consumeLocationId && expectedConsume && params.consumeLocationId !== expectedConsume.id) {
    const error = new Error('WO_ROUTING_LOCATION_OVERRIDE_FORBIDDEN') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    error.code = 'WO_ROUTING_LOCATION_OVERRIDE_FORBIDDEN';
    error.details = {
      type: 'consume',
      expectedLocationId: expectedConsume.id,
      expectedLocationCode: expectedConsume.code,
      providedLocationId: params.consumeLocationId
    };
    throw error;
  }

  if (
    params.produceLocationId &&
    expectedProduce.defaultProduceLocation &&
    params.produceLocationId !== expectedProduce.defaultProduceLocation.id
  ) {
    const error = new Error('WO_ROUTING_LOCATION_OVERRIDE_FORBIDDEN') as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    error.code = 'WO_ROUTING_LOCATION_OVERRIDE_FORBIDDEN';
    error.details = {
      type: 'produce',
      expectedLocationId: expectedProduce.defaultProduceLocation.id,
      expectedLocationCode: expectedProduce.defaultProduceLocation.code,
      providedLocationId: params.produceLocationId
    };
    throw error;
  }
}
