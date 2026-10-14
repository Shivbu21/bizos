# MODULE 3 — Drip follow-up sequencer

The "multi-day drip follow-ups" stage: automated WhatsApp follow-up
sequences that never talk over a human. Built as clean-room code on
the bizos fork — features and workflows only, no third-party code,
copy, or branding. Additive: Modules 1–2 and all base functionality
are untouched (one hook added to the WhatsApp webhook's inbound path).

## What was built

**A. Data model** — `supabase/migrations/041_followup_sequences.sql`

- `followup_sequences` — name, description, active flag, per-account
  `daily_send_cap` (0 = unlimited), `quiet_start`/`quiet_end`
  (`HH:MM`, overnight windows supported), `timezone`
  (default `Asia/Kolkata`).
- `sequence_steps` — `step_order` (0-based, unique per sequence),
  `day_offset` (days after enrollment; 0 = first cron run),
  `channel` (`whatsapp`), `message_template` with `{{name}}` /
  `{{business}}` variables, optional `fallback`.
- `sequence_enrollments` — contact (+ optional Module-1 `lead_id`
  back-link), status
  (`active → paused → completed | opted_out | cancelled`),
  `current_step`, `enrolled_at`, `next_due_at`. A partial unique
  index keeps one *active* journey per (sequence, contact);
  re-enrollment after completion/opt-out is allowed.
- `followup_sends` — append-only log. Rows for every send attempt
  (`sent` with Meta's `provider_message_id`, `failed` with the
  error) plus lifecycle events (`enrolled`, `paused_on_reply`,
  `paused`, `resumed`, `opted_out`, `completed`, `cancelled`,
  `step_id` NULL). No UPDATE/DELETE policy — dashboards read only.
- RLS mirrors Modules 1–2: members read; agent+ manage sequences,
  steps, enrollments; admin+ delete; only the service role writes
  `followup_sends`.

**B. Scheduler** — `src/lib/followups/scheduler.ts` (pure, 23 unit tests)

- `computeStepDue(enrolledAt, dayOffset, quiet)` — enrollment wall
  time + N days, pushed past quiet hours to the window's end.
- Quiet hours evaluated on the contact-local clock via `Intl`
  (no date library); overnight windows (21:00 → 09:00) handled;
  start === end disables the window.
- `selectDueEnrollments` — active, `next_due_at <= now`; splits out
  rows currently inside quiet hours (deferred, retried next tick).
- `withinDailyCap(sentToday, cap)` — cap ≤ 0 = unlimited; the "day"
  is the sequence-timezone calendar day.
- `isOptOut` — word-token match for STOP / UNSUBSCRIBE
  (case-insensitive; "please STOP sending" also opts out —
  over-opting-out is the safe compliance failure mode).
- `renderTemplate` — `{{name}}` / `{{business}}`, whitespace- and
  case-tolerant; unknown variables left untouched.

**C. Cron worker** — `src/lib/followups/send.ts` + `POST /api/cron/followups`

- Secret-verified (`x-cron-secret` vs `FOLLOWUP_CRON_SECRET`;
  503 if unconfigured, 401 on mismatch), `maxDuration = 120`.
- Claims each due enrollment with a conditional UPDATE
  (`status='active' AND next_due_at <= now`) that pushes
  `next_due_at` forward — overlapping cron ticks can't double-send.
- Per enrollment: sequence must be active; quiet hours → reschedule
  to window end; daily cap → reschedule to next local midnight;
  renders the template (contact name + account name); sends through
  the base template's `engineSendText` (no reimplemented Meta code);
  advances `current_step` and recomputes `next_due_at`, or marks
  `completed` after the last step.
- Failed sends are logged and retried in 15 minutes. Missing
  WhatsApp config or contact phone fails loudly in the timeline
  rather than silently.

**D. Reply detection** — `src/lib/followups/inbound.ts`

- Hooked into the WhatsApp webhook's per-message path (inside
  `after()`, awaited like the other dispatches): every inbound
  message — even flow-consumed ones — pauses the contact's
  active/paused enrollments (`paused_on_reply` logged); STOP /
  UNSUBSCRIBE sets `opted_out` (terminal — the scheduler never
  selects these again). Pure decision (`inboundDisposition`) is
  unit-tested; the DB application owns its own error handling.

**E. API** — `src/app/api/followups/…`

- `sequences`: GET / POST (agent+). `[id]`: GET / PATCH (agent+) /
  DELETE (admin+).
- `[id]/steps`: GET / POST (agent+; auto-assigns next `step_order`).
  `[id]/steps/[stepId]`: PATCH (agent+) / DELETE (admin+; no
  renumbering — in-flight enrollments keep their index).
- `enrollments`: GET with `?status=` / `?sequence_id=` filters;
  POST enroll (agent+) — validates sequence/contact/lead tenancy,
  requires a `step_order 0` step, computes the first due date,
  logs `enrolled`. Duplicate active enrollment → 409.
- `enrollments/[id]`: GET detail + full timeline; PATCH
  `{action: pause|resume|cancel}` (agent+) — resume continues at
  the *next* step (or completes if none left).

**F. Admin UI** — `/follow-ups` (sidebar: Follow-ups)

- Sequences tab: sequence cards (active toggle, quiet window,
  daily cap), visual step builder with day-offset badges and live
  `{{name}}`/`{{business}}` previews, sequence settings dialog.
- Enrollments tab: status filter, contact search picker for new
  enrollments, pause / resume / cancel actions, click-through
  journey timeline dialog showing every send and lifecycle event.
- Structure edits (sequences/steps) are admin-gated
  (`useCan("edit-settings")`) like Module 1; light-first styling
  identical to Modules 1–2 (`#FAF6EF` paper, white cards, indigo
  accent). EN + KO sidebar labels.

## Scheduling rules (summary)

1. A step is due at enrollment time + `day_offset` days, pushed past
   quiet hours. Quiet hours default to 21:00–09:00 Asia/Kolkata and
   are configurable per sequence.
2. Due enrollments are processed only when `status = active` and the
   sequence itself is active.
3. Per-account daily cap counts `sent` rows on the sequence-timezone
   calendar day; overflow reschedules to the next local midnight.
4. Any inbound message from the contact pauses active enrollments;
   STOP/UNSUBSCRIBE opts out permanently.
5. Manual resume continues at the next step, never re-sends the
   interrupted one. Cancel is terminal.

## Triggering the cron

Every 5–15 minutes, POST with the secret header:

- **Vercel Cron** — `vercel.json`:
  `{ "crons": [{ "path": "/api/cron/followups", "method": "POST",
  "schedule": "*/10 * * * *" }] }` with `CRON_SECRET`-style header
  config (Vercel sends its own auth; alternatively keep the
  `x-cron-secret` check and call from an external pinger).
- **pg_cron** (Supabase):
  `SELECT cron.schedule('followups', '*/10 * * * *', $$SELECT
  net.http_post('https://<host>/api/cron/followups',
  headers := '{"x-cron-secret": "<FOLLOWUP_CRON_SECRET>"}'::jsonb)$$);`
- **External** — cron-job.org / UptimeRobot POST with the header.

`FOLLOWUP_CRON_SECRET` is documented in `.env.local.example`
(generate with `openssl rand -hex 32`).

## Verified

- `tsc --noEmit` clean (4 errors found and fixed during the build:
  Select `onValueChange` nullability ×2, a missing lucide import,
  one snake_case/camelCase mapping).
- `npm run build` succeeds (dummy Supabase env, same caveat as
  Module 2 — the pre-existing `/forgot-password` prerender issue is
  unrelated). All new routes present in production output:
  `/follow-ups`, `/api/cron/followups`, six `/api/followups/*`
  routes.
- `npm test` (vitest): **895 passed / 84 files** (up from 872),
  including **23 new scheduler tests** — opt-out token matching
  (incl. the "stopwatch" near-miss), template rendering, overnight
  and same-day quiet windows, boundary inclusivity (21:00 in,
  09:00 out), quiet-shift math (22:00 IST → next-day 09:00 IST),
  day-offset due dates, due/deferred selection, daily caps,
  timezone day boundaries, and inbound disposition priority
  (opt-out wins over pause; none when no active enrollments).

## Not verified (needs real services / data)

- The Supabase migration was syntax-checked, not applied to a live
  database (no Supabase project exists for this fork yet) — tables,
  the partial unique index, and RLS policies need a live apply.
- Live WhatsApp delivery — sends go through the base template's
  proven `engineSendText`, but no Meta credentials were pointed at
  it; every send would fail-and-log today.
- The cron route has no real scheduler pointed at it; claim-race
  safety is by construction (conditional UPDATE) but untested
  under concurrent invocations.
- `fallback` templates are stored but not wired to any send path
  (reserved for a future Meta template-approval check).
- Timeline rendering and the step builder were not exercised in a
  real browser (headless build only).
