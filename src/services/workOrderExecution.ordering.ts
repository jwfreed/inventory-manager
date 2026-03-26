type WorkOrderMaterialIssueLineOrderingRow = {
  id: string;
  line_number: number;
  component_item_id: string;
  uom: string;
  from_location_id: string;
};

type WorkOrderExecutionLineOrderingRow = {
  id: string;
  item_id: string;
  uom: string;
  to_location_id: string | null;
};

function compareNullableText(a: string | null | undefined, b: string | null | undefined) {
  const left = a ?? '';
  const right = b ?? '';
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareIssueLineLockKey(
  a: WorkOrderMaterialIssueLineOrderingRow,
  b: WorkOrderMaterialIssueLineOrderingRow
) {
  return (
    compareNullableText(a.component_item_id, b.component_item_id) ||
    compareNullableText(a.from_location_id, b.from_location_id) ||
    compareNullableText(a.uom, b.uom) ||
    a.line_number - b.line_number ||
    compareNullableText(a.id, b.id)
  );
}

export function compareProduceLineLockKey(
  a: WorkOrderExecutionLineOrderingRow,
  b: WorkOrderExecutionLineOrderingRow
) {
  return (
    compareNullableText(a.item_id, b.item_id) ||
    compareNullableText(a.to_location_id, b.to_location_id) ||
    compareNullableText(a.uom, b.uom) ||
    compareNullableText(a.id, b.id)
  );
}

export function compareBatchConsumeKey(
  a: {
    componentItemId: string;
    fromLocationId: string;
    uom: string;
  },
  b: {
    componentItemId: string;
    fromLocationId: string;
    uom: string;
  }
) {
  return (
    compareNullableText(a.componentItemId, b.componentItemId) ||
    compareNullableText(a.fromLocationId, b.fromLocationId) ||
    compareNullableText(a.uom, b.uom)
  );
}

export function compareBatchProduceKey(
  a: {
    outputItemId: string;
    toLocationId: string;
    uom: string;
  },
  b: {
    outputItemId: string;
    toLocationId: string;
    uom: string;
  }
) {
  return (
    compareNullableText(a.outputItemId, b.outputItemId) ||
    compareNullableText(a.toLocationId, b.toLocationId) ||
    compareNullableText(a.uom, b.uom)
  );
}

export function compareNormalizedOverrideKey(
  left: { componentItemId: string },
  right: { componentItemId: string }
) {
  return compareNullableText(left.componentItemId, right.componentItemId);
}
