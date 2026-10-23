-- Normalised khata: one database, every row scoped by shop_id, Row-Level Security on app.shop_id.
-- Typed columns hold the fields the app relies on; "extra" (jsonb) keeps any other field of the in-memory
-- object so a load gives back exactly what was saved. "pos" keeps the order of the app's arrays.

CREATE TABLE shops (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  owner_name  text,
  owner_phone text,
  upi_id      text,
  extra       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  shop_id        text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id             text NOT NULL,
  pos            integer NOT NULL,
  name           text NOT NULL,
  name_key       text,
  phone          text,
  vpas           jsonb,
  due_date       date,
  last_reminder  date,
  reminder_level integer,
  removed_on     date,
  guest          boolean,
  vouched_by     text,
  vouch          jsonb,
  created_on     date,
  extra          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);
CREATE INDEX customers_phone_idx ON customers (shop_id, phone);

CREATE TABLE customer_txns (
  shop_id     text NOT NULL,
  id          text NOT NULL,
  pos         integer NOT NULL,
  customer_id text,
  type        text NOT NULL,
  amount      numeric NOT NULL,
  items       jsonb,
  txn_date    date,
  due_date    date,
  note        text,
  source      text,
  voided      boolean NOT NULL DEFAULT false,
  extra       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id)
);
CREATE INDEX customer_txns_customer_idx ON customer_txns (shop_id, customer_id, txn_date);

CREATE TABLE traders (
  shop_id    text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id         text NOT NULL,
  pos        integer,               -- position in the app's wholesaler list; NULL for a supplier known only from the khata
  kind       text NOT NULL CHECK (kind IN ('wholesaler', 'supplier')),
  name       text NOT NULL,
  name_key   text,
  phone      text,
  extra      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);
CREATE INDEX traders_key_idx ON traders (shop_id, name_key);

CREATE TABLE trader_txns (
  shop_id    text NOT NULL,
  id         text NOT NULL,
  pos        integer NOT NULL,
  trader_id  text,
  type       text NOT NULL CHECK (type IN ('supply', 'payment')),
  amount     numeric NOT NULL,
  paid       numeric,
  items      jsonb,
  txn_date   date,
  due_date   date,
  extra      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, trader_id) REFERENCES traders(shop_id, id)
);
CREATE INDEX trader_txns_trader_idx ON trader_txns (shop_id, trader_id, txn_date);

-- Inventory: one row per item, two rates learned from conversations (customer = selling, trader = buying).
CREATE TABLE items (
  shop_id                  text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id                       bigint GENERATED ALWAYS AS IDENTITY,
  name                     text NOT NULL,     -- the app's normalised item key, e.g. "chini"
  display_name             text,              -- as spoken, e.g. "cheeni"
  unit                     text,
  customer_rate            numeric,
  customer_rate_updated_at date,
  trader_rate              numeric,
  trader_unit              text,
  trader_rate_updated_at   date,
  in_price_book            boolean NOT NULL DEFAULT false,  -- part of the app's rate book (state.prices)
  price_pos                integer,
  source                   text,
  extra                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK (customer_rate IS NULL OR customer_rate >= 0),
  CHECK (trader_rate IS NULL OR trader_rate >= 0)
);
CREATE UNIQUE INDEX items_shop_name_uq ON items (shop_id, lower(name));

CREATE TABLE messages (
  shop_id    text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  pos        integer NOT NULL,
  msg_id     text,
  to_party   text,
  from_party text,
  body       text,
  msg_date   date,
  extra      jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (shop_id, pos)
);

CREATE TABLE orders (
  shop_id     text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  pos         integer NOT NULL,
  order_id    text,
  customer_id text,
  status      text,
  order_date  date,
  extra       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (shop_id, pos)
);

-- Everything else in the khata (log, pending, cash claims, owner asks, stock orders, consents, ...), one row per key.
CREATE TABLE shop_extras (
  shop_id    text NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, key)
);

-- Row-Level Security: a session sees only the shop named by app.shop_id. FORCE applies it to the table owner too.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','customer_txns','traders','trader_txns','items','messages','orders','shop_extras'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY shop_isolation ON %I USING (shop_id = current_setting(''app.shop_id'', true)) WITH CHECK (shop_id = current_setting(''app.shop_id'', true))', t);
  END LOOP;
END $$;
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE shops FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON shops USING (id = current_setting('app.shop_id', true)) WITH CHECK (id = current_setting('app.shop_id', true));
