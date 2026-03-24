import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_analysis (
      ad_id       TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      analyzed_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS hypotheses (
      id                   SERIAL PRIMARY KEY,
      batch                TEXT    NOT NULL,
      hypo_id              INTEGER,
      title                TEXT,
      hypothesis           TEXT,
      what_to_test         TEXT,
      based_on             TEXT,
      why_it_works         TEXT,
      priority             TEXT    DEFAULT 'medium',
      creative_format      TEXT    DEFAULT 'image',
      reference_ad_numbers JSONB   DEFAULT '[]',
      top_hooks            JSONB   DEFAULT '[]',
      top_body_texts       JSONB   DEFAULT '[]',
      visual_prompt        TEXT,
      tested               BOOLEAN DEFAULT FALSE,
      asana_created        BOOLEAN DEFAULT FALSE,
      generated_at         TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
