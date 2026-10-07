-- Pulse contract v1 — Memoria's implementation.
-- Every project exposes the same read-only views in a `pulse` schema; Memoria Pulse
-- reads only these, through a login that can't see anything else.
-- Column names and types are the contract; the SELECTs underneath are per project.

CREATE SCHEMA IF NOT EXISTS pulse;

-- Who uses it. One row per account (here: a family space).
CREATE OR REPLACE VIEW pulse.users AS
SELECT f.id::text AS id, f.owner_name AS name, f.plan, f.timezone AS region, f.device,
       f.created_at, f.last_seen
FROM families f;

-- Everything that happened. `ms` is set for timed steps (AI calls), `ok = false` for failures.
CREATE OR REPLACE VIEW pulse.events AS
SELECT e.family_id::text AS user_id, e.name, e.ms, e.ok, e.created_at
FROM events e;

-- Who is here right now and what they are doing.
CREATE OR REPLACE VIEW pulse.presence AS
SELECT p.family_id::text AS user_id, p.view, p.person AS subject, p.seen_at
FROM presence p;

-- Plain-language names for event types and screens.
CREATE OR REPLACE VIEW pulse.labels AS
SELECT * FROM (VALUES
  ('event', 'family_created', 'opened a new family space'),
  ('event', 'onboarded', 'finished setup'),
  ('event', 'person_added', 'added a loved one'),
  ('event', 'memory_saved', 'kept a story'),
  ('event', 'transcribed', 'had a recording written out'),
  ('event', 'question_asked', 'asked a question'),
  ('event', 'tribute', 'read the tribute'),
  ('event', 'listen', 'listened to a recording'),
  ('event', 'clip_played', 'heard the moment it was said'),
  ('event', 'checkout_started', 'opened checkout'),
  ('event', 'purchase', 'bought Lifetime'),
  ('event', 'upgrade_viewed', 'looked at Lifetime'),
  ('event', 'share_link', 'shared the family link'),
  ('event', 'print', 'printed the keepsake'),
  ('event', 'export', 'downloaded stories'),
  ('event', 'memory_deleted', 'deleted a story'),
  ('event', 'prompt_used', 'used a question prompt'),
  ('event', 'credit_fallback', 'got a fallback (credits low)'),
  ('event', 'error', 'hit an error'),
  ('step', 'question_asked', 'Answering a question'),
  ('step', 'memory_saved', 'Keeping a story'),
  ('step', 'transcribed', 'Turning voice into text'),
  ('step', 'tribute', 'Writing the tribute'),
  ('view', 'home', 'reading the album'),
  ('view', 'record', 'recording a story'),
  ('view', 'ask', 'asking a question'),
  ('view', 'story', 'on Keep forever')
) AS t(kind, key, label);

-- The project's own headline numbers (shown as tiles after the standard ones).
CREATE OR REPLACE VIEW pulse.kpis AS
SELECT * FROM (
  SELECT 1 AS sort, 'Stories kept' AS label, (SELECT COUNT(*) FROM memories)::numeric AS value,
         (SELECT COUNT(*) FROM memories WHERE source = 'voice') || ' by voice · ' ||
         (SELECT COUNT(*) FROM memories WHERE created_at > now() - interval '24 hours') || ' today' AS hint
  UNION ALL
  SELECT 2, 'Questions asked', (SELECT COUNT(*) FROM events WHERE name = 'question_asked')::numeric,
         (SELECT COUNT(*) FROM events WHERE name = 'question_asked' AND created_at > now() - interval '24 hours') || ' today'
  UNION ALL
  SELECT 3, 'Loved ones', (SELECT COUNT(*) FROM persons)::numeric,
         'across all family albums'
  UNION ALL
  SELECT 4, 'Minutes of real voice', ROUND((SELECT COALESCE(SUM(duration_s), 0) FROM recordings)::numeric / 60, 1),
         (SELECT COUNT(*) FROM recordings) || ' recordings kept'
) k;

-- The journey from first visit to paying, in order.
CREATE OR REPLACE VIEW pulse.funnel AS
SELECT * FROM (
  SELECT 1 AS step, 'Opened Memoria' AS label, (SELECT COUNT(*) FROM families)::int AS users
  UNION ALL SELECT 2, 'Kept a story', (SELECT COUNT(DISTINCT family_id) FROM memories)::int
  UNION ALL SELECT 3, 'Asked a question', (SELECT COUNT(DISTINCT family_id) FROM events WHERE name = 'question_asked')::int
  UNION ALL SELECT 4, 'Opened checkout', (SELECT COUNT(DISTINCT family_id) FROM events WHERE name = 'checkout_started')::int
  UNION ALL SELECT 5, 'Bought Lifetime', (SELECT COUNT(*) FROM families WHERE plan = 'lifetime')::int
) f;

-- Money in.
CREATE OR REPLACE VIEW pulse.revenue AS
SELECT COUNT(*)::int AS paying, (COUNT(*) * 19)::numeric AS revenue_usd, 'USD'::text AS currency,
       COUNT(*) FILTER (WHERE paid_at > now() - interval '7 days')::int AS paying_7d
FROM families WHERE plan = 'lifetime';

-- Partner credits left, so nothing runs dry unnoticed.
CREATE OR REPLACE VIEW pulse.credits AS
SELECT provider, label, remaining, unit, budget, updated_at FROM credits;

-- Daily series for charts. `active` and `new_users` are standard; the rest are per project.
CREATE OR REPLACE VIEW pulse.daily AS
WITH days AS (SELECT d::date AS day FROM generate_series(current_date - 29, current_date, interval '1 day') d)
SELECT day, 'active' AS metric, 'Active families' AS label,
       (SELECT COUNT(DISTINCT family_id) FROM events e WHERE e.created_at::date = day)::int AS value FROM days
UNION ALL
SELECT day, 'new_users', 'New families', (SELECT COUNT(*) FROM families f WHERE f.created_at::date = day)::int FROM days
UNION ALL
SELECT day, 'series_a', 'Stories kept', (SELECT COUNT(*) FROM memories m WHERE m.created_at::date = day)::int FROM days
UNION ALL
SELECT day, 'series_b', 'Questions asked', (SELECT COUNT(*) FROM events e WHERE e.name = 'question_asked' AND e.created_at::date = day)::int FROM days;
