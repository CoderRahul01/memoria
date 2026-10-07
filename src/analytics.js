/**
 * Founder analytics: who is here right now (in-memory presence from heartbeats),
 * plus growth, usage and performance numbers queried from the events table.
 */
const db = require('./db');

const LIVE_WINDOW_MS = 75_000;
const presence = new Map(); // family id → { view, person, at, name, plan, timezone, device }

function heartbeat(family, { view, person } = {}) {
  presence.set(family.id, {
    view: String(view || 'home').slice(0, 20),
    person: person ? String(person).slice(0, 40) : null,
    at: Date.now(),
    name: family.owner_name,
    plan: family.plan,
    timezone: family.timezone,
    device: family.device
  });
}

function liveNow() {
  const cutoff = Date.now() - LIVE_WINDOW_MS;
  const rows = [];
  for (const [id, p] of presence) {
    if (p.at < cutoff) { presence.delete(id); continue; }
    rows.push({ family: id.slice(0, 8), ...p, seconds_ago: Math.round((Date.now() - p.at) / 1000) });
  }
  return rows.sort((a, b) => a.seconds_ago - b.seconds_ago);
}

async function stats() {
  const [totals, growth, activity, perf, funnel, recent, families, regions] = await Promise.all([
    db.one(`SELECT
        (SELECT COUNT(*)::int FROM families) AS families,
        (SELECT COUNT(*)::int FROM families WHERE created_at > now() - interval '24 hours') AS families_24h,
        (SELECT COUNT(*)::int FROM families WHERE plan = 'lifetime') AS paying,
        (SELECT COUNT(*)::int FROM persons) AS loved_ones,
        (SELECT COUNT(*)::int FROM memories) AS memories,
        (SELECT COUNT(*)::int FROM memories WHERE source = 'voice') AS voice_memories,
        (SELECT COUNT(*)::int FROM memories WHERE created_at > now() - interval '24 hours') AS memories_24h,
        (SELECT COUNT(*)::int FROM events WHERE name = 'question_asked') AS questions,
        (SELECT COUNT(*)::int FROM persons WHERE voice_id IS NOT NULL) AS voices,
        (SELECT COUNT(DISTINCT family_id)::int FROM events WHERE created_at > now() - interval '24 hours') AS dau,
        (SELECT COUNT(DISTINCT family_id)::int FROM events WHERE created_at > now() - interval '7 days') AS wau`),
    db.q(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
             (SELECT COUNT(*)::int FROM families f WHERE f.created_at::date = d) AS new_families,
             (SELECT COUNT(*)::int FROM memories m WHERE m.created_at::date = d) AS memories,
             (SELECT COUNT(*)::int FROM events e WHERE e.name = 'question_asked' AND e.created_at::date = d) AS questions,
             (SELECT COUNT(DISTINCT family_id)::int FROM events e WHERE e.created_at::date = d) AS active
          FROM generate_series(current_date - 29, current_date, interval '1 day') AS d`),
    db.q(`SELECT name, COUNT(*)::int AS n FROM events WHERE created_at > now() - interval '7 days'
          GROUP BY name ORDER BY n DESC`),
    db.q(`SELECT name,
             COUNT(*)::int AS n,
             ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::int AS p50,
             ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::int AS p95,
             ROUND(100.0 * AVG(CASE WHEN ok THEN 0 ELSE 1 END), 1)::float AS error_pct
          FROM events WHERE ms IS NOT NULL AND created_at > now() - interval '7 days'
          GROUP BY name ORDER BY n DESC`),
    db.one(`SELECT
        (SELECT COUNT(*)::int FROM families) AS opened,
        (SELECT COUNT(DISTINCT family_id)::int FROM memories) AS recorded,
        (SELECT COUNT(DISTINCT family_id)::int FROM events WHERE name = 'question_asked') AS asked,
        (SELECT COUNT(DISTINCT family_id)::int FROM events WHERE name = 'checkout_started') AS checkout,
        (SELECT COUNT(*)::int FROM families WHERE plan = 'lifetime') AS paid`),
    db.q(`SELECT e.name, e.props, e.ms, e.ok, e.created_at, f.owner_name, left(e.family_id::text, 8) AS family
          FROM events e LEFT JOIN families f ON f.id = e.family_id
          ORDER BY e.created_at DESC LIMIT 40`),
    db.q(`SELECT left(f.id::text, 8) AS family, f.owner_name, f.plan, f.timezone, f.device, f.created_at, f.last_seen,
             (SELECT COUNT(*)::int FROM persons p WHERE p.family_id = f.id) AS loved_ones,
             (SELECT COUNT(*)::int FROM memories m WHERE m.family_id = f.id) AS memories
          FROM families f ORDER BY f.last_seen DESC LIMIT 50`),
    db.q(`SELECT COALESCE(split_part(timezone, '/', 1), 'Unknown') AS region, COUNT(*)::int AS n
          FROM families GROUP BY 1 ORDER BY n DESC LIMIT 8`)
  ]);

  return {
    generated_at: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    live: liveNow(),
    totals, growth, activity, perf, funnel, recent, families, regions
  };
}

module.exports = { heartbeat, liveNow, stats };
