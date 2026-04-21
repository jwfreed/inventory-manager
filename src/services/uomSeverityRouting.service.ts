import type {
  UomDiagnosticSeverity,
  UomNormalizationStatus,
  UomResolutionTrace
} from '../types/uomNormalization';

export function mapUomStatusToRouting(status: UomNormalizationStatus): {
  severity: UomDiagnosticSeverity;
  canAggregate: boolean;
} {
  switch (status) {
    case 'OK':
      return { severity: 'info', canAggregate: true };
    case 'INCONSISTENT':
    case 'UNKNOWN_UOM':
    case 'DIMENSION_MISMATCH':
      return { severity: 'action', canAggregate: false };
  }
}

function severityRank(severity: UomDiagnosticSeverity) {
  switch (severity) {
    case 'critical':
      return 4;
    case 'action':
      return 3;
    case 'watch':
      return 2;
    case 'info':
    default:
      return 1;
  }
}

const statusPriority: Record<UomNormalizationStatus, number> = {
  DIMENSION_MISMATCH: 5,
  UNKNOWN_UOM: 4,
  INCONSISTENT: 3,
  OK: 1
};

export function resolveAggregateStatus(statuses: UomNormalizationStatus[]): UomNormalizationStatus {
  if (statuses.length === 0) return 'OK';
  return statuses.reduce((winner, candidate) =>
    statusPriority[candidate] > statusPriority[winner] ? candidate : winner
  );
}

export function resolveTraceOutcome(traces: UomResolutionTrace[]): {
  status: UomNormalizationStatus;
  severity: UomDiagnosticSeverity;
  canAggregate: boolean;
} {
  if (traces.length === 0) {
    const routing = mapUomStatusToRouting('OK');
    return { status: 'OK', severity: routing.severity, canAggregate: routing.canAggregate };
  }

  const status = resolveAggregateStatus(traces.map((trace) => trace.status));
  const routing = mapUomStatusToRouting(status);
  const highestSeverity = traces.reduce<UomDiagnosticSeverity>((current, trace) => {
    return severityRank(trace.severity) > severityRank(current) ? trace.severity : current;
  }, routing.severity);

  return {
    status,
    severity: highestSeverity,
    canAggregate: traces.every((trace) => trace.canAggregate)
  };
}
