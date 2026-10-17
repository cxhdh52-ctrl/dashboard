// POST /.netlify/functions/creative-library   { action, ... }
//   "list"        {}                                   -> { angles, campaigns, ai_configured }
//   "add_angles"  { texts[], offer?, source?, parent_id? } -> { angles }  (duplicates by text are skipped)
//   "update_angle"{ id, patch: { text?, offer?, status?, notes? } } -> { angle }
//   "tag"         { angle_id | null, campaign_ids[] }  -> { tagged, backfill_errors }
//   "variations"  { password, angle_id | seed_texts[], count?, guidance?, offer? } -> { variations: [{ text, why }] }
//                 angle_id varies one library angle; seed_texts (Spark Maker) varies
//                 whatever is in the angles box, or writes fresh ones from the winners.
//   "feedback"    { angle_id, kept[], dropped[], offer? }   -> { angles }  (kept ones are saved as angles)
//
// Angle performance = every campaign tagged with that angle, summed:
//   spend / revenue up to the day before tagging (backfilled once, at tag
//   time, from TikTok's + Glitchy/Mabac's own reports) + campaign_daily rows
//   after that (written by every metrics cycle in tiktok-campaigns.js).
//
// "variations" calls Claude (ANTHROPIC_API_KEY) with the library as context:
// the source angle, the best and worst angles with their numbers, and which
// earlier suggestions were kept or dropped — that feedback is how it adapts
// to what works for this account. It is password-gated because every call
// costs API credit.

const {
  getSupabase,
  sbErr,
  checkPassword,
  resolveConfig,
  SupabaseOAuthProvider,
  connectMcp,
  dashboardToday,
  loadCampaignMetricsForAdvertiser,
  json,
} = require("./_shared/tiktok-mcp");
const { fetchGlitchy } = require("./_shared/glitchy-daily");
const { fetchMabacSubIdReport } = require("./_shared/mabac");

const ANGLE_COLS = "id, text, offer, status, parent_id, source, notes, created_at, updated_at";
const MAX_LOOKBACK_DAYS = 30;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const toNum = (v) => Number(v) || 0;
const missingTable = (err) => /does not exist|schema cache|could not find/i.test((err && err.message) || "");

function daysBefore(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function nyDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// Same buckets as the Tracker's result column (_shared/tracker.js resultFor),
// plus "testing" until there's enough spend to judge and "untested" when no
// campaign uses the angle yet.
function verdictFor(stats) {
  if (!stats.campaigns) return "untested";
  if (stats.spend < 10) return "testing";
  if (stats.roas < 0.8) return "dead";
  if (stats.roas < 1.5) return "break_even";
  return "winner";
}

function cleanOffer(v) {
  const s = String(v || "").trim().toUpperCase();
  return s ? s.slice(0, 40) : null;
}

function cleanText(v) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    body = {};
  }
  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return json(500, { error: err.message });
  }

  try {
    switch (body.action) {
      case "list":
        return json(200, await listLibrary(supabase));
      case "add_angles":
        return json(200, { angles: await addAngles(supabase, body) });
      case "update_angle":
        return updateAngle(supabase, body);
      case "tag":
        return json(200, await tagCampaigns(supabase, body));
      case "variations": {
        const pw = checkPassword(body.password);
        if (!pw.ok) return json(pw.code, { error: pw.error });
        return makeVariations(supabase, body);
      }
      case "feedback":
        return json(200, await saveFeedback(supabase, body));
      default:
        return json(400, { error: `Unknown action: ${body.action}` });
    }
  } catch (err) {
    if (missingTable(err)) return json(400, { error: "Run supabase/creative_library.sql in Supabase first.", code: "migration_required" });
    return json(500, { error: err.message || "Request failed" });
  }
};

// ---------------------------------------------------------------- reads

async function listLibrary(supabase) {
  const [anglesRes, tagsRes, campsRes] = await Promise.all([
    supabase.from("creative_angles").select(ANGLE_COLS).order("created_at", { ascending: false }),
    supabase.from("campaign_angles").select("*"),
    supabase
      .from("tiktok_campaigns")
      .select("campaign_id, campaign_name, advertiser_id, advertiser_name, effective_status, effective_tone, create_time, today_spend")
      .order("create_time", { ascending: false }),
  ]);
  if (anglesRes.error) throw anglesRes.error;
  if (tagsRes.error) throw tagsRes.error;
  if (campsRes.error) throw campsRes.error;

  // Campaigns that are throwaway (WH warmup) or locally hidden never belong in the library.
  const exclude = new Set();
  try {
    const { data: wh } = await supabase.from("wh_warmup_campaigns").select("campaign_id");
    for (const r of wh || []) exclude.add(String(r.campaign_id));
  } catch (_) {}

  const tags = tagsRes.data || [];
  const tagByCampaign = new Map(tags.map((t) => [String(t.campaign_id), t]));
  const daily = await readDaily(supabase, tags.map((t) => String(t.campaign_id)));

  // Per-campaign lifetime numbers (tagged campaigns only).
  const lifeByCampaign = new Map();
  for (const t of tags) {
    const cid = String(t.campaign_id);
    let spend = toNum(t.backfill_spend);
    let revenue = toNum(t.backfill_revenue);
    let conversions = toNum(t.backfill_conversions);
    for (const d of daily.get(cid) || []) {
      if (t.backfill_until && d.date <= t.backfill_until) continue;
      spend += toNum(d.spend);
      revenue += toNum(d.revenue);
      conversions += toNum(d.conversions);
    }
    lifeByCampaign.set(cid, { spend: round2(spend), revenue: round2(revenue), conversions });
  }

  const statsByAngle = new Map();
  for (const t of tags) {
    const life = lifeByCampaign.get(String(t.campaign_id));
    const s = statsByAngle.get(t.angle_id) || { campaigns: 0, spend: 0, revenue: 0, conversions: 0 };
    s.campaigns += 1;
    s.spend += life.spend;
    s.revenue += life.revenue;
    s.conversions += life.conversions;
    statsByAngle.set(t.angle_id, s);
  }

  const angles = (anglesRes.data || []).map((a) => {
    const s = statsByAngle.get(a.id) || { campaigns: 0, spend: 0, revenue: 0, conversions: 0 };
    const stats = {
      campaigns: s.campaigns,
      spend: round2(s.spend),
      revenue: round2(s.revenue),
      profit: round2(s.revenue - s.spend),
      roas: s.spend > 0 ? round2(s.revenue / s.spend) : 0,
      conversions: s.conversions,
    };
    return { ...a, stats, verdict: verdictFor(stats) };
  });

  const campaigns = (campsRes.data || [])
    .filter((c) => !exclude.has(String(c.campaign_id)))
    .map((c) => {
      const t = tagByCampaign.get(String(c.campaign_id));
      return {
        ...c,
        angle_id: t ? t.angle_id : null,
        life: lifeByCampaign.get(String(c.campaign_id)) || null,
      };
    });

  return { angles, campaigns, ai_configured: !!process.env.ANTHROPIC_API_KEY };
}

async function readDaily(supabase, campaignIds) {
  const out = new Map();
  if (!campaignIds.length) return out;
  for (let i = 0; i < campaignIds.length; i += 200) {
    const { data, error } = await supabase
      .from("campaign_daily")
      .select("campaign_id, date, spend, revenue, conversions")
      .in("campaign_id", campaignIds.slice(i, i + 200));
    if (error) throw error;
    for (const r of data || []) {
      const k = String(r.campaign_id);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------- angle writes

async function addAngles(supabase, body) {
  const seen = new Set();
  const texts = (Array.isArray(body.texts) ? body.texts : [])
    .map(cleanText)
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  if (!texts.length) return [];
  const { data: existing, error } = await supabase.from("creative_angles").select("id, text");
  if (error) throw error;
  const have = new Set((existing || []).map((a) => a.text.toLowerCase()));
  const now = new Date().toISOString();
  const rows = texts
    .filter((t) => !have.has(t.toLowerCase()))
    .map((text) => ({
      text,
      offer: cleanOffer(body.offer),
      source: ["manual", "variation", "spark_maker"].includes(body.source) ? body.source : "manual",
      parent_id: body.parent_id || null,
      created_at: now,
      updated_at: now,
    }));
  if (!rows.length) return [];
  const { data, error: insErr } = await supabase.from("creative_angles").insert(rows).select(ANGLE_COLS);
  if (!insErr) return data || [];
  if (!/duplicate|unique/i.test(insErr.message || "")) throw insErr;
  // Someone added one of these in the meantime — insert one by one, skipping dupes.
  const out = [];
  for (const row of rows) {
    const r = await supabase.from("creative_angles").insert(row).select(ANGLE_COLS);
    if (r.error && !/duplicate|unique/i.test(r.error.message || "")) throw r.error;
    if (r.data) out.push(...r.data);
  }
  return out;
}

async function updateAngle(supabase, body) {
  if (!body.id) return json(400, { error: "id is required" });
  const p = body.patch || {};
  const patch = { updated_at: new Date().toISOString() };
  if ("text" in p) {
    const t = cleanText(p.text);
    if (!t) return json(400, { error: "Angle text can't be empty" });
    patch.text = t;
  }
  if ("offer" in p) patch.offer = cleanOffer(p.offer);
  if ("status" in p) patch.status = p.status === "archived" ? "archived" : "active";
  if ("notes" in p) patch.notes = p.notes == null ? null : String(p.notes).slice(0, 2000);
  const { data, error } = await supabase.from("creative_angles").update(patch).eq("id", body.id).select(ANGLE_COLS).maybeSingle();
  if (error) {
    if (/duplicate|unique/i.test(error.message || "")) return json(400, { error: "Another angle already has that text." });
    throw error;
  }
  return json(200, { angle: data });
}

// ---------------------------------------------------------------- tagging + backfill

// Tags campaigns with an angle (angle_id null = untag). For a campaign that
// started before today, its spend/revenue up to yesterday is fetched once
// now, so the angle's numbers include its whole history; from today on,
// campaign_daily (metrics cycle) covers it.
async function tagCampaigns(supabase, body) {
  const ids = [...new Set((Array.isArray(body.campaign_ids) ? body.campaign_ids : []).map(String).filter(Boolean))];
  if (!ids.length) return { tagged: 0, backfill_errors: {} };

  if (!body.angle_id) {
    const { error } = await supabase.from("campaign_angles").delete().in("campaign_id", ids);
    if (error) throw error;
    return { tagged: 0, untagged: ids.length, backfill_errors: {} };
  }

  // Re-tagging an already-tagged campaign keeps its backfill — only the angle changes.
  const { data: existing, error: exErr } = await supabase.from("campaign_angles").select("campaign_id").in("campaign_id", ids);
  if (exErr) throw exErr;
  const already = new Set((existing || []).map((r) => String(r.campaign_id)));
  if (already.size) {
    const { error } = await supabase
      .from("campaign_angles")
      .update({ angle_id: body.angle_id, tagged_at: new Date().toISOString() })
      .in("campaign_id", [...already]);
    if (error) throw error;
  }
  const fresh = ids.filter((id) => !already.has(id));
  const { rows, errors } = await backfillRows(supabase, fresh, body.angle_id);
  if (rows.length) {
    const { error } = await supabase.from("campaign_angles").insert(rows);
    if (error) throw error;
  }
  return { tagged: already.size + rows.length, backfill_errors: errors };
}

async function backfillRows(supabase, campaignIds, angleId) {
  const today = dashboardToday();
  const yesterday = daysBefore(today, 1);
  const floor = daysBefore(today, MAX_LOOKBACK_DAYS);
  const nowIso = new Date().toISOString();
  const errors = {};
  if (!campaignIds.length) return { rows: [], errors };

  const { data: camps, error } = await supabase
    .from("tiktok_campaigns")
    .select("campaign_id, campaign_name, connection_id, advertiser_id, create_time, affiliate_network")
    .in("campaign_id", campaignIds);
  if (error) throw error;

  const rows = [];
  const needsHistory = [];
  for (const c of camps || []) {
    const start = nyDate(c.create_time) || floor;
    const base = { campaign_id: String(c.campaign_id), angle_id: angleId, tagged_at: nowIso, backfill_until: yesterday };
    if (start >= today) rows.push({ ...base, backfill_spend: 0, backfill_revenue: 0, backfill_conversions: 0 });
    else needsHistory.push({ c, start: start < floor ? floor : start, base });
  }
  if (!needsHistory.length) return { rows, errors };

  // Revenue by name per start date (one Glitchy/Mabac call per distinct start).
  const revenueByStart = {};
  const revenueFor = async (start) => {
    if (revenueByStart[start]) return revenueByStart[start];
    const r = { glitchy: {}, mabac: {} };
    if (process.env.GLITCHY_TOKEN) r.glitchy = (await fetchGlitchy(process.env.GLITCHY_TOKEN, start, yesterday)).bySource || {};
    try {
      const mb = await fetchMabacSubIdReport({ startDate: start, endDate: yesterday });
      for (const s of mb.sources || []) if (s && s.sub1) r.mabac[s.sub1] = s;
    } catch (_) {}
    return (revenueByStart[start] = r);
  };

  // TikTok spend: one MCP client per connection, one report per (advertiser, start).
  const byConn = new Map();
  for (const n of needsHistory) {
    if (!byConn.has(n.c.connection_id)) byConn.set(n.c.connection_id, []);
    byConn.get(n.c.connection_id).push(n);
  }
  const { serverUrl, redirectUrl } = resolveConfig();
  const deadline = Date.now() + 40000;
  for (const [connectionId, list] of byConn) {
    const { data: conn } = await supabase.from("tiktok_connections").select("*").eq("id", connectionId).maybeSingle();
    if (!conn) {
      for (const n of list) errors[n.c.campaign_id] = "connection not found";
      continue;
    }
    let client;
    try {
      ({ client } = await connectMcp({ provider: new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection: conn }), serverUrl }));
    } catch (err) {
      for (const n of list) errors[n.c.campaign_id] = err.message;
      continue;
    }
    const reportCache = {};
    try {
      for (const n of list) {
        if (Date.now() > deadline) {
          errors[n.c.campaign_id] = "timed out — history not counted";
          continue;
        }
        try {
          const key = `${n.c.advertiser_id}|${n.start}`;
          if (!reportCache[key]) {
            reportCache[key] = await loadCampaignMetricsForAdvertiser(client, String(n.c.advertiser_id), { date: yesterday, startDate: n.start });
          }
          const tk = reportCache[key][String(n.c.campaign_id)] || { spend: 0 };
          const rev = await revenueFor(n.start);
          const mabac = String(n.c.affiliate_network || "GLITCHY").toUpperCase() === "MABAC";
          const aff = mabac ? rev.mabac[n.c.campaign_name] : rev.glitchy[n.c.campaign_name];
          rows.push({
            ...n.base,
            backfill_spend: round2(tk.spend),
            backfill_revenue: round2(mabac ? toNum(aff?.revenue) : toNum(aff?.payout)),
            backfill_conversions: toNum(aff?.conversions),
          });
        } catch (err) {
          errors[n.c.campaign_id] = err.message;
        }
      }
    } finally {
      await client.close().catch(() => {});
    }
  }
  // Campaigns whose history couldn't be read are still tagged — counted from today on.
  for (const n of needsHistory) {
    if (errors[n.c.campaign_id]) rows.push({ ...n.base, backfill_spend: 0, backfill_revenue: 0, backfill_conversions: 0 });
  }
  return { rows, errors };
}

// ---------------------------------------------------------------- variations (Claude)

const SYSTEM_PROMPT = `You write hook text for TikTok Spark Ads: short lines burned onto the first slide of a photo slideshow (or the first frame of a video) that promote mobile app installs (CPI offers) for an affiliate advertiser.

You're given the source angle(s) to vary (or none, when asked for fresh angles), the account's own performance history (angles with spend, revenue and ROAS), and which of your earlier suggestions the user kept or dropped. Learn from it:
- Winners show the voice, structure, length and emotional triggers that convert for this account. Stay close to them.
- Dead angles show what to avoid.
- Kept suggestions are the user's taste; dropped ones are not. Lean toward what they keep.

Each variation must be a genuinely different take a viewer would notice (new situation, new character, new curiosity gap, new specific detail) while keeping the core idea of the source angle. Not synonyms or word swaps.

Write like native TikTok text: casual, specific, first-person or POV where that fits, no hashtags, no emojis unless the winners use them, usually under 90 characters. A "|" forces a line break if you need one.

Keep every line within TikTok's advertising policies, because rejected ads cost the account: no promises of guaranteed or specific income, no fake urgency or fake scarcity, no misleading claims about what the app does, nothing sexual, no personal-attribute targeting ("are you depressed?").`;

const VARIATIONS_TOOL = {
  name: "submit_variations",
  description: "Return the hook variations.",
  input_schema: {
    type: "object",
    properties: {
      variations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "The hook text exactly as it should appear on the slide." },
            why: { type: "string", description: "One short sentence: what's different and why it should work, citing the data when relevant." },
          },
          required: ["text", "why"],
        },
      },
    },
    required: ["variations"],
  },
};

function fmtAngle(a) {
  const s = a.stats;
  if (!s || !s.campaigns) return `- "${a.text}" (not run yet)`;
  return `- "${a.text}" — ${s.campaigns} campaign${s.campaigns === 1 ? "" : "s"}, $${s.spend} spend, $${s.revenue} revenue, ${s.roas}x ROAS (${a.verdict})`;
}

async function makeVariations(supabase, body) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(400, { error: "Add ANTHROPIC_API_KEY to the Vercel environment variables to use Make variations.", code: "ai_not_configured" });
  }
  const count = Math.max(3, Math.min(15, Number(body.count) || 8));
  const lib = await listLibrary(supabase);
  const seeds = (Array.isArray(body.seed_texts) ? body.seed_texts : []).map(cleanText).filter(Boolean).slice(0, 20);
  let source = null;
  if (body.angle_id) {
    source = lib.angles.find((a) => a.id === body.angle_id);
    if (!source) return json(404, { error: "Angle not found" });
  }
  const offer = source ? source.offer : body.offer || null;
  const seedSet = new Set(seeds.map((t) => t.toLowerCase()));

  const sameOffer = lib.angles.filter((a) => a.status !== "archived" && (!offer || !a.offer || a.offer === offer));
  const ran = sameOffer.filter(
    (a) => (!source || a.id !== source.id) && !seedSet.has(a.text.toLowerCase()) && a.stats.campaigns && a.stats.spend >= 10,
  );
  const winners = [...ran].sort((a, b) => b.stats.roas - a.stats.roas).filter((a) => a.verdict === "winner" || a.verdict === "break_even").slice(0, 15);
  const dead = ran.filter((a) => a.verdict === "dead").sort((a, b) => b.stats.spend - a.stats.spend).slice(0, 10);
  const children = source ? lib.angles.filter((a) => a.parent_id === source.id) : [];
  const seedAngles = seeds.map((t) => lib.angles.find((a) => a.text.toLowerCase() === t.toLowerCase()) || { text: t });
  const sourceBlock = source
    ? `Source angle to vary:\n${fmtAngle(source)}`
    : seedAngles.length
      ? `Source angles to vary (spread your variations across them; never repeat them):\n${seedAngles.map(fmtAngle).join("\n")}`
      : "No source angle: write brand-new angles in the style of this account's winners (or strong general TikTok hooks if there are none). Each must be a different idea.";

  const { data: fb } = await supabase
    .from("angle_feedback")
    .select("text, kept, created_at")
    .order("created_at", { ascending: false })
    .limit(60);
  const kept = (fb || []).filter((f) => f.kept).map((f) => `- "${f.text}"`);
  const dropped = (fb || []).filter((f) => !f.kept).map((f) => `- "${f.text}"`);

  const parts = [
    `Offer type: ${offer || "CPI app install"}`,
    sourceBlock,
    children.length ? `Variations of it already in the library (don't repeat these):\n${children.map(fmtAngle).join("\n")}` : "",
    winners.length ? `This account's best angles:\n${winners.map(fmtAngle).join("\n")}` : "No winning angles recorded yet — rely on the source angle and general TikTok hook craft.",
    dead.length ? `Angles that lost money:\n${dead.map(fmtAngle).join("\n")}` : "",
    kept.length ? `Suggestions the user kept before:\n${kept.slice(0, 25).join("\n")}` : "",
    dropped.length ? `Suggestions the user dropped before:\n${dropped.slice(0, 25).join("\n")}` : "",
    body.guidance ? `The user's direction for this batch: ${String(body.guidance).slice(0, 500)}` : "",
    `Write ${count} variations.`,
  ].filter(Boolean);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      tools: [VARIATIONS_TOOL],
      tool_choice: { type: "tool", name: VARIATIONS_TOOL.name },
      messages: [{ role: "user", content: parts.join("\n\n") }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Claude API error ${res.status}`;
    return json(502, { error: msg });
  }
  const block = (data.content || []).find((b) => b.type === "tool_use");
  const variations = ((block && block.input && block.input.variations) || [])
    .map((v) => ({ text: cleanText(v.text), why: String(v.why || "").slice(0, 300) }))
    .filter((v) => v.text);
  if (!variations.length) return json(502, { error: "Claude returned no variations — try again." });
  return json(200, { variations, model: CLAUDE_MODEL });
}

async function saveFeedback(supabase, body) {
  const kept = (Array.isArray(body.kept) ? body.kept : []).map(cleanText).filter(Boolean);
  const dropped = (Array.isArray(body.dropped) ? body.dropped : []).map(cleanText).filter(Boolean);
  const rows = [
    ...kept.map((text) => ({ angle_id: body.angle_id || null, text, kept: true })),
    ...dropped.map((text) => ({ angle_id: body.angle_id || null, text, kept: false })),
  ];
  if (rows.length) {
    const { error } = await supabase.from("angle_feedback").insert(rows);
    if (error) throw error;
  }
  const angles = kept.length
    ? await addAngles(supabase, { texts: kept, offer: body.offer, source: "variation", parent_id: body.angle_id || null })
    : [];
  return { angles };
}

// exported for tests
exports._internal = { verdictFor, fmtAngle };
