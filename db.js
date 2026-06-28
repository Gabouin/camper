require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      msg_ts TEXT PRIMARY KEY,
      ticket_msg_ts TEXT,
      channel_id TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_by_slack_id TEXT,
      claimed_by_slack_id TEXT,
      closed_by_slack_id TEXT,
      closed_at TIMESTAMPTZ,
      last_msg_at TIMESTAMPTZ,
      ticket_number INTEGER,
      permalink TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS helpers (
      slack_user_id TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE SEQUENCE IF NOT EXISTS ticket_seq START 1;
  `);

  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS channel_id TEXT`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by_slack_id TEXT`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_number INTEGER`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS permalink TEXT`);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS title TEXT`);

  console.log('[db] Tables ready');
}

module.exports = { pool, initDb };
