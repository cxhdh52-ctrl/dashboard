-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- WH Warmup cleanup, server-side: every 30 seconds Postgres calls the
-- dashboard's cleanup endpoint, so WH campaigns are paused + deleted the moment
-- they go live even when nobody has the dashboard open. Only calls out while
-- there is a WH still waiting / pausing / deleting.
--
-- Also adds spend / last_status, written by every cleanup pass.

alter table wh_warmup_campaigns add column if not exists spend numeric;
alter table wh_warmup_campaigns add column if not exists last_status text;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('wh-cleanup') where exists (select 1 from cron.job where jobname = 'wh-cleanup');

select cron.schedule(
  'wh-cleanup',
  '30 seconds',
  $$
  select net.http_post(
    url := 'https://kryzxrads.vercel.app/api/wh-warmup',
    body := '{"action":"cleanup"}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 60000
  )
  where exists (
    select 1 from wh_warmup_campaigns
    where cleanup_status in ('WAITING_FOR_ACTIVE', 'PAUSE_PENDING', 'DELETE_PENDING')
  );
  $$
);
