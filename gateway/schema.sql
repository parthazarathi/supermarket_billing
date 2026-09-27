-- MartPOS gateway schema. IDs are application-generated (crypto.randomUUID),
-- so no database extensions are required.
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_owners_email ON owners(lower(email));

CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shops_owner ON shops(owner_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_shop ON devices(shop_id);

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL UNIQUE REFERENCES shops(id),
  provider TEXT NOT NULL DEFAULT 'meta',
  business_account_id TEXT DEFAULT '',
  phone_number_id TEXT DEFAULT '',
  display_phone_number TEXT DEFAULT '',
  business_name TEXT DEFAULT '',
  access_token_ciphertext TEXT DEFAULT '',
  access_token_iv TEXT DEFAULT '',
  access_token_tag TEXT DEFAULT '',
  token_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'disconnected',
  connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT DEFAULT ''
);

-- A Meta phone number id may belong to exactly one shop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_connections_phone_unique
  ON whatsapp_connections(phone_number_id) WHERE phone_number_id <> '';

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en_US',
  category TEXT NOT NULL DEFAULT 'UTILITY',
  meta_template_id TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  document_header BOOLEAN NOT NULL DEFAULT false,
  components JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_id, name, language)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  invoice_id TEXT DEFAULT '',
  customer_id TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  normalized_phone TEXT DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'invoice',
  template_name TEXT DEFAULT '',
  meta_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT DEFAULT '',
  error_message TEXT DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  payload JSONB,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_meta_id
  ON whatsapp_messages(meta_message_id) WHERE meta_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_messages_shop ON whatsapp_messages(shop_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_status ON whatsapp_messages(status);
CREATE INDEX IF NOT EXISTS idx_wa_messages_created ON whatsapp_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_wa_messages_invoice ON whatsapp_messages(invoice_id);

CREATE TABLE IF NOT EXISTS whatsapp_queue (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  message_id TEXT NOT NULL UNIQUE REFERENCES whatsapp_messages(id),
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_queue_due ON whatsapp_queue(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_wa_queue_shop ON whatsapp_queue(shop_id);

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_shop ON onboarding_sessions(shop_id);

-- AI Store Manager grants: issued after the gateway re-verifies a Google
-- id_token. Bound to the verified Google subject; the raw token is only
-- ever returned once to the POS and stored hashed here.
CREATE TABLE IF NOT EXISTS ai_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_grants_sub ON ai_grants(google_sub);

-- Google Drive backup links: a shop/installation's Drive authorization.
-- The Google refresh token is stored AES-256-GCM-encrypted (ciphertext/iv/tag)
-- with GATEWAY_ENCRYPTION_KEY; plaintext tokens never touch the database.
-- Each link also carries a bearer grant (hash only) the POS presents for
-- /v1/drive/* calls, and the escrowed device backup-encryption key so a
-- re-linked install on a new machine can still decrypt its Drive backups.
CREATE TABLE IF NOT EXISTS drive_links (
  id TEXT PRIMARY KEY,
  shop_id TEXT REFERENCES shops(id),
  grant_token_hash TEXT UNIQUE,
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  refresh_token_ciphertext TEXT NOT NULL DEFAULT '',
  refresh_token_iv TEXT NOT NULL DEFAULT '',
  refresh_token_tag TEXT NOT NULL DEFAULT '',
  backup_key_ciphertext TEXT NOT NULL DEFAULT '',
  backup_key_iv TEXT NOT NULL DEFAULT '',
  backup_key_tag TEXT NOT NULL DEFAULT '',
  folder_id TEXT NOT NULL DEFAULT '',
  folder_name TEXT NOT NULL DEFAULT 'MARTPOS Backups',
  status TEXT NOT NULL DEFAULT 'connected',
  last_backup_at TIMESTAMPTZ,
  last_error TEXT DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drive_links_shop ON drive_links(shop_id);
-- One live link per shop; one live standalone link per Google account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_links_live_shop
  ON drive_links(shop_id) WHERE shop_id IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_links_live_sub
  ON drive_links(google_sub) WHERE shop_id IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
