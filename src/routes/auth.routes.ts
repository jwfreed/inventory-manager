import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db';
import { buildRefreshToken, hashPassword, hashToken, refreshCookieOptions, signAccessToken, verifyPassword } from '../lib/auth';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantId: z.string().uuid().optional(),
  tenantSlug: z.string().min(2).optional()
});

const bootstrapSchema = z.object({
  tenantName: z.string().min(2).optional(),
  tenantSlug: z.string().min(2).optional(),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminName: z.string().min(2).optional()
});

const refreshSchema = z.object({
  tenantId: z.string().uuid().optional(),
  tenantSlug: z.string().min(2).optional()
});

function mapUser(row: any) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTenant(row: any) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parentTenantId: row.parent_tenant_id ?? null,
    createdAt: row.created_at
  };
}

async function resolveMembership(userId: string, tenantId?: string, tenantSlug?: string) {
  if (tenantSlug) {
    const tenantRes = await query('SELECT * FROM tenants WHERE slug = $1', [tenantSlug]);
    if (tenantRes.rowCount === 0) return null;
    tenantId = tenantRes.rows[0].id;
  }

  if (tenantId) {
    const membershipRes = await query(
      `SELECT tm.*, t.*
         FROM tenant_memberships tm
         JOIN tenants t ON t.id = tm.tenant_id
        WHERE tm.user_id = $1
          AND tm.tenant_id = $2
          AND tm.status = 'active'`,
      [userId, tenantId]
    );
    if (membershipRes.rowCount === 0) return null;
    return membershipRes.rows[0];
  }

  const membershipRes = await query(
    `SELECT tm.*, t.*
       FROM tenant_memberships tm
       JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1
        AND tm.status = 'active'
      ORDER BY tm.created_at ASC`,
    [userId]
  );

  if (membershipRes.rowCount === 1) return membershipRes.rows[0];
  return null;
}

async function createSession(res: Response, user: any, membership: any) {
  const accessToken = signAccessToken({
    sub: user.id,
    tenantId: membership.tenant_id,
    role: membership.role
  });
  const refreshToken = buildRefreshToken();

  await query(
    `INSERT INTO refresh_tokens (
        id, tenant_id, user_id, token_hash, expires_at, created_at, ip_address, user_agent
     ) VALUES ($1, $2, $3, $4, $5, now(), $6, $7)`,
    [
      uuidv4(),
      membership.tenant_id,
      user.id,
      refreshToken.hash,
      refreshToken.expiresAt,
      res.req?.ip ?? null,
      res.req?.headers['user-agent'] ?? null
    ]
  );

  res.cookie('refresh_token', refreshToken.raw, refreshCookieOptions());

  return {
    accessToken,
    user: mapUser(user),
    tenant: mapTenant(membership),
    role: membership.role
  };
}

router.post('/auth/bootstrap', async (req: Request, res: Response) => {
  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { tenantName, tenantSlug, adminEmail, adminPassword, adminName } = parsed.data;

  const existingUser = await query('SELECT id FROM users LIMIT 1');
  if (existingUser.rowCount > 0) {
    return res.status(409).json({ error: 'Bootstrap already completed.' });
  }

  const now = new Date();
  const tenantNameFinal = tenantName ?? 'Default Tenant';
  const tenantSlugFinal = tenantSlug ?? 'default';
  const existingTenant = await query('SELECT id FROM tenants WHERE slug = $1', [tenantSlugFinal]);
  const tenantId = existingTenant.rowCount > 0 ? existingTenant.rows[0].id : uuidv4();
  const userId = uuidv4();

  try {
    const passwordHash = await hashPassword(adminPassword);
    const result = await withTransaction(async (client) => {
      if (existingTenant.rowCount === 0) {
        await client.query(
          `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
           VALUES ($1, $2, $3, NULL, $4)`,
          [tenantId, tenantNameFinal, tenantSlugFinal, now]
        );
      }
      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [userId, adminEmail, passwordHash, adminName ?? null, now]
      );
      await client.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
         VALUES ($1, $2, $3, 'admin', 'active', $4)`,
        [uuidv4(), tenantId, userId, now]
      );
      const user = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      const membership = await client.query(
        `SELECT tm.*, t.*
           FROM tenant_memberships tm
           JOIN tenants t ON t.id = tm.tenant_id
          WHERE tm.user_id = $1
            AND tm.tenant_id = $2`,
        [userId, tenantId]
      );
      return { user: user.rows[0], membership: membership.rows[0] };
    });

    const session = await createSession(res, result.user, result.membership);
    return res.status(201).json(session);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to bootstrap auth.' });
  }
});

router.post('/auth/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { email, password, tenantId, tenantSlug } = parsed.data;

  try {
    const userResult = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const user = userResult.rows[0];
    if (!user.active) {
      return res.status(403).json({ error: 'User is inactive.' });
    }
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const membership = await resolveMembership(user.id, tenantId, tenantSlug);
    if (!membership) {
      return res.status(400).json({ error: 'Tenant membership not found or ambiguous.' });
    }

    const session = await createSession(res, user, membership);
    return res.json(session);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to sign in.' });
  }
});

router.post('/auth/refresh', async (req: Request, res: Response) => {
  const parsed = refreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const raw = req.cookies?.refresh_token as string | undefined;
  if (!raw) {
    return res.status(401).json({ error: 'Missing refresh token.' });
  }

  try {
    const tokenHash = hashToken(raw);
    const tokenRes = await query(
      `SELECT * FROM refresh_tokens
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()`,
      [tokenHash]
    );
    if (tokenRes.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid refresh token.' });
    }

    const tokenRow = tokenRes.rows[0];
    const userRes = await query('SELECT * FROM users WHERE id = $1', [tokenRow.user_id]);
    if (userRes.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid user.' });
    }

    const membership = await resolveMembership(
      tokenRow.user_id,
      parsed.data.tenantId ?? tokenRow.tenant_id,
      parsed.data.tenantSlug
    );
    if (!membership) {
      return res.status(400).json({ error: 'Tenant membership not found or ambiguous.' });
    }

    await query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE id = $1`,
      [tokenRow.id]
    );

    const session = await createSession(res, userRes.rows[0], membership);
    return res.json(session);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to refresh session.' });
  }
});

router.post('/auth/logout', async (req: Request, res: Response) => {
  const raw = req.cookies?.refresh_token as string | undefined;
  if (raw) {
    const tokenHash = hashToken(raw);
    await query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE token_hash = $1`,
      [tokenHash]
    );
  }
  res.clearCookie('refresh_token', refreshCookieOptions());
  return res.status(204).send();
});

router.get('/auth/me', requireAuth, async (req: Request, res: Response) => {
  const auth = req.auth;
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  const userRes = await query('SELECT * FROM users WHERE id = $1', [auth.userId]);
  if (userRes.rowCount === 0) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const membership = await resolveMembership(auth.userId, auth.tenantId);
  if (!membership) {
    return res.status(404).json({ error: 'Membership not found.' });
  }
  return res.json({
    user: mapUser(userRes.rows[0]),
    tenant: mapTenant(membership),
    role: membership.role
  });
});

export default router;
