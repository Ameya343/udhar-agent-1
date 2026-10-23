# PostgreSQL storage (optional)

Default: the khata stays in `data/<shop>.json`. Nothing changes unless `DATABASE_URL` is set.

## Use it
- `npm install` (the `pg` package is an optional dependency; without it the JSON default works as before).
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
DATABASE_URL=... node scripts/import-json-to-pg.js data/gupta.json gupta          # dry run
DATABASE_URL=... node scripts/import-json-to-pg.js data/gupta.json gupta --apply  # write
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
SQL files in `db/migrations/NNN_name.sql`, applied in order once each by `scripts/migrate.js` (recorded in `schema_migrations`, one transaction per file, advisory lock). The store runs them on start; `DATABASE_URL=... node scripts/migrate.js` runs them by hand.

## Import
`DATABASE_URL=... STORE=pg-tables node scripts/import-json-to-pg.js data/gupta.json gupta [--apply] [--force]`: same dry-run / no-overwrite rules as above, writes the tables.

## Tests
`test/pgtables.test.js` (migrations, lossless round-trip, change-only writes, two shops + RLS, item rate learning, import). Needs a scratch database reached as a non-superuser, e.g.:
```
sudo -u postgres psql -c "CREATE ROLE khata LOGIN PASSWORD 'khata'" -c "CREATE DATABASE khata_test OWNER khata"
TEST_DATABASE_URL=postgres://khata:khata@localhost/khata_test npm test
```
The tests drop and recreate the tables.
