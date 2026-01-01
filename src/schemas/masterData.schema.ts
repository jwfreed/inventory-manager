import { z } from 'zod';
import { ItemLifecycleStatus } from '../types/item';

export const itemSchema = z.object({
  sku: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  lifecycleStatus: z.nativeEnum(ItemLifecycleStatus).default(ItemLifecycleStatus.ACTIVE),
  type: z.enum(['raw', 'wip', 'finished', 'packaging']).default('raw'),
  isPhantom: z.boolean().default(false),
  defaultUom: z.string().min(1).max(50).nullable().optional(),
  defaultLocationId: z.string().uuid().nullable().optional(),
  weight: z.number().positive().nullable().optional(),
  weightUom: z.string().max(50).nullable().optional(),
  volume: z.number().positive().nullable().optional(),
  volumeUom: z.string().max(50).nullable().optional(),
});

export const locationSchema = z.object({
  code: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  type: z.enum(['warehouse', 'bin', 'store', 'customer', 'vendor', 'scrap', 'virtual']),
  active: z.boolean().optional(),
  parentLocationId: z.string().uuid().nullable().optional(),
  maxWeight: z.number().positive().nullable().optional(),
  maxVolume: z.number().positive().nullable().optional(),
  zone: z.string().max(255).nullable().optional(),
});

export const uomConversionSchema = z.object({
  itemId: z.string().uuid(),
  fromUom: z.string().min(1).max(50),
  toUom: z.string().min(1).max(50),
  factor: z.number().positive(),
});
