-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Metrics cycle, server-side: every 2 minutes Postgres calls the dashboard's
-- "metrics" action, so auto-stop and auto budget-bump react within ~2 minutes
-- even when nobody has the dashboard open (the GitHub Actions tick stays as a
-- 15-minute backup). The function skips a cron call when any metrics run
-- started in the last ~100s (e.g. an open dashboard is already polling).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('metrics-tick') where exists (select 1 from cron.job where jobname = 'metrics-tick');

select cron.schedule(
  'metrics-tick',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://kryzxrads.vercel.app/api/tiktok-campaigns',
    body := '{"action":"metrics","source":"cron"}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
