-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Creative Library (netlify/functions/creative-library.js).
--   creative_angles   one row per hook/angle (variations point at their parent)
--   campaign_angles   which angle each campaign runs; backfill_* = its spend /
--                     revenue up to backfill_until, read once when tagged
--   campaign_daily    per-campaign spend/revenue per NY day, written by every
--                     metrics cycle (tiktok-campaigns.js) — counted after backfill_until
--   angle_feedback    variations the user kept / dropped (Claude learns from these)

create extension if not exists pgcrypto;

create table if not exists creative_angles (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  offer       text,
  status      text not null default 'active',      -- active | archived
  parent_id   uuid references creative_angles(id) on delete set null,
  source      text not null default 'manual',      -- manual | variation | spark_maker
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists creative_angles_text_uq on creative_angles (lower(text));

create table if not exists campaign_angles (
  campaign_id          text primary key,
  angle_id             uuid not null references creative_angles(id) on delete cascade,
  tagged_at            timestamptz not null default now(),
  backfill_until       date,
  backfill_spend       numeric not null default 0,
  backfill_revenue     numeric not null default 0,
  backfill_conversions numeric not null default 0
);
create index if not exists campaign_angles_angle_idx on campaign_angles (angle_id);

create table if not exists campaign_daily (
  campaign_id  text not null,
  date         date not null,
  spend        numeric not null default 0,
  revenue      numeric not null default 0,
  conversions  numeric not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (campaign_id, date)
);

create table if not exists angle_feedback (
  id          bigint generated always as identity primary key,
  angle_id    uuid references creative_angles(id) on delete set null,
  text        text not null,
  kept        boolean not null,
  created_at  timestamptz not null default now()
);
create index if not exists angle_feedback_created_idx on angle_feedback (created_at desc);
