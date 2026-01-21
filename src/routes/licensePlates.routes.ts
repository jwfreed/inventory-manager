import { Router, Request, Response } from 'express'
import * as licensePlatesService from '../services/licensePlates.service'

const router = Router()

/**
 * GET /lpns
 * List license plates with optional filters
 */
router.get('/lpns', async (req: Request, res: Response) => {
  try {
    const filters = {
      itemId: req.query.itemId as string | undefined,
      locationId: req.query.locationId as string | undefined,
      lotId: req.query.lotId as string | undefined,
      status: req.query.status as any | undefined,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    }

    const lpns = await licensePlatesService.listLicensePlates(req.auth!.tenantId, filters)
    res.status(200).json({ data: lpns })
  } catch (error) {
    console.error('Error listing license plates:', error)
    res.status(500).json({ error: 'Failed to list license plates' })
  }
})

/**
 * GET /lpns/:id
 * Get a single license plate by ID
 */
router.get('/lpns/:id', async (req: Request, res: Response) => {
  try {
    const lpn = await licensePlatesService.getLicensePlateById(req.auth!.tenantId, req.params.id)

    if (!lpn) {
      return res.status(404).json({ error: 'License plate not found' })
    }

    res.status(200).json({ data: lpn })
  } catch (error) {
    console.error('Error getting license plate:', error)
    res.status(500).json({ error: 'Failed to get license plate' })
  }
})

/**
 * POST /lpns
 * Create a new license plate
 */
router.post('/lpns', async (req: Request, res: Response) => {
  try {
    const actor = req.auth?.userId ? { type: 'user' as const, id: req.auth.userId } : undefined
    const lpn = await licensePlatesService.createLicensePlate(req.auth!.tenantId, req.body, actor)
    res.status(201).json({ data: lpn })
  } catch (error: any) {
    console.error('Error creating license plate:', error)
    if (error.message?.includes('already exists')) {
      return res.status(409).json({ error: error.message })
    }
    res.status(500).json({ error: 'Failed to create license plate' })
  }
})

/**
 * PATCH /lpns/:id
 * Update a license plate
 */
router.patch('/lpns/:id', async (req: Request, res: Response) => {
  try {
    const actor = req.auth?.userId ? { type: 'user' as const, id: req.auth.userId } : undefined
    const lpn = await licensePlatesService.updateLicensePlate(
      req.auth!.tenantId,
      req.params.id,
      req.body,
      actor
    )

    if (!lpn) {
      return res.status(404).json({ error: 'License plate not found' })
    }

    res.status(200).json({ data: lpn })
  } catch (error) {
    console.error('Error updating license plate:', error)
    res.status(500).json({ error: 'Failed to update license plate' })
  }
})

/**
 * POST /lpns/:id/move
 * Move a license plate to a new location
 */
router.post('/lpns/:id/move', async (req: Request, res: Response) => {
  try {
    const { toLocationId, fromLocationId, notes, overrideNegative, overrideReason } = req.body

    if (!toLocationId || !fromLocationId) {
      return res.status(400).json({ error: 'toLocationId and fromLocationId are required' })
    }

    const actor = req.auth?.userId
      ? { type: 'user' as const, id: req.auth.userId, role: req.auth.role }
      : undefined
    const lpn = await licensePlatesService.moveLicensePlate(
      req.auth!.tenantId,
      {
        licensePlateId: req.params.id,
        fromLocationId,
        toLocationId,
        notes,
        overrideNegative,
        overrideReason
      },
      actor
    )

    if (!lpn) {
      return res.status(404).json({ error: 'License plate not found' })
    }

    res.status(200).json({ data: lpn })
  } catch (error) {
    if ((error as any)?.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        error: { code: 'INSUFFICIENT_STOCK', message: (error as any).details?.message, details: (error as any).details }
      })
    }
    if ((error as any)?.code === 'DISCRETE_UOM_REQUIRES_INTEGER') {
      return res.status(400).json({
        error: {
          code: 'DISCRETE_UOM_REQUIRES_INTEGER',
          message: (error as any).details?.message,
          details: (error as any).details
        }
      })
    }
    if ((error as any)?.code === 'NEGATIVE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({
        error: {
          code: 'NEGATIVE_OVERRIDE_NOT_ALLOWED',
          message: (error as any).details?.message,
          details: (error as any).details
        }
      })
    }
    if ((error as any)?.code === 'NEGATIVE_OVERRIDE_REQUIRES_REASON') {
      return res.status(409).json({
        error: {
          code: 'NEGATIVE_OVERRIDE_REQUIRES_REASON',
          message: (error as any).details?.message,
          details: (error as any).details
        }
      })
    }
    console.error('Error moving license plate:', error)
    res.status(500).json({ error: 'Failed to move license plate' })
  }
})

/**
 * POST /lpns/refresh-view
 * Refresh the inventory_levels_by_lpn materialized view
 */
router.post('/lpns/refresh-view', async (_req: Request, res: Response) => {
  try {
    await licensePlatesService.refreshInventoryLevelsByLpn()
    res.status(200).json({ message: 'Materialized view refreshed successfully' })
  } catch (error) {
    console.error('Error refreshing materialized view:', error)
    res.status(500).json({ error: 'Failed to refresh materialized view' })
  }
})

export default router
