import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/**
 * Middleware factory to validate UUID path parameters
 */
export function validateUuidParam(paramName: string = 'id') {
  const uuidSchema = z.string().uuid();
  
  return (req: Request, res: Response, next: NextFunction) => {
    const value = req.params[paramName];
    const result = uuidSchema.safeParse(value);
    
    if (!result.success) {
      return res.status(400).json({ 
        error: `Invalid ${paramName}.`,
        details: result.error.flatten()
      });
    }
    
    next();
  };
}

/**
 * Middleware factory to validate request body against a Zod schema
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    
    if (!result.success) {
      return res.status(400).json({ 
        error: 'Invalid request body.',
        details: result.error.flatten()
      });
    }
    
    // Attach validated data to request for type safety
    req.validatedBody = result.data;
    next();
  };
}

/**
 * Middleware factory to validate query parameters against a Zod schema
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    
    if (!result.success) {
      return res.status(400).json({ 
        error: 'Invalid query parameters.',
        details: result.error.flatten()
      });
    }
    
    // Attach validated data to request for type safety
    req.validatedQuery = result.data;
    next();
  };
}

/**
 * Middleware to validate pagination parameters
 */
export function validatePagination(
  defaultLimit: number = 20,
  maxLimit: number = 100
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defaultLimit));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    
    req.pagination = { limit, offset };
    next();
  };
}

// Augment Express Request type to include validated data
declare global {
  namespace Express {
    interface Request {
      validatedBody?: any;
      validatedQuery?: any;
      pagination?: { limit: number; offset: number };
    }
  }
}
