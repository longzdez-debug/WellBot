-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Links table
CREATE TABLE IF NOT EXISTS links (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  platform VARCHAR(50) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  error_count INTEGER DEFAULT 0,
  last_parsed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT check_platform CHECK (platform IN ('kufar', 'onliner', 'av', 'realt'))
);

CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_active ON links(is_active) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_user_url_unique ON links(user_id, url);

-- Ads table
CREATE TABLE IF NOT EXISTS ads (
  id SERIAL PRIMARY KEY,
  link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
  external_id VARCHAR(255) NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price VARCHAR(100),
  image_url TEXT,
  ad_url TEXT NOT NULL,
  location TEXT,
  address TEXT,
  published_at TIMESTAMP,
  updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ads_external_id_link_id_unique UNIQUE (external_id, link_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_link_id ON ads(link_id);
CREATE INDEX IF NOT EXISTS idx_ads_external_id ON ads(external_id);
CREATE INDEX IF NOT EXISTS idx_ads_created_at ON ads(created_at);

-- Migration for old databases.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ads_external_id_key') THEN
    ALTER TABLE ads DROP CONSTRAINT ads_external_id_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ads_external_id_link_id_unique') THEN
    ALTER TABLE ads ADD CONSTRAINT ads_external_id_link_id_unique UNIQUE (external_id, link_id);
  END IF;
END
$$;

-- Price history tracking.
CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  ad_id INTEGER REFERENCES ads(id) ON DELETE CASCADE,
  external_id VARCHAR(255),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  old_price VARCHAR(100),
  new_price VARCHAR(100),
  price_change_percent DECIMAL(5,2),
  notified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migrate rows created before user-scoped price-drop dedup existed.
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
UPDATE price_history ph
SET external_id = COALESCE(ph.external_id, a.external_id),
    user_id = COALESCE(ph.user_id, l.user_id)
FROM ads a
JOIN links l ON l.id = a.link_id
WHERE ph.ad_id = a.id
  AND (ph.external_id IS NULL OR ph.user_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_price_history_ad_id ON price_history(ad_id);
CREATE INDEX IF NOT EXISTS idx_price_history_user_id ON price_history(user_id);
CREATE INDEX IF NOT EXISTS idx_price_history_notified ON price_history(notified_at) WHERE notified_at IS NULL;

-- Remove legacy global dedup. A price drop must be deduplicated per user,
-- otherwise one reseller can suppress the same notification for another reseller.
DROP INDEX IF EXISTS idx_price_history_unique_drop_external;

-- Clean duplicates before creating the user-scoped unique index.
DELETE FROM price_history a
USING price_history b
WHERE a.id > b.id
  AND a.user_id IS NOT NULL
  AND b.user_id IS NOT NULL
  AND a.user_id = b.user_id
  AND a.external_id = b.external_id
  AND a.old_price IS NOT DISTINCT FROM b.old_price
  AND a.new_price IS NOT DISTINCT FROM b.new_price;

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique_user_drop
  ON price_history(user_id, external_id, old_price, new_price)
  WHERE user_id IS NOT NULL AND external_id IS NOT NULL;

-- Preserve per-ad idempotency for legacy rows and concurrent writes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique_ad_drop
  ON price_history(ad_id, old_price, new_price)
  WHERE ad_id IS NOT NULL;

-- Telegram channel subscriptions
CREATE TABLE IF NOT EXISTS channel_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL,
  channel_username VARCHAR(255),
  channel_title VARCHAR(500),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_channel_per_user UNIQUE (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_user_id ON channel_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_subscriptions_active ON channel_subscriptions(is_active) WHERE is_active = true;
