export type UomNormalizationStatus =
  | 'OK'
  | 'INCONSISTENT'
  | 'UNKNOWN_UOM'
  | 'DIMENSION_MISMATCH';

export type UomDiagnosticSeverity = 'info' | 'watch' | 'action' | 'critical';

export type UomNormalizationReason =
  | 'STOCKING_UOM_UNSET'
  | 'NON_CONVERTIBLE_UOM'
  | 'UNKNOWN_UOM'
  | 'DIMENSION_MISMATCH';

export type UomResolutionTrace = {
  status: UomNormalizationStatus;
  severity: UomDiagnosticSeverity;
  canAggregate: boolean;
  source: 'registry' | 'alias' | 'item_override';
  inputUomCode: string;
  resolvedFromUom?: string;
  resolvedToUom?: string;
  itemId?: string;
  mappingKey?: string;
  detailCode?: string;
  detail?: string;
};

export type UomNormalizationDiagnostic = {
  itemId: string;
  locationId: string;
  status: UomNormalizationStatus;
  severity: UomDiagnosticSeverity;
  canAggregate: boolean;
  stockingUom: string | null;
  observedUoms: string[];
  traces: UomResolutionTrace[];
  reason?: UomNormalizationReason;
};
