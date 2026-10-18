// POST /.netlify/functions/jarvis   { password, messages: [{ role, content }] }
//   -> { reply, tools_used: [name] }
//
// "Jarvis": a chat you ask what's going on ("how are we doing today", "which
// angles are winning", "what got auto-stopped overnight"). Claude answers from
// the dashboard's own Supabase data through READ-ONLY tools — no TikTok calls,
// nothing is changed. The metrics cron (supabase/metrics_cron.sql) keeps the
// numbers at most ~2 minutes old.
//
// Password-gated (each question costs Claude API credit). Model: JARVIS_MODEL,
// default a fast/cheap one since this is chat.

const { getSupabase, checkPassword, dashboardToday, json } = require("./_shared/tiktok-mcp");
const { listLibrary } = require("./creative-library");

const MODEL = process.env.JARVIS_MODEL || "claude-sonnet-5-5";
const MAX_ROUNDS = 6;
const DEADLINE_MS = 50000;
const MAX_TOOL_CHARS = 14000;
const TZ = "America/New_York";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

function nyNow() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date());
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function range(input, defaultDays = 0) {
  const today = dashboardToday();
  const to = isDate(input.to) ? input.to : isDate(input.date) ? input.date : today;
  const from = isDate(input.from) ? input.from : isDate(input.date) ? input.date : shiftDate(to, -defaultDays);
  return from <= to ? { from, to } : { from: to, to: from };
}

// Each query tolerates a missing table/column so one gap never kills an answer.
async function q(promise) {
  try {
    const { data, error } = await promise;
    if (error) return { rows: [], error: error.message };
    return { rows: data || [] };
  } catch (err) {
    return { rows: [], error: err.message };
  }
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: "overview",
    description:
      "Account-wide totals per NY day: TikTok spend, affiliate earnings, profit, ROAS. Defaults to today. For today it also returns the hourly cumulative earnings curve.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD (NY date), inclusive" },
        to: { type: "string", description: "YYYY-MM-DD (NY date), inclusive" },
      },
    },
  },
  {
    name: "campaigns",
    description:
      "Per-campaign spend / revenue / profit / ROAS / conversions summed over a NY date range (default today), with each campaign's current status, budget, account and auto-stop info. Use for 'which campaigns/creatives are winning', 'what is losing', 'how is adNN doing'.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        name_contains: { type: "string", description: "Filter by campaign name (case-insensitive substring), e.g. 'ad27'" },
        status: { type: "string", enum: ["any", "active", "paused", "problem"], description: "Current status filter. Default any." },
        sort: { type: "string", enum: ["profit", "loss", "spend", "revenue", "roas"], description: "Default profit (best first)." },
        limit: { type: "integer", description: "Default 25, max 60" },
      },
    },
  },
  {
    name: "angles",
    description:
      "Creative Library: each hook/angle with lifetime spend, revenue, profit, ROAS, number of campaigns and verdict (winner / break_even / dead / testing / untested).",
    input_schema: {
      type: "object",
      properties: {
        offer: { type: "string" },
        verdict: { type: "string", enum: ["any", "winner", "break_even", "dead", "testing", "untested"] },
        limit: { type: "integer", description: "Default 25" },
      },
    },
  },
  {
    name: "events",
    description:
      "What happened recently: auto-stops / scale decisions, ad rejections and appeal results, Campaign Creator duplication problems, WH warmup outcomes (went live, spent money, deleted, failed) and TikTok connections needing a reconnect.",
    input_schema: {
      type: "object",
      properties: { since_hours: { type: "number", description: "Look-back window in hours. Default 24, max 336." } },
    },
  },
  {
    name: "accounts",
    description:
      "Ad accounts: name, BC, TikTok status (active/limited/suspended), whether it is warmed up (a WH reached Active), whether US targeting is available, and whether it has a live campaign.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["all", "warmed", "not_warmed", "us_available", "suspended"], description: "Default all" },
      },
    },
  },
  {
    name: "tracker",
    description: "The Tracker: daily test results per campaign (hook, type, spend, CPA, ROAS, result) and the saved winners list.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
    },
  },
];

async function toolOverview(supabase, input) {
  const { from, to } = range(input, 0);
  const days = await q(supabase.from("daily_totals").select("date, total_spend, total_earnings, updated_at").gte("date", from).lte("date", to).order("date"));
  const rows = days.rows.map((d) => {
    const spend = round2(d.total_spend);
    const earnings = round2(d.total_earnings);
    return { date: d.date, spend, earnings, profit: round2(earnings - spend), roas: spend > 0 ? round2(earnings / spend) : null };
  });
  const sum = rows.reduce((a, r) => ({ spend: a.spend + r.spend, earnings: a.earnings + r.earnings }), { spend: 0, earnings: 0 });
  const out = {
    range: { from, to },
    days: rows,
    total: { spend: round2(sum.spend), earnings: round2(sum.earnings), profit: round2(sum.earnings - sum.spend), roas: sum.spend > 0 ? round2(sum.earnings / sum.spend) : null },
    note: rows.length ? undefined : "No daily_totals rows in this range.",
    error: days.error,
  };
  const today = dashboardToday();
  if (to === today) {
    const snaps = await q(supabase.from("earnings_snapshots").select("hour, cumulative_earnings").eq("date", today).order("hour"));
    out.today_hourly_cumulative_earnings = snaps.rows.map((s) => ({ hour_ny: s.hour, earnings: round2(s.cumulative_earnings) }));
  }
  return out;
}

function statusBucket(c) {
  const op = String(c.campaign_operation_status || "").toUpperCase();
  const tone = String(c.effective_tone || "");
  if (tone === "bad") return "problem";
  if (op === "ENABLE") return "active";
  return "paused";
}

async function toolCampaigns(supabase, input) {
  const { from, to } = range(input, 0);
  const [campsRes, dailyRes] = await Promise.all([
    q(supabase.from("tiktok_campaigns").select("*").eq("hidden", false)),
    q(supabase.from("campaign_daily").select("campaign_id, date, spend, revenue, conversions").gte("date", from).lte("date", to)),
  ]);
  const sums = new Map();
  for (const d of dailyRes.rows) {
    const s = sums.get(d.campaign_id) || { spend: 0, revenue: 0, conversions: 0 };
    s.spend += num(d.spend);
    s.revenue += num(d.revenue);
    s.conversions += num(d.conversions);
    sums.set(d.campaign_id, s);
  }
  const needle = String(input.name_contains || "").toLowerCase();
  const want = input.status && input.status !== "any" ? input.status : null;
  let rows = campsRes.rows
    .filter((c) => !needle || String(c.campaign_name || "").toLowerCase().includes(needle))
    .map((c) => {
      const s = sums.get(c.campaign_id) || { spend: 0, revenue: 0, conversions: 0 };
      return {
        name: c.campaign_name,
        campaign_id: c.campaign_id,
        account: c.advertiser_name || c.advertiser_id,
        status: c.effective_status || c.campaign_operation_status,
        status_bucket: statusBucket(c),
        status_detail: c.status_detail || undefined,
        budget: c.budget != null ? round2(c.budget) : undefined,
        spend: round2(s.spend),
        revenue: round2(s.revenue),
        profit: round2(s.revenue - s.spend),
        roas: s.spend > 0 ? round2(s.revenue / s.spend) : null,
        conversions: round2(s.conversions),
        lifetime_profit: c.lifetime_profit != null ? round2(c.lifetime_profit) : undefined,
        auto_stopped_at: c.auto_stopped_at || undefined,
        auto_stop_reason: c.auto_stop_reason || undefined,
        created: c.create_time || undefined,
      };
    })
    .filter((r) => !want || r.status_bucket === want);
  // Without a name filter, campaigns with no spend in the range are just noise.
  if (!needle) rows = rows.filter((r) => r.spend > 0 || r.revenue > 0 || r.status_bucket === "active");
  const sort = input.sort || "profit";
  const key = { profit: (r) => -r.profit, loss: (r) => r.profit, spend: (r) => -r.spend, revenue: (r) => -r.revenue, roas: (r) => -(r.roas || 0) }[sort];
  rows.sort((a, b) => key(a) - key(b));
  const limit = Math.max(1, Math.min(60, Number(input.limit) || 25));
  return {
    range: { from, to },
    matched: rows.length,
    campaigns: rows.slice(0, limit),
    note: "revenue = affiliate payout matched to the campaign by name (Glitchy/Mabac). Today's numbers update every ~2 minutes.",
    errors: [campsRes.error, dailyRes.error].filter(Boolean),
  };
}

async function toolAngles(supabase, input) {
  const lib = await listLibrary(supabase);
  let angles = lib.angles.filter((a) => a.status !== "archived");
  if (input.offer) angles = angles.filter((a) => String(a.offer || "").toLowerCase() === String(input.offer).toLowerCase());
  if (input.verdict && input.verdict !== "any") angles = angles.filter((a) => a.verdict === input.verdict);
  angles.sort((a, b) => (b.stats?.spend || 0) - (a.stats?.spend || 0));
  const limit = Math.max(1, Math.min(60, Number(input.limit) || 25));
  return {
    total: angles.length,
    angles: angles.slice(0, limit).map((a) => ({ text: a.text, offer: a.offer || undefined, verdict: a.verdict, ...(a.stats || {}) })),
  };
}

async function toolEvents(supabase, input) {
  const hours = Math.max(1, Math.min(336, Number(input.since_hours) || 24));
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const [scale, cc, wh, conns] = await Promise.all([
    q(supabase.from("testing_scale_events").select("campaign_name, ts, from_state, to_state, reason, spend_at_decision, payout_at_decision").gte("ts", since).order("ts", { ascending: false }).limit(60)),
    q(supabase.from("campaign_creator_campaigns").select("campaign_name, advertiser_id, dupe_status, dupe_error, appeal_state, appeal_error, appeal_raw_reasons, updated_at").gte("updated_at", since).order("updated_at", { ascending: false }).limit(60)),
    q(supabase.from("wh_warmup_campaigns").select("advertiser_name, advertiser_id, campaign_name, cleanup_status, last_status, spend, cleanup_error, became_active_at, updated_at").gte("updated_at", since).order("updated_at", { ascending: false }).limit(60)),
    q(supabase.from("tiktok_connections").select("label, tiktok_display_name, status, updated_at").neq("status", "active")),
  ]);
  return {
    since_hours: hours,
    auto_stop_and_scale_events: scale.rows,
    campaign_creator: cc.rows.map((r) => ({
      name: r.campaign_name,
      duplication: r.dupe_status,
      duplication_error: r.dupe_error || undefined,
      appeal: r.appeal_state && r.appeal_state !== "NONE" ? r.appeal_state : undefined,
      appeal_error: r.appeal_error || undefined,
      reject_reasons: r.appeal_raw_reasons || undefined,
      updated_at: r.updated_at,
    })),
    wh_warmups: wh.rows.map((r) => ({
      account: r.advertiser_name || r.advertiser_id,
      cleanup: r.cleanup_status,
      tiktok_status: r.last_status || undefined,
      spend: r.spend != null ? round2(r.spend) : undefined,
      error: r.cleanup_error || undefined,
      became_active_at: r.became_active_at || undefined,
      updated_at: r.updated_at,
    })),
    connections_needing_attention: conns.rows,
    errors: [scale.error, cc.error, wh.error, conns.error].filter(Boolean),
  };
}

async function toolAccounts(supabase, input) {
  const [advs, wh, us, camps] = await Promise.all([
    q(supabase.from("tiktok_advertisers").select("advertiser_id, advertiser_name, bc_name, status, country")),
    q(supabase.from("wh_warmup_campaigns").select("advertiser_id, became_active_at").not("became_active_at", "is", null)),
    q(supabase.from("app_settings").select("value").eq("key", "us_availability").maybeSingle().then((r) => ({ ...r, data: r.data ? [r.data] : [] }))),
    q(supabase.from("tiktok_campaigns").select("advertiser_id, campaign_operation_status, hidden").eq("hidden", false)),
  ]);
  const warmed = new Set(wh.rows.map((r) => r.advertiser_id));
  const usMap = (us.rows[0] && us.rows[0].value) || {};
  const live = new Set(camps.rows.filter((c) => String(c.campaign_operation_status).toUpperCase() === "ENABLE").map((c) => c.advertiser_id));
  let rows = advs.rows.map((a) => ({
    account: a.advertiser_name || a.advertiser_id,
    advertiser_id: a.advertiser_id,
    bc: a.bc_name || undefined,
    tiktok_status: a.status,
    suspended: /LIMIT|DISABLE|PUNISH|DELETE/i.test(String(a.status || "")),
    warmed_up: warmed.has(a.advertiser_id),
    us_available: usMap[a.advertiser_id] ? !!usMap[a.advertiser_id].us : "unknown",
    has_live_campaign: live.has(a.advertiser_id),
  }));
  const f = input.filter || "all";
  if (f === "warmed") rows = rows.filter((r) => r.warmed_up);
  if (f === "not_warmed") rows = rows.filter((r) => !r.warmed_up && !r.suspended);
  if (f === "us_available") rows = rows.filter((r) => r.us_available === true);
  if (f === "suspended") rows = rows.filter((r) => r.suspended);
  return {
    count: rows.length,
    summary: {
      total: advs.rows.length,
      warmed: rows.filter((r) => r.warmed_up).length,
      us_available: rows.filter((r) => r.us_available === true).length,
      suspended: rows.filter((r) => r.suspended).length,
    },
    accounts: rows.slice(0, 120),
    errors: [advs.error, wh.error, us.error, camps.error].filter(Boolean),
  };
}

async function toolTracker(supabase, input) {
  const { from, to } = range(input, 6);
  const [tests, winners] = await Promise.all([
    q(supabase.from("tracker_tests").select("sn, offer, type, hook, spend, cpa, cpnc, epc, roas, result, notes, test_date").gte("test_date", from).lte("test_date", to).order("test_date", { ascending: false }).limit(80)),
    q(supabase.from("tracker_winners").select("offer, type, hook, total_spend, total_revenue, notes").limit(40)),
  ]);
  return { range: { from, to }, tests: tests.rows, winners: winners.rows, errors: [tests.error, winners.error].filter(Boolean) };
}

const HANDLERS = {
  overview: toolOverview,
  campaigns: toolCampaigns,
  angles: toolAngles,
  events: toolEvents,
  accounts: toolAccounts,
  tracker: toolTracker,
};

async function runTool(supabase, name, input) {
  const fn = HANDLERS[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try {
    return await fn(supabase, input || {});
  } catch (err) {
    return { error: err.message };
  }
}

function clip(obj) {
  const s = JSON.stringify(obj);
  return s.length > MAX_TOOL_CHARS ? `${s.slice(0, MAX_TOOL_CHARS)}… (truncated — narrow the query)` : s;
}

// ---------------------------------------------------------------- chat

function systemPrompt() {
  return `You are Jarvis, the assistant inside Kryzxr Ads — a dashboard for running TikTok Spark Ads that promote affiliate CPI app-install offers. The user asks how things are going; you answer from the dashboard's data using your tools.

Now: ${nyNow()} (America/New_York). Today's NY date is ${dashboardToday()}. All dates in the data are NY dates; "today", "yesterday", "this week" mean NY dates.

Glossary: spend = TikTok ad spend. revenue/earnings = affiliate payout (Glitchy/Mabac). profit = revenue − spend. ROAS = revenue ÷ spend. Campaign names like "ad27" are the user's own. WH = a warmup campaign used to warm up a new ad account; it's auto-deleted once it goes live. Auto-stop pauses a campaign once its profit since launch drops $10 below its baseline. An "angle" is the hook text on the first slide.

Rules:
- Always call tools for numbers. Never invent or estimate figures; if data is missing or a tool returned an error, say so plainly.
- Lead with the answer. Be short and scannable: a one-line headline, then a few bullets or a small table. Dollar amounts with $ and 2 decimals.
- When something needs the user's attention (losing campaigns still running, rejections, expired connections, a WH that spent money), point it out.
- You can only read data. If asked to change something (pause, launch, edit), say which dashboard screen does it.`;
}

function cleanMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt(), tools: TOOLS, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `Claude API error ${res.status}`);
  return data;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {}
  const pw = checkPassword(body.password);
  if (!pw.ok) return json(pw.code, { error: pw.error });
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(400, { error: "Add ANTHROPIC_API_KEY to the Vercel environment variables to use Jarvis.", code: "ai_not_configured" });
  }
  const history = cleanMessages(body.messages);
  if (!history.length || history[history.length - 1].role !== "user") return json(400, { error: "Ask a question." });

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return json(500, { error: err.message });
  }

  const started = Date.now();
  const messages = [...history];
  const used = [];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const data = await callClaude(messages);
      const content = data.content || [];
      const calls = content.filter((b) => b.type === "tool_use");
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (data.stop_reason !== "tool_use" || !calls.length) {
        return json(200, { reply: text || "(no answer)", tools_used: used, model: MODEL });
      }
      if (Date.now() - started > DEADLINE_MS) {
        return json(200, { reply: text || "That took too long to look up — try a narrower question.", tools_used: used, model: MODEL });
      }
      messages.push({ role: "assistant", content });
      const results = await Promise.all(
        calls.map(async (c) => {
          used.push(c.name);
          return { type: "tool_result", tool_use_id: c.id, content: clip(await runTool(supabase, c.name, c.input)) };
        }),
      );
      messages.push({ role: "user", content: results });
    }
    return json(200, { reply: "I needed too many lookups for that — try asking something narrower.", tools_used: used, model: MODEL });
  } catch (err) {
    return json(502, { error: err.message });
  }
};

exports._internal = { TOOLS, runTool };
