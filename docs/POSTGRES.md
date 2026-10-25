# PostgreSQL storage (optional)

## SAFE mode for a live shop (recommended)
Put these in `/home/node/udhaar.env` (never in chat or git):
```
DATABASE_URL=postgres://USER:PASSWORD@HOST/DB?sslmode=require
STORE=pg-tables
DUAL_WRITE_JSON=1
```
- Every save goes to the database **and** rewrites `data/<shop>.json`, so the JSON file stays a full, current backup.
- First start with an empty database: the existing JSON khata is loaded and copied into it (no separate import needed).
- Database unreachable at start: the first connection is retried (DB_START_RETRY_MS, default `2000,5000,10000,20000`,
  enough for a Neon compute to wake up). If it still fails the server logs `Database unreachable at start (...)` with the
  error code of every address tried, runs on the JSON file and leaves `data/<shop>.db-fallback`. It keeps retrying in the
  background (DB_RECONNECT_MS, default 60000, 0 = off); once the database answers, the current khata is copied into it
  and the server saves to the database without a restart (/healthz `storage.kind` changes back).
- IPv6: the server prefers IPv4 (`dns.setDefaultResultOrder('ipv4first')`) and gives each address 2.5 s
  (NET_FAMILY_ATTEMPT_MS) instead of Node's 250 ms, so an unroutable IPv6 address plus a slow IPv4 handshake no longer
  ends in an AggregateError.
- A failed write while running is logged (`Database save failed`) and retried with the next save; the JSON copy is still written.
- `/healthz` shows `storage: { kind, dualWriteJson, fallback, lastError }`.
- Roll back: remove the three lines and restart; the JSON file is current.

Default: the khata stays in `data/<shop>.json`. Nothing changes unless `DATABASE_URL` is set.

## Use it
- `pg` is a regular dependency (installed by `npm ci` and in the Docker image); without `DATABASE_URL` it is never loaded.
- Set `DATABASE_URL=postgres://user:pass@host/db`. Optional `SHOP_ID` overrides the row key (default: the `SHOP` id, e.g. `gupta`).
- The table `shop_state` is created on start.

## Design choice
One table, `shop_state(shop_id text primary key, state jsonb, updated_at timestamptz)`, one row per shop, holding the same state object the JSON file holds. Why: the app keeps the whole khata in memory and derives balances from the transactions, so storing the identical object keeps behaviour exactly the same, needs no per-table mapping, and isolates shops by primary key. Every change is written through as a single `INSERT ... ON CONFLICT DO UPDATE` statement (atomic, in order, latest state wins). Normalised tables can come later if reporting across shops is needed.

Several shops can share one database by giving each server a different `SHOP_ID`.

## Behaviour notes
- State is loaded once at start and kept in memory; writes are queued and applied in order. A failed write is logged (`Database save failed`) and the next change retries with the full latest state.
- The WhatsApp link session files (`wa-web-auth`) still live under `DATA_DIR`; they are not in the database.

## Import an existing JSON khata
```
DATABASE_URL=... node dist-server/scripts/import-json-to-pg.js data/gupta.json gupta          # dry run
DATABASE_URL=... node dist-server/scripts/import-json-to-pg.js data/gupta.json gupta --apply  # write
```
An existing row is not overwritten unless `--force` is added.

## Tests
`TEST_DATABASE_URL=postgres://user:pass@localhost/scratch npm test` runs the database tests (they drop and recreate `shop_state`, so use a scratch database). Without it they are skipped.

---

# Normalised tables with Row-Level Security (`STORE=pg-tables`)

Set `DATABASE_URL=...` and `STORE=pg-tables`. The file store stays the default and `DATABASE_URL` alone still selects the `shop_state` jsonb mode above. App logic is unchanged: the khata is still one object in memory; `server/tables.js` maps it to tables on load and on every save.

## Layout
One PostgreSQL database. `shops` is the root; every other row carries `shop_id`.

```mermaid
erDiagram
  shops ||--o{ customers : has
  shops ||--o{ customer_txns : has
  shops ||--o{ traders : has
  shops ||--o{ trader_txns : has
  shops ||--o{ items : stocks
  shops ||--o{ messages : has
  shops ||--o{ orders : has
  shops ||--o{ shop_extras : has
  customers ||--o{ customer_txns : "udhaar / payment"
  traders ||--o{ trader_txns : "supply / payment"
  shops { text id PK; text name; text owner_name; text owner_phone; text upi_id; jsonb extra; timestamptz created_at }
  customers { text shop_id PK; text id PK; int pos; text name; text name_key; text phone; jsonb vpas; date due_date; date removed_on; bool guest; text vouched_by; jsonb vouch; jsonb extra }
  customer_txns { text shop_id PK; text id PK; text customer_id FK; text type; numeric amount; jsonb items; date txn_date; date due_date; text note; text source; bool voided; jsonb extra }
  traders { text shop_id PK; text id PK; text kind "wholesaler|supplier"; text name; text name_key; text phone; jsonb extra }
  trader_txns { text shop_id PK; text id PK; text trader_id FK; text type "supply|payment"; numeric amount; numeric paid; jsonb items; date txn_date; date due_date; jsonb extra }
  items { text shop_id PK; bigint id PK; text name "unique per shop, lower()"; text unit; numeric customer_rate; date customer_rate_updated_at; numeric trader_rate; text trader_unit; date trader_rate_updated_at; bool in_price_book; text source }
  messages { text shop_id PK; int pos PK; text to_party; text from_party; text body; date msg_date; jsonb extra }
  orders { text shop_id PK; int pos PK; text order_id; text customer_id; text status; date order_date; jsonb extra }
  shop_extras { text shop_id PK; text key PK; jsonb value }
```

- **customers / customer_txns**: `state.customers` / `state.txns`. A txn whose customer is no longer in the list keeps its id in `extra` with `customer_id` NULL (the FK stays valid).
- **traders / trader_txns**: `state.wholesalers` (kind `wholesaler`) plus suppliers that appear only in the supplier khata (kind `supplier`, id `sup:<key>`). `state.supplies` become `supply` rows (bill lines in `items`), `state.supplierPays` become `payment` rows.
- **items**: the inventory. Two rates per item: `customer_rate` (selling; from the app's rate book `state.prices`, learned when the owner says a rate) and `trader_rate` (buying; learned from supplier bills with quantity and price, newest bill wins). One row per item per shop (`UNIQUE (shop_id, lower(name))`); `name` is the app's normalised item key. Rates are upserted and rows are never deleted: an item dropped from the rate book keeps its row with `in_price_book = false`. `learnItemRate(client, shop, {name, side: 'customer'|'trader', rate, unit, at})` in `server/tables.js` updates one side only.
- **messages, orders**: their own tables. **shop_extras**: everything else in the khata (log, pending, cash claims, owner asks, stock orders, consents, seqs, today, ...), one jsonb row per key, plus the list of top-level keys.
- No data loss: typed columns hold the fields the app uses; any other field, or a value that does not fit its column (e.g. a non-date in a date field), is kept in the row's `extra` jsonb, and absent fields are recorded, so load returns exactly what was saved (tested with a used khata). Field order inside an object is not kept.

## Saving
Each save is one transaction for the shop. Every table whose rows changed since the last save is replaced for that shop (delete + one bulk insert); unchanged tables are not touched (replacing a customer or trader list also rewrites its txns because of the FK). Items are upserted. This is "full replace per changed table" rather than row-level diffing: simple and atomic, fine for a single shop's khata size. A failed save is logged and the next one rewrites every table.

## Isolation: Row-Level Security
Every table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy `shop_id = current_setting('app.shop_id', true)` (`id = ...` on `shops`), for reads and writes. The store runs each transaction after `set_config('app.shop_id', <shop>, true)`, so a connection can only see and write its own shop; with no shop set it sees nothing. Superusers and roles with `BYPASSRLS` skip RLS, so the app must connect as an ordinary role (tables owned by that role are still covered because of `FORCE`).

## Why one database with tables + RLS, not a database per shop
- **Connections**: a database per shop needs its own pool per shop; thousands of shops means thousands of pools/connections, which Postgres handles badly. One database shares one pool.
- **Migrations**: one schema change runs once, not N times with N chances to leave shops on different versions.
- **Backups / ops**: one backup, one restore, one monitoring target; cross-shop reporting is a plain query (from an admin role).
- RLS gives per-shop isolation in the database itself, not just in app code.
- **Later option**: schema-per-shop (`shop_gupta.customers`, ...) if a large shop needs physical separation; the same migrations would run per schema. Not needed now.

## Migrations
SQL files in `db/migrations/NNN_name.sql`, applied in order once each by `scripts/migrate.js` (recorded in `schema_migrations`, one transaction per file, advisory lock). The store runs them on start; `DATABASE_URL=... node dist-server/scripts/migrate.js` runs them by hand.

## Import
`DATABASE_URL=... STORE=pg-tables node dist-server/scripts/import-json-to-pg.js data/gupta.json gupta [--apply] [--force]`: same dry-run / no-overwrite rules as above, writes the tables.

## Tests
`test/pgtables.test.js` (migrations, lossless round-trip, change-only writes, two shops + RLS, item rate learning, import). Needs a scratch database reached as a non-superuser, e.g.:
```
sudo -u postgres psql -c "CREATE ROLE khata LOGIN PASSWORD 'khata'" -c "CREATE DATABASE khata_test OWNER khata"
TEST_DATABASE_URL=postgres://khata:khata@localhost/khata_test npm test
```
The tests drop and recreate the tables.

---

# One schema per shop (`STORE=pg-schema`)

Each shop gets its **own PostgreSQL schema** (a folder of tables), named from the shop id (`gupta` -> `gupta`,
`Gupta Kirana-2` -> `gupta_kirana_2`; ids that start with a digit or name a system schema get a `shop_` prefix; only
`[a-z0-9_]`, max 63 chars). Inside it the tables have **no `shop_id` column**: the schema is the shop, so "Gupta" is one
shop with its customers, traders, items and khata under it, not rows mixed with every other shop.
`public.shops` is the registry: one row per shop.

```
database
├── public
│   ├── shops            registry: id, name, owner_phone, city, schema_name, schema_version, created_at (+ owner_name, upi_id, extra)
│   └── schema_migrations
├── gupta                <- one shop
│   ├── customers        id PK, name, phone, due_date, ...
│   ├── customer_txns    id PK, customer_id -> customers.id, type, amount, items, txn_date, due_date
│   ├── traders          id PK, kind (wholesaler | supplier), name, phone
│   ├── trader_txns      id PK, trader_id -> traders.id, type (supply | payment), amount, paid, items
│   ├── items            id PK, name (unique, case-insensitive), units, customer_rate, trader_rate, updated_at, ...
│   ├── messages
│   ├── orders
│   └── extras           everything else in the khata (log, pending, ...), one row per key
└── sharma               <- another shop, same tables, fully separate
    └── ...
```

```mermaid
erDiagram
  SHOPS ||--|| SHOP_SCHEMA : "schema_name"
  SHOP_SCHEMA ||--o{ CUSTOMERS : contains
  CUSTOMERS ||--o{ CUSTOMER_TXNS : "customer_id"
  SHOP_SCHEMA ||--o{ TRADERS : contains
  TRADERS ||--o{ TRADER_TXNS : "trader_id"
  SHOP_SCHEMA ||--o{ ITEMS : contains
  SHOP_SCHEMA ||--o{ MESSAGES : contains
  SHOP_SCHEMA ||--o{ ORDERS : contains
  SHOP_SCHEMA ||--o{ EXTRAS : contains
```

- Turn on with `STORE=pg-schema` (plus `DATABASE_URL`, and `DUAL_WRITE_JSON=1` for SAFE mode). `pg-tables`, the
  `shop_state` mode and the file store keep working unchanged.
- On start: migrations run (`public.shops`), the registry columns are added if missing, and the shop's schema and
  tables are created if they do not exist (under an advisory lock, idempotent).
- Same safety as pg-tables: dual-write JSON, IPv4-first, start retries, background reconnect, fallback to the JSON
  file, and an empty schema is filled from the JSON khata on first start.
- The mapping is the pg-tables one (`server/tables.js`), so a load returns exactly the saved object. A rate-book
  entry's optional `traderRate` maps to `items.trader_rate` (a buying rate learned from a bill is never cleared by it).
- Code: `server/schema.js` (DDL, read/write), `createPgSchemaStore` in `server/store.js`.

## Move a live shop from pg-tables to its own schema
```
DATABASE_URL=... node dist-server/scripts/pg-tables-to-schema.js gupta            # dry run: row counts, writes nothing
DATABASE_URL=... node dist-server/scripts/pg-tables-to-schema.js gupta --apply    # copy + verify in one transaction
```
`--apply` creates the schema, copies every row (including items learned only in conversation), then checks the row
count of each table against the shared tables and that the khata read back equals the old one; any difference rolls
the whole copy back. The shared tables are only read, never changed, so switching back to `STORE=pg-tables` is
always possible. A schema that already holds a khata is not overwritten without `--force`.

## Fill demo structure
```
node dist-server/scripts/fill-demo.js data/gupta.json                              # dry run on a JSON khata
node dist-server/scripts/fill-demo.js data/gupta.json --apply
DATABASE_URL=... STORE=pg-schema node dist-server/scripts/fill-demo.js --shop gupta [--apply]
```
Fills only what is missing: a unit for every item (maggi/biscuit/doodh `pkt`, cheeni/atta `kg`, tel `l`, sabun `pc`, ...),
a Nagpur wholesale buying rate below the selling rate for every item, and for **demo customers only** (fake numbers:
the seed range `987650xxxx`, repeated digits, `1234567890`, or `demo: true` without a real number) a name, fake phone,
due date and a few varied udhaar/payment entries. Customers with a real-looking number, or no number and no demo mark,
are never touched. Idempotent: a second run reports `nothing to fill`. Run the database form with the server
stopped (the running server keeps the khata in memory and would write its copy back); with the server running,
use the JSON form on a copy instead.

## Tests
`TEST_SCHEMA_DATABASE_URL=postgres://khata:pw@localhost/khata_schema_test` runs `test/pgschema.test.js` against its own
scratch database (it drops schemas and the shared tables, so it must not be the `TEST_DATABASE_URL` database).

## Adding the demo shops, each with its own tables
`scripts/seed-shops.ts` puts demo shops (Zafar Sasta Bazaar `zafar`, Sai Krupa Kirana Store `saikrupa`, or any id in
`DEMO_SHOPS`) into the database in the pg-schema layout: a row in `public.shops` and one schema per shop with its own
`customers`, `customer_txns`, `traders`, `trader_txns`, `items`, `messages`, `orders` and `extras` tables.
```
npm run build
DATABASE_URL=... node dist-server/scripts/seed-shops.js zafar saikrupa            # dry run: prints what it would write
DATABASE_URL=... node dist-server/scripts/seed-shops.js zafar saikrupa --apply    # writes, then reads back and checks
```
- Each shop is written in one transaction and read back; any difference rolls it back.
- A shop whose schema already holds a khata is left alone unless `--force` is given.
- The Gupta shop on the live server stays where it is (`STORE=pg-tables`). To move it into its own schema too, use
  `scripts/pg-tables-to-schema.ts gupta --apply`.
- To serve one of these shops, run a server with `SHOP=zafar STORE=pg-schema` (one server per shop).

## Self-registered shops (migration 003)

The entry page lets a new owner register a shop. Each one gets a new shop id (`s` + 10 hex characters) and is stored
exactly like the instance's own shop, under its own id: its own `shop_state` row / RLS-scoped rows / schema, and its own
rows in `shop_owners`, `owner_sessions` and `shop_profiles`. `shop_accounts` (db/migrations/003_shop_accounts.sql)
maps the owner's phone to the shop id (unique per phone). The migration only adds a table and an index, both
`IF NOT EXISTS`; nothing existing is altered, so the instance's own shop (e.g. `gupta`) needs no data migration.
