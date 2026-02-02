import 'dotenv/config';
import { pool, query, withTransaction } from '../src/db';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function test() {
  try {
    // Check if any users exist
    const usersResult = await query('SELECT id FROM users LIMIT 1');
    console.log('Users exist:', (usersResult.rowCount ?? 0) > 0);

    if ((usersResult.rowCount ?? 0) > 0) {
      console.log('User already exists, bootstrap would return 409');
      await pool.end();
      return;
    }

    const adminEmail = 'test@test.com';
    const adminPassword = 'password123';
    const tenantSlug = 'default';
    const tenantName = 'Test Tenant';
    const now = new Date();

    console.log('Attempting bootstrap...');
    
    const passwordHash = await hashPassword(adminPassword);
    
    // Check if tenant exists
    const existingTenant = await query('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
    const tenantId = (existingTenant.rowCount ?? 0) > 0 ? existingTenant.rows[0].id : uuidv4();
    const userId = uuidv4();

    const result = await withTransaction(async (client) => {
      // Only create tenant if it doesn't exist
      if ((existingTenant.rowCount ?? 0) === 0) {
        await client.query(
          `INSERT INTO tenants (id, name, slug, parent_tenant_id, created_at)
           VALUES ($1, $2, $3, NULL, $4)`,
          [tenantId, tenantName, tenantSlug, now]
        );
        console.log('Tenant created');
      } else {
        console.log('Using existing tenant');
      }

      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)`,
        [userId, adminEmail, passwordHash, null, now]
      );
      console.log('User created');

      await client.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at)
         VALUES ($1, $2, $3, 'admin', 'active', $4)`,
        [uuidv4(), tenantId, userId, now]
      );
      console.log('Membership created');

      return { success: true };
    });

    console.log('Bootstrap result:', result);
  } catch (error: any) {
    console.error('Bootstrap error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await pool.end();
  }
}

test();
