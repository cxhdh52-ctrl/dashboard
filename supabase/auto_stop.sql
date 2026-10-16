-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Auto-stop (netlify/functions/_shared/auto-stop.js): pauses a campaign once
-- its profit since launch drops to -$threshold below its baseline.
--   lifetime_profit      last computed payout - spend since launch
--   auto_stop_baseline   0 by default; set to lifetime_profit when you turn an
--                        auto-stopped campaign back on (gives it another $10)
--   auto_stopped_at/_reason  set when auto-stop paused it
--
-- app_settings holds the on/off switch + threshold (key "auto_stop").

alter table tiktok_campaigns add column if not exists lifetime_profit numeric;
alter table tiktok_campaigns add column if not exists lifetime_checked_at timestamptz;
alter table tiktok_campaigns add column if not exists auto_stop_baseline numeric not null default 0;
alter table tiktok_campaigns add column if not exists auto_stopped_at timestamptz;
alter table tiktok_campaigns add column if not exists auto_stop_reason text;

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Audit trail (shared with the old testing/scale engine's log table).
create table if not exists testing_scale_events (
  id bigint generated always as identity primary key,
  campaign_id text not null,
  campaign_name text,
  connection_id uuid,
  advertiser_id text,
  ts timestamptz not null default now(),
  from_state text not null,
  to_state text not null,
  reason text not null,
  spend_at_decision numeric not null default 0,
  payout_at_decision numeric not null default 0,
  conversions_at_decision numeric not null default 0,
  roas_at_decision numeric not null default 0
);
create index if not exists testing_scale_events_campaign_idx on testing_scale_events (campaign_id, ts desc);
