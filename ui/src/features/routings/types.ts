export interface WorkCenter {
  id: string;
  code: string;
  name: string;
  description?: string;
  locationId?: string | null;
  hourlyRate: number;
  capacity: number;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface RoutingStep {
  id?: string;
  sequenceNumber: number;
  workCenterId: string;
  description?: string;
  setupTimeMinutes: number;
  runTimeMinutes: number;
  machineTimeMinutes: number;
}

export interface Routing {
  id: string;
  itemId: string;
  name: string;
  version: string;
  isDefault: boolean;
  status: 'draft' | 'active' | 'obsolete';
  notes?: string;
  steps?: RoutingStep[];
  createdAt: string;
  updatedAt: string;
}
