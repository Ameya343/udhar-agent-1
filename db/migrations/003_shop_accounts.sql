-- Self-registered shops (server/shops.ts): which shop an owner's phone belongs to, so one entry page can log any owner
-- into their own shop only. The original shop of an instance (SHOP_ID, e.g. gupta) is not listed here: its owner stays
-- in shop_owners as before and nothing about it changes. Additive and idempotent: safe to run on a live database any
-- number of times (the server also runs this itself on start when it is not on the migrated table stores).
CREATE TABLE IF NOT EXISTS shop_accounts (
  shop_id     text PRIMARY KEY,
  owner_phone text NOT NULL,
  shop_name   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_accounts_phone_uq ON shop_accounts (owner_phone);
