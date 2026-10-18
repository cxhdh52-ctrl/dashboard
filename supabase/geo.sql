-- Run this once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- Geo (country code, e.g. US / GB) on Creative Library angles, so winners,
-- dead angles and Claude's variations stay within one offer + geo.
-- Null = not set (treated as matching any geo).

alter table creative_angles add column if not exists geo text;
