import 'dotenv/config';
import { pool } from '../src/db';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

async function seed() {
  try {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const userId = uuid();
    const passwordHash = await bcrypt.hash('admin@local', 12);
    
    // Insert tenant (skip if exists)
    try {
      await pool.query(
        'INSERT INTO tenants (id, name, slug, created_at) VALUES ($1, $2, $3, now())',
        [tenantId, 'Default Tenant', 'default']
      );
      console.log('Created tenant');
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && e.code === '23505') {
        console.log('Tenant already exists');
      } else {
        throw e;
      }
    }
    
    // Insert currency (skip if exists)
    try {
      await pool.query(
        'INSERT INTO currencies (code, name, symbol) VALUES ($1, $2, $3)',
        ['USD', 'US Dollar', '$']
      );
      console.log('Created currency');
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && e.code === '23505') {
        console.log('Currency already exists');
      } else {
        throw e;
      }
    }
    
    // Insert user
    await pool.query(
      'INSERT INTO users (id, email, password_hash, full_name, active, base_currency, created_at, updated_at) VALUES ($1, $2, $3, $4, true, $5, now(), now())',
      [userId, 'jon.freed@gmail.com', passwordHash, 'Admin User', 'USD']
    );
    console.log('Created user');
    
    // Insert membership
    await pool.query(
      'INSERT INTO tenant_memberships (id, tenant_id, user_id, role, status, created_at) VALUES ($1, $2, $3, $4, $5, now())',
      [uuid(), tenantId, userId, 'admin', 'active']
    );
    console.log('Created membership');
    
    console.log('✓ Seed complete');
  } catch (error: unknown) {
    console.error('Seed error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
