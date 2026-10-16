// Auto-stop: pauses a campaign once its profit since launch (affiliate payout
// minus TikTok spend) drops to $THRESHOLD below its baseline. Anything still
// profitable keeps running — there's no ROAS cut-off.
//
// Runs inside the same "metrics" cycle as applyAutoBudgetBumps
// (tiktok-campaigns.js), reusing that cycle's connected MCP client and today's
// already-fetched spend. Lifetime numbers are NOT accumulated across polls
// (that loses data whenever the dashboard is closed) — they're read straight
// from TikTok's and Glitchy/Mabac's own reports for create-date..today, and
// only for "candidates": enabled campaigns that are losing money TODAY. A
// campaign at or above break-even today is never paused, whatever its history.
//
// Baseline: 0 by default (pause at -$10). If you turn an auto-stopped
// campaign back on, the baseline becomes its profit at that moment, so it
// gets another $10 of rope instead of being paused again on the next poll
// (see set_campaign_status in tiktok-campaigns.js).
//
// Gated on the auto_stop.sql migration: without the auto_stop_baseline column
// there's nowhere to remember a manual re-enable, so nothing is paused.

const { setCampaignStatus, loadCampaignMetricsForAdvertiser } = require("./tiktok-mcp");
const { fetchGlitchy } = require("./glitchy-daily");
const { fetchMabacSubIdReport } = require("./mabac");

const DEFAULT_SETTINGS = { enabled: true, threshold: 10 };
const MAX_LOOKBACK_DAYS = 30; // TikTok report date-range ceiling we rely on
const MAX_CHECKS_PER_ADVERTISER = 20; // keeps one cycle inside the function deadline

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const toNum = (v) => Number(v) || 0;

function nyDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function daysBefore(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

async function readAutoStopSettings(supabase) {
  try {
    const { data, error } = await supabase.from("app_settings").select("value").eq("key", "auto_stop").maybeSingle();
    if (error || !data || !data.value) return { ...DEFAULT_SETTINGS };
    return {
      enabled: data.value.enabled !== false,
      threshold: toNum(data.value.threshold) > 0 ? toNum(data.value.threshold) : DEFAULT_SETTINGS.threshold,
    };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeAutoStopSettings(supabase, patch) {
  const cur = await readAutoStopSettings(supabase);
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
    threshold: toNum(patch.threshold) > 0 ? round2(patch.threshold) : cur.threshold,
  };
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "auto_stop", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return next;
}

// Today's affiliate payout for one campaign, same network rule as the
// dashboard (Mabac by sub1, otherwise Glitchy by source).
function payoutFor(k, earnings) {
  const network = String(k.affiliate_network || "GLITCHY").toUpperCase();
  return network === "MABAC"
    ? toNum(earnings.mabacBySub1[k.campaign_name]?.revenue)
    : toNum(earnings.glitchyBySource[k.campaign_name]?.payout);
}

// Revenue by campaign name for start..today. Cached per start date for the
// whole cycle (shared across advertisers).
async function revenueSince(cache, start, today) {
  if (!cache.revenue[start]) {
    cache.revenue[start] = (async () => {
      const out = { glitchyBySource: {}, mabacBySub1: {}, ok: true };
      const token = process.env.GLITCHY_TOKEN;
      if (token) {
        try {
          out.glitchyBySource = (await fetchGlitchy(token, start, today)).bySource || {};
        } catch (_) {
          out.ok = false; // unknown revenue — never pause on a guess
        }
      }
      try {
        const mb = await fetchMabacSubIdReport({ startDate: start, endDate: today });
        for (const s of mb.sources || []) if (s && s.sub1) out.mabacBySub1[s.sub1] = s;
      } catch (_) {
        /* Mabac is optional; Glitchy-network campaigns are unaffected */
      }
      return out;
    })();
  }
  return cache.revenue[start];
}

// One account-wide Glitchy/Mabac fetch for today, by campaign name — called
// ONCE per metrics cycle and shared by every advertiser.
async function fetchEarningsToday(date) {
  const out = { glitchyBySource: {}, mabacBySub1: {}, errors: {} };
  const token = process.env.GLITCHY_TOKEN;
  if (token) {
    try {
      out.glitchyBySource = (await fetchGlitchy(token, date, date)).bySource || {};
    } catch (err) {
      out.errors.glitchy = err.message;
    }
  }
  try {
    const mb = await fetchMabacSubIdReport({ startDate: date, endDate: date });
    for (const s of mb.sources || []) if (s && s.sub1) out.mabacBySub1[s.sub1] = s;
  } catch (err) {
    out.errors.mabac = err.message; // optional network — never fatal
  }
  return out;
}

// Returns { rows, stopped }:
//   rows    -> fold into the cycle's tiktok_campaigns upsert (lifetime_* for
//              every campaign checked, plus pause fields for stopped ones)
//   stopped -> one entry per campaign paused this cycle (for the event log)
async function applyAutoStop({ client, advertiserId, byId, knownById, whIds, strayIds, earnings, today, settings, cache, nowIso }) {
  const rows = [];
  const stopped = [];
  if (!settings.enabled) return { rows, stopped };

  const candidates = [];
  for (const [cid, m] of Object.entries(byId)) {
    const k = knownById.get(cid);
    if (!k || whIds.has(cid) || (strayIds && strayIds.has(cid))) continue;
    if (!("auto_stop_baseline" in k)) continue; // migration not run
    if (String(k.campaign_operation_status || "").toUpperCase() !== "ENABLE") continue;
    const spend = toNum(m.spend);
    const todayProfit = payoutFor(k, earnings) - spend;
    if (k.auto_stopped_at) {
      // Auto-stopped, but it's running again — someone turned it back on
      // outside the dashboard (TikTok Ads Manager). Same as the dashboard's
      // re-enable: its last known profit becomes the new baseline.
      rows.push({
        campaign_id: cid,
        auto_stop_baseline: round2(toNum(k.lifetime_profit)),
        auto_stopped_at: null,
        auto_stop_reason: null,
      });
      continue;
    }
    if (spend <= 0) continue;
    if (todayProfit >= 0) continue; // break-even or better today — leave it alone
    candidates.push({ cid, k, todayProfit });
  }
  if (!candidates.length) return { rows, stopped };

  const floor = daysBefore(today, MAX_LOOKBACK_DAYS - 1);
  const spendByStart = {}; // start date -> { campaign_id: spend } for THIS advertiser

  for (const c of candidates.slice(0, MAX_CHECKS_PER_ADVERTISER)) {
    const created = nyDate(c.k.create_time) || floor;
    const start = created < floor ? floor : created;

    let profit;
    if (start >= today) {
      profit = c.todayProfit;
    } else {
      try {
        if (!spendByStart[start]) {
          const r = await loadCampaignMetricsForAdvertiser(client, advertiserId, { date: today, startDate: start });
          spendByStart[start] = Object.fromEntries(Object.entries(r).map(([id, v]) => [id, toNum(v.spend)]));
        }
        const rev = await revenueSince(cache, start, today);
        if (!rev.ok) continue;
        profit = payoutFor(c.k, rev) - toNum(spendByStart[start][c.cid]);
      } catch (err) {
        console.error(`[auto-stop] lifetime read failed adv=${advertiserId} campaign=${c.cid}: ${err.message}`);
        continue;
      }
    }
    profit = round2(profit);

    const baseline = toNum(c.k.auto_stop_baseline);
    const limit = round2(baseline - settings.threshold);
    const row = { campaign_id: c.cid, lifetime_profit: profit, lifetime_checked_at: nowIso };

    if (profit <= limit) {
      try {
        await setCampaignStatus({ client, advertiserId, campaignId: c.cid, operationStatus: "DISABLE" });
      } catch (err) {
        console.error(`[auto-stop] pause failed campaign=${c.cid}: ${err.message}`);
        rows.push(row);
        continue;
      }
      const reason = `Auto-stopped: $${profit.toFixed(2)} profit since launch (limit $${limit.toFixed(2)})`;
      Object.assign(row, {
        campaign_operation_status: "DISABLE",
        effective_status: "Paused",
        effective_tone: "neutral",
        status_detail: reason,
        auto_stopped_at: nowIso,
        auto_stop_reason: reason,
      });
      stopped.push({
        campaign_id: c.cid,
        campaign_name: c.k.campaign_name,
        connection_id: c.k.connection_id,
        advertiser_id: c.k.advertiser_id,
        ts: nowIso,
        from_state: "running",
        to_state: "auto_stopped",
        reason,
        spend_at_decision: 0,
        payout_at_decision: 0,
        conversions_at_decision: 0,
        roas_at_decision: 0,
      });
    }
    rows.push(row);
  }
  return { rows, stopped };
}

module.exports = { fetchEarningsToday, applyAutoStop, readAutoStopSettings, writeAutoStopSettings, DEFAULT_SETTINGS };
