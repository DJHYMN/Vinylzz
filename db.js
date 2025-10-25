// db.js
import pg from 'pg';
import 'dotenv/config';

const needsSSL =
  !process.env.DATABASE_SSL || process.env.DATABASE_SSL.toLowerCase() !== 'false';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
});

