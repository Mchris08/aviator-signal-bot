-- Run this entire file in Supabase SQL Editor

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id        BIGSERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  phone     TEXT UNIQUE NOT NULL,
  password  TEXT NOT NULL,
  key       TEXT DEFAULT 'AVBOT2025',
  active    BOOLEAN DEFAULT true,
  joined    DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Access keys table
CREATE TABLE IF NOT EXISTS access_keys (
  id         BIGSERIAL PRIMARY KEY,
  key        TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default access keys
INSERT INTO access_keys (key) VALUES ('AVBOT2025') ON CONFLICT DO NOTHING;
INSERT INTO access_keys (key) VALUES ('AVBOT-DEMO') ON CONFLICT DO NOTHING;

-- Disable Row Level Security (admin controls access via app logic)
ALTER TABLE accounts    DISABLE ROW LEVEL SECURITY;
ALTER TABLE access_keys DISABLE ROW LEVEL SECURITY;

-- Allow full access via anon key
GRANT ALL ON accounts    TO anon;
GRANT ALL ON access_keys TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
