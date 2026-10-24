# Udhaar Agent

An AI munshi for a kirana shop. The shopkeeper runs the khata from **WhatsApp only**: a text or a voice note in Hindi, Hinglish or any other language ("Sharma ji ne 340 ka saaman liya, kal denge") becomes a khata entry. The customer gets the entry on their own WhatsApp with **Haan, sahi hai / Galat hai**, the agent sends reminders that get firmer as the due ages, and an evening summary goes to the owner. A view-only dashboard shows total baaki, who is late and the collection rate.

## How it works

- **WhatsApp is the only place the owner acts.** The agent is a linked device on an ordinary WhatsApp number (Baileys, WhatsApp Web style). Every add, payment, order, edit and removal happens in chat. There is no chat or edit button on the dashboard.
- **Voice notes** are transcribed with **ElevenLabs Scribe**, then handled like a typed message.
- **LLM-first understanding.** Each message goes to a model that returns strict JSON (intent, name, amount, items, due date). The chain is:
  1. your own OpenAI-compatible endpoint (`LLM_BASE_URL`, optional),
  2. the **Agent37 model router**,
  3. offline Hinglish rules, if both models fail, time out or return JSON that fails the schema.
- **Safety rules** sit on top of the model, so a wrong guess cannot change money:
  - the amount must actually appear in the message; the agent never invents one,
  - an unknown name, or a name that looks like an existing customer, gets a question back instead of a guess,
  - orders need the owner's ok before they are written,
  - the agent only messages numbers that wrote to it first.
- **Storage:** PostgreSQL on **Neon** with row-level security (RLS), plus a JSON backup on disk.
- **Backend:** TypeScript (`core/`, `server/`, `scripts/`), compiled to `dist-server/`.
- **Dashboard:** view-only, served by the agent. It opens only with `?key=ADMIN_KEY`; without the key it shows nothing from the khata.

## Run one shop locally

```
npm ci
npm run build
SHOP=gupta PORT=8000 node dist-server/server/server.js
```

Main settings (put them in the env file, never in the repo):

| Variable | Meaning |
|---|---|
| `PORT`, `SHOP`, `DATA_DIR` | Port, shop id, and folder for the JSON backup and WhatsApp session. |
| `DATABASE_URL` | Neon PostgreSQL connection string. |
| `ADMIN_KEY` | Key for the view-only dashboard (`/?key=...`). |
| `OWNER_WHATSAPP` | The owner's WhatsApp number. |
| `AGENT37_LLM_PROXY_URL`, `AGENT37_MANAGED_TOKEN` | The Agent37 model router; set by Agent37 on the instance. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Optional own OpenAI-compatible model, tried before the router. |
| `ELEVENLABS_API_KEY` | Voice-note transcription (Scribe). |
| `REAL_CLOCK` | `1` turns on the scheduler (reminders, evening summary). |

## Agent37: how we use it

Agent37 is not just a host here; it runs the shop's agent end to end.

- **Always-on instance per shop.** Each shop gets its own Agent37 instance. It runs the agent server and keeps the WhatsApp linked-device session alive 24/7, so messages are answered at any hour.
- **The AI is the Agent37 model router.** Every owner and customer message, in any language, goes through the router and comes back as strict JSON that the safety rules then check. If our own endpoint is configured it goes first; the router is the main path, and the offline rules are only the last fallback.
- **Scheduler.** The instance's clock drives the due-date reminders in the morning and the owner's evening summary.
- **Template revisions.** The app is built as an Agent37 template. Each change is a new revision, and updating or rolling back is one step. We shipped 41 revisions this way without losing any khata data, because the data lives outside the image.
- **Public port.** The instance exposes the agent's port, which serves the view-only dashboard (still locked behind `ADMIN_KEY`).
- **Files on the instance.** Settings live in `/home/node/udhaar.env`; data (JSON backup, WhatsApp session) lives in `/home/node/data`.
- **Honest notes.** One instance costs about Rs 420 per month. A multi-shop setup (one database schema per shop) is built and tested but not switched on yet; today it is one instance per shop.

## Build and test

```
npm ci
npm run typecheck
npm test
```

`npm run build` compiles the TypeScript and builds the dashboard page from `web/index.src.html` into `index.html` and `dist/`. Never edit `dist/` by hand.

`npm test` runs about 307 tests (parser, safety rules, WhatsApp flows, voice notes, PostgreSQL store, dashboard, stress tests). Tests that need a live database are skipped without one.

## Layout

| Path | What it is |
|---|---|
| `core/` | The agent: parser, ledger, reminders, understanding prompts and JSON schema check. |
| `server/` | The shop server: WhatsApp (Baileys), LLM chain, store (PostgreSQL + JSON), schema. |
| `db/migrations/` | PostgreSQL migrations, including RLS. |
| `scripts/` | Migrate, import JSON to PostgreSQL, evals. |
| `web/index.src.html` | The dashboard source. |
| `test/` | Tests. |
| `Dockerfile` | The Agent37 template image. |
