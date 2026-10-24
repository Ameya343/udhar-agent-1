-- Owner login and shop registration profile (server/auth.ts). Kept apart from the khata tables: nothing here is ever
-- sent to the page in full, to the AI or on WhatsApp. IF NOT EXISTS because the auth store also creates these tables
-- itself when the shop runs on the single-row store (no migrations), so either order works.

CREATE TABLE IF NOT EXISTS shop_owners (
  shop_id       text NOT NULL,
  id            text NOT NULL,
  phone         text NOT NULL,
  name          text,
  password_hash text NOT NULL,            -- scrypt$N$r$p$salt$hash, never the password
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, phone)
);

CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash  text PRIMARY KEY,           -- sha256 of the cookie value, never the cookie itself
  shop_id     text NOT NULL,
  owner_id    text NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_sessions_shop_idx ON owner_sessions (shop_id);

CREATE TABLE IF NOT EXISTS shop_profiles (
  shop_id        text PRIMARY KEY,
  shop_name      text,
  owner_name     text,
  address        text,
  gst_registered boolean NOT NULL DEFAULT true,
  tax_kind       text CHECK (tax_kind IN ('GSTIN', 'PAN')),
  tax_id_enc     text,                    -- enc:v1:... (AES-256-GCM with TAX_ID_KEY) or plain:... when no key is set
  tax_last4      text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
