# bizos — open-source AI business OS

> Self-hostable AI business OS — social lead capture, shared WhatsApp
> inbox, contacts, sales pipelines, broadcasts, and no-code automations.
> Fork it, brand it, host it.

**bizos** is a fork of the MIT-licensed
[wacrm](https://github.com/ArnasDon/wacrm) template (WhatsApp CRM),
extended into an open-source "AI business OS":

- **Social lead capture (NEW)** — one normalized lead stream fed by
  HMAC-verified inbound webhooks (Facebook Lead Ads, Justdial, website
  contact forms) plus an Instagram comment-to-DM keyword trigger engine
- **Shared inbox** on the official WhatsApp Business API — multiple
  agents on one number, assignment, statuses, notes
- **Contacts + tags + custom fields**, CSV import, deduplication
- **Sales pipelines** (Kanban) with deals linked to conversations
- **Broadcasts** with Meta-approved templates and delivery tracking
- **No-code automations** — visual builder, triggers, conditions, waits
- **AI reply assistant** — bring your own provider key, encrypted at rest

## Quick start

```bash
git clone <your-fork> && cd bizos
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm run dev
```

Open http://localhost:3000. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4
- **Data** — Supabase (Postgres + Auth + Storage + RLS)

## Documentation

- `MODULE1.md` — social lead capture: endpoints, data model, setup
- `docs/` — inherited wacrm docs (inbox, automations, public API, …)

## License

MIT. See [LICENSE](LICENSE).
