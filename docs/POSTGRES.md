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
