import { z } from 'zod';

export const workCenterSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  locationId: z.string().uuid().optional().nullable(),
  hourlyRate: z.number().min(0).default(0),
  capacity: z.number().int().min(1).default(1),
  status: z.enum(['active', 'inactive']).default('active'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const createWorkCenterSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  locationId: z.string().uuid().optional().nullable(),
  hourlyRate: z.number().min(0).optional(),
  capacity: z.number().int().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional()
});

export const updateWorkCenterSchema = createWorkCenterSchema.partial();

export const routingStepSchema = z.object({
  id: z.string().uuid().optional(),
  sequenceNumber: z.number().int().min(1),
  workCenterId: z.string().uuid(),
  description: z.string().optional(),
  setupTimeMinutes: z.number().min(0).default(0),
  runTimeMinutes: z.number().min(0).default(0),
  machineTimeMinutes: z.number().min(0).default(0)
});

export const routingSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(20),
  isDefault: z.boolean().default(false),
  status: z.enum(['draft', 'active', 'obsolete']).default('draft'),
  notes: z.string().optional(),
  steps: z.array(routingStepSchema).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const createRoutingSchema = z.object({
  itemId: z.string().uuid(),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(20),
  isDefault: z.boolean().optional(),
  status: z.enum(['draft', 'active', 'obsolete']).optional(),
  notes: z.string().optional(),
  steps: z.array(routingStepSchema).optional()
});

export const updateRoutingSchema = createRoutingSchema.partial().omit({ itemId: true });
