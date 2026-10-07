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
  config JSONB,
  source_key TEXT,
  next_check_at TIMESTAMP,
  priority SMALLINT NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  error_count INTEGER DEFAULT 0,
  last_parsed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT check_platform CHECK (platform IN ('kufar', 'onliner', 'av', 'realt'))
);

-- Backward-compatible migrations must run before indexes that reference newly
-- introduced columns. This is intentionally idempotent so existing production
-- databases can be upgraded in place.
ALTER TABLE links ADD COLUMN IF NOT EXISTS config JSONB;
ALTER TABLE links ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE links ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMP;
ALTER TABLE links ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0;

-- Migrate the retired legacy `realt` platform before enforcing the current platform set.
UPDATE links SET platform='onliner' WHERE platform='realt' AND url ILIKE '%onliner.%';
UPDATE links SET is_active=false, error_count=0, next_check_at=NULL WHERE platform='realt';
ALTER TABLE links DROP CONSTRAINT IF EXISTS check_platform;
ALTER TABLE links ADD CONSTRAINT check_platform CHECK (platform IN ('kufar','onliner','av'));

CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_active ON links(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_links_next_check ON links(next_check_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_links_user_source_key ON links(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_links_due_priority ON links(is_active, next_check_at, priority DESC, id);

DELETE FROM links a
USING links b
WHERE a.id > b.id
  AND a.user_id = b.user_id
  AND a.url = b.url;
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
  detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_seen_source VARCHAR(32),
  first_seen_rank INTEGER,
  updated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ads_external_id_link_id_unique UNIQUE (external_id, link_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_link_id ON ads(link_id);
CREATE INDEX IF NOT EXISTS idx_ads_external_id ON ads(external_id);
CREATE INDEX IF NOT EXISTS idx_ads_created_at ON ads(created_at);
CREATE INDEX IF NOT EXISTS idx_ads_link_created_at ON ads(link_id, created_at DESC);
-- Parser hot-path indexes: existing-ad lookup and latest-price lookup are keyed by link first.
CREATE INDEX IF NOT EXISTS idx_ads_link_external_updated ON ads(link_id, external_id, updated_at DESC NULLS LAST, id DESC);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS detected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS first_seen_source VARCHAR(32);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS first_seen_rank INTEGER;
CREATE INDEX IF NOT EXISTS idx_ads_first_seen ON ads(link_id, first_seen_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ads_link_published_created ON ads(link_id, published_at DESC NULLS LAST, created_at DESC, id DESC);

ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_status VARCHAR(20);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_percent DECIMAL(8,2);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_median DECIMAL(12,2);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_low DECIMAL(12,2);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_high DECIMAL(12,2);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS sell_fast DECIMAL(12,2);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS sell_normal DECIMAL(12,2);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS sell_max DECIMAL(12,2);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_sample_size INTEGER;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_confidence VARCHAR(10);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS market_quality DECIMAL(6,2);



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

-- Per-user global ad identity. An ad can appear in several monitors;
-- this table makes "new listing" notification ownership atomic and prevents
-- duplicate Telegram alerts across overlapping searches.
CREATE TABLE IF NOT EXISTS user_ad_seen (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL DEFAULT 'unknown',
  external_id VARCHAR(255) NOT NULL,
  first_link_id INTEGER REFERENCES links(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, platform, external_id)
);

-- Upgrade installations that used the old global external_id identity.
ALTER TABLE user_ad_seen ADD COLUMN IF NOT EXISTS platform VARCHAR(50);
UPDATE user_ad_seen s
SET platform=COALESCE(l.platform,'unknown')
FROM links l
WHERE s.first_link_id=l.id AND (s.platform IS NULL OR s.platform='');
UPDATE user_ad_seen SET platform='unknown' WHERE platform IS NULL OR platform='';
ALTER TABLE user_ad_seen ALTER COLUMN platform SET DEFAULT 'unknown';
ALTER TABLE user_ad_seen ALTER COLUMN platform SET NOT NULL;
ALTER TABLE user_ad_seen DROP CONSTRAINT IF EXISTS user_ad_seen_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ad_seen_identity
  ON user_ad_seen(user_id, platform, external_id);

CREATE INDEX IF NOT EXISTS idx_user_ad_seen_user_first_seen
  ON user_ad_seen(user_id, first_seen_at DESC);

-- Per-user dismissed listings. Dismissal is durable and hides the listing from
-- the Mini App without deleting the underlying marketplace data.
CREATE TABLE IF NOT EXISTS dismissed_ads (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL DEFAULT 'unknown',
  external_id VARCHAR(255) NOT NULL,
  dismissed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, platform, external_id)
);

ALTER TABLE dismissed_ads ADD COLUMN IF NOT EXISTS platform VARCHAR(50);
UPDATE dismissed_ads d
SET platform=COALESCE(l.platform,'unknown')
FROM links l
JOIN ads a ON a.link_id=l.id
WHERE a.external_id=d.external_id
  AND l.user_id=d.user_id
  AND (d.platform IS NULL OR d.platform='');
UPDATE dismissed_ads SET platform='unknown' WHERE platform IS NULL OR platform='';
ALTER TABLE dismissed_ads ALTER COLUMN platform SET DEFAULT 'unknown';
ALTER TABLE dismissed_ads ALTER COLUMN platform SET NOT NULL;
ALTER TABLE dismissed_ads DROP CONSTRAINT IF EXISTS dismissed_ads_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dismissed_ads_identity
  ON dismissed_ads(user_id, platform, external_id);

CREATE INDEX IF NOT EXISTS idx_dismissed_ads_user_time
  ON dismissed_ads(user_id, dismissed_at DESC);


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
CREATE INDEX IF NOT EXISTS idx_price_history_created_at ON price_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_notified ON price_history(notified_at) WHERE notified_at IS NULL;

-- Remove the old partial index. The application uses ON CONFLICT on these
-- four columns, so PostgreSQL needs an unconditional unique index matching
-- that conflict target exactly.
DROP INDEX IF EXISTS idx_price_history_unique_drop_external;
DROP INDEX IF EXISTS idx_price_history_unique_user_drop;

DELETE FROM price_history a
USING price_history b
WHERE a.id > b.id
  AND a.user_id IS NOT NULL
  AND b.user_id IS NOT NULL
  AND a.external_id IS NOT NULL
  AND b.external_id IS NOT NULL
  AND a.user_id = b.user_id
  AND a.external_id = b.external_id
  AND a.old_price IS NOT DISTINCT FROM b.old_price
  AND a.new_price IS NOT DISTINCT FROM b.new_price;

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique_user_drop
  ON price_history(user_id, external_id, old_price, new_price);

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique_ad_drop
  ON price_history(ad_id, old_price, new_price)
  WHERE ad_id IS NOT NULL;

-- Durable Telegram notification outbox. Jobs survive process restarts and are retried by the scheduler.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  kind VARCHAR(32) NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 0,
  chat_id BIGINT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TIMESTAMP,
  sent_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox(priority DESC, available_at, id)
  WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_outbox_locked
  ON notification_outbox(locked_until, id)
  WHERE sent_at IS NULL;

-- Migration for installations created before dedupe_key was enforced.
-- Keep the oldest job for each key, then make the invariant database-level.
DELETE FROM notification_outbox a
USING notification_outbox b
WHERE a.id > b.id
  AND a.dedupe_key = b.dedupe_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_dedupe_key
  ON notification_outbox(dedupe_key);


-- WellBOT PRO subscriptions (Telegram Stars)
CREATE TABLE IF NOT EXISTS pro_subscriptions (id BIGSERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,tier VARCHAR(32) NOT NULL DEFAULT 'pro',status VARCHAR(32) NOT NULL DEFAULT 'active',expires_at TIMESTAMP NOT NULL,telegram_payment_charge_id TEXT,provider_payment_charge_id TEXT,stars_amount INTEGER,last_invoice_payload TEXT,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE pro_subscriptions ADD COLUMN IF NOT EXISTS telegram_payment_charge_id TEXT;
ALTER TABLE pro_subscriptions ADD COLUMN IF NOT EXISTS provider_payment_charge_id TEXT;
ALTER TABLE pro_subscriptions ADD COLUMN IF NOT EXISTS stars_amount INTEGER;
ALTER TABLE pro_subscriptions ADD COLUMN IF NOT EXISTS last_invoice_payload TEXT;
ALTER TABLE pro_subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_subscriptions_user_tier ON pro_subscriptions(user_id,tier);
DELETE FROM pro_subscriptions a
USING pro_subscriptions b
WHERE a.id > b.id
  AND a.telegram_payment_charge_id IS NOT NULL
  AND a.telegram_payment_charge_id <> ''
  AND a.telegram_payment_charge_id = b.telegram_payment_charge_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_subscriptions_telegram_charge ON pro_subscriptions(telegram_payment_charge_id) WHERE telegram_payment_charge_id IS NOT NULL AND telegram_payment_charge_id <> '';

CREATE INDEX IF NOT EXISTS idx_pro_subscriptions_active ON pro_subscriptions(status,expires_at);


CREATE TABLE IF NOT EXISTS wellbot_payment_events (
  telegram_payment_charge_id VARCHAR(255) PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  payload TEXT NOT NULL,
  stars_amount INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wellbot_admin_audit (id BIGSERIAL PRIMARY KEY,admin_telegram_id BIGINT NOT NULL,target_telegram_id BIGINT,action VARCHAR(64) NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_wellbot_admin_audit_created ON wellbot_admin_audit(created_at DESC);
CREATE TABLE IF NOT EXISTS wellbot_promo_codes (id BIGSERIAL PRIMARY KEY,code VARCHAR(64) UNIQUE NOT NULL,tier VARCHAR(32) NOT NULL DEFAULT 'pro',duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 3650),max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 100000),uses_count INTEGER NOT NULL DEFAULT 0,expires_at TIMESTAMP,created_by BIGINT NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,active BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS wellbot_promo_redemptions (id BIGSERIAL PRIMARY KEY,promo_id BIGINT NOT NULL REFERENCES wellbot_promo_codes(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,telegram_id BIGINT NOT NULL,redeemed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(promo_id,user_id));
CREATE INDEX IF NOT EXISTS idx_wellbot_promo_code ON wellbot_promo_codes(code);


-- Durable daily digest delivery claims. This prevents duplicate digests across process restarts
-- while allowing a failed delivery to be retried after a short lease.
CREATE TABLE IF NOT EXISTS digest_deliveries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_day DATE NOT NULL,
  digest_hour SMALLINT NOT NULL CHECK (digest_hour BETWEEN 0 AND 23),
  claimed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP,
  PRIMARY KEY (user_id, digest_day, digest_hour)
);
CREATE INDEX IF NOT EXISTS idx_digest_deliveries_claimed ON digest_deliveries(claimed_at) WHERE sent_at IS NULL;

-- Personal preferences and durable saved listings.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notifications_enabled BOOLEAN NOT NULL DEFAULT true,
  min_deal_score SMALLINT NOT NULL DEFAULT 65 CHECK (min_deal_score BETWEEN 0 AND 100),
  digest_enabled BOOLEAN NOT NULL DEFAULT false,
  digest_hour SMALLINT NOT NULL DEFAULT 19 CHECK (digest_hour BETWEEN 0 AND 23),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS min_deal_score SMALLINT NOT NULL DEFAULT 65;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS digest_hour SMALLINT NOT NULL DEFAULT 19;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS saved_ads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, ad_id)
);
-- Remove legacy duplicate identities before enforcing the identity index.
DELETE FROM saved_ads a
USING saved_ads b
WHERE a.ad_id > b.ad_id
  AND a.user_id = b.user_id
  AND a.platform = b.platform
  AND a.external_id = b.external_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_ads_identity ON saved_ads(user_id, platform, external_id);
CREATE INDEX IF NOT EXISTS idx_saved_ads_user_created ON saved_ads(user_id, created_at DESC);
