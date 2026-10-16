// WH Warmup — bulk Traffic-CBO warmup campaigns that auto-delete once Active.
//
// All TikTok writes go through the shared MCP client (server-side only). Reuses
// tiktok-mcp.js helpers; adds nothing to the normal campaign pipeline except a
// filter so WH campaign_ids never enter tiktok_campaigns.

const { mcpCall, loadCampaignDetail, deleteCampaign, setCampaignStatus } = require("./tiktok-mcp");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// TikTok does NOT expose the minimum CBO daily budget through the MCP. USD $50/day
// is TikTok's documented Campaign Budget Optimization campaign daily minimum.
// Override per deployment with WH_WARMUP_DAILY_BUDGET if any Approved account is
// not USD and TikTok rejects $50 for its currency.
function whDailyBudget(_currency) {
  const v = Number(process.env.WH_WARMUP_DAILY_BUDGET);
  return Number.isFinite(v) && v > 0 ? v : 50;
}

// USD $5/day account-level spend cap set on the AD ACCOUNT (not the campaign)
// before its warmup campaign is created — a hard ceiling on how much that
// account can spend in a day, independent of the campaign's own $50 CBO
// budget above. TikTok throttles delivery once an account hits its cap
// regardless of what any campaign underneath is nominally budgeted for, so
// this is what actually limits the damage if a warmup campaign is ever left
// running unpaused. Override with WH_WARMUP_ACCOUNT_CAP for a different value.
function whAccountSafetyCap() {
  const v = Number(process.env.WH_WARMUP_ACCOUNT_CAP);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

// ---------------------------------------------------------------------------
// Random generators
// ---------------------------------------------------------------------------

const rand4 = () => String(Math.floor(1000 + Math.random() * 9000));
function randSlug(n = 12) {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
// Destination URL base. The path is a random slug; the URL only needs to be
// syntactically valid. Override with WH_WARMUP_URL_BASE (e.g. https://www.etsy.com)
// if TikTok rejects the bare host.
function whUrlBase() {
  return String(process.env.WH_WARMUP_URL_BASE || "https://etsy.com").replace(/\/+$/, "");
}
function whNames() {
  return {
    campaign: `Traffic${rand4()}`,
    adgroup: `AG${rand4()}`,
    ad: `AD${rand4()}`,
    url: `${whUrlBase()}/${randSlug()}/`,
  };
}
// 64-bit-ish integer string — campaign_create / adgroup_create idempotency + dup names.
const reqId = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");

// "now - 3h" as a UTC "YYYY-MM-DD HH:MM:SS" string. "3 hours ago" is the same
// instant in every timezone, and TikTok documents that schedule_start_time may
// be up to 12h in the past — so the ad group is immediately in-schedule and
// starts delivering right away, which is the intended warmup behaviour.
function startTimeMinus3h() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}
function startTimeNow() {
  return new Date(Date.now() + 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

const norm = (s) => String(s || "").trim().toLowerCase();

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _isRateLimit = (msg) => /rate limit|too many request|429|qps|frequenc|please try again/i.test(String(msg || ""));

// mcpCall + backoff retry on TikTok's rate limiter. Only retries rate-limit
// errors; everything else throws immediately. Needed here because
// listAllCountryRegions below fires this same call once per advertiser in a row.
async function mcpCallThrottled(client, name, args, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await mcpCall(client, name, args);
    } catch (err) {
      lastErr = err;
      if (!_isRateLimit(err.message)) throw err;
      await _sleep(Math.min(1200 * 2 ** i, 6000) + Math.floor(Math.random() * 300));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Country -> TikTok location_id  (Traffic / Website / TikTok placement)
// ---------------------------------------------------------------------------

// Every country-level TikTok delivery location for this advertiser (Traffic /
// Website / TikTok placement). -> [{ location_id, name, code }] sorted by name.
// Used both by the WH settings-screen autocomplete and by resolveCountryLocationId.
async function listCountryRegions(client, advertiserId) {
  const d = await mcpCallThrottled(client, "tool_region_get", {
    advertiser_id: String(advertiserId),
    placements: ["PLACEMENT_TIKTOK"],
    objective_type: "TRAFFIC",
    promotion_type: "WEBSITE",
    level_range: "TO_COUNTRY",
  });

  const list = d?.region_info || d?.list || d?.locations || d?.region || [];
  const level = (r) => norm(r.level || r.location_level || "country");
  const countries = list.filter((r) => !r.level || /country|nation/.test(level(r)));
  const pool = countries.length ? countries : list;

  const out = [];
  const seen = new Set();
  for (const r of pool) {
    const id = String(r.location_id ?? r.region_id ?? r.id ?? "");
    const name = String(r.name || r.location_name || r.region_name || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      location_id: id,
      name,
      code: String(r.region_code || r.location_code || r.country_code || "").trim(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Union of country-level regions across MULTIPLE advertisers. TikTok gates
// newly-available countries (e.g. US) per AD ACCOUNT, not per Business Center —
// two accounts in the same BC can see very different country lists. Campaign
// Creator templates aren't tied to one ad account (you pick the account at
// launch time), so the template location picker must not be limited to
// whatever ONE account currently happens to be eligible for. This samples up
// to 8 approved advertisers and unions what each can see; a country only
// disappears here if none of them can target it. One account erroring never
// blocks the rest. `deadlineMs` (Date.now()-based) bails out early and returns
// whatever's been collected so far, so a slow/rate-limited sweep degrades to a
// partial list instead of timing out the whole request.
async function listAllCountryRegions(client, advertiserIds, { deadlineMs } = {}) {
  const ids = [...new Set((advertiserIds || []).map(String).filter(Boolean))].slice(0, 8);
  const byId = new Map();
  for (const advId of ids) {
    if (deadlineMs && Date.now() > deadlineMs) break;
    let list;
    try {
      list = await listCountryRegions(client, advId);
    } catch (_) {
      continue;
    }
    for (const c of list) if (!byId.has(c.location_id)) byId.set(c.location_id, c);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveCountryLocationId(client, advertiserId, countryName) {
  const q = norm(countryName);
  if (!q) throw new Error("No target country provided.");

  const pool = await listCountryRegions(client, advertiserId);
  const hit =
    pool.find((r) => norm(r.name) === q || norm(r.code) === q) ||
    pool.find((r) => norm(r.name).includes(q) || q.includes(norm(r.name)));
  if (!hit) throw new Error(`Could not resolve a TikTok location for "${countryName}".`);
  return { location_id: hit.location_id, name: hit.name };
}

// ---------------------------------------------------------------------------
// Spark auth code -> { item_id, identity_id } for this advertiser
// ---------------------------------------------------------------------------

// A safe fingerprint of the code — length + structural booleans only, NEVER the
// code itself — for server-side debugging in the function logs.
function sparkFingerprint(s) {
  const c = String(s || "");
  return `len=${c.length} hash=${c.startsWith("#")} plus=${c.includes("+")} pct2b=${/%2[bB]/.test(c)} eq=${c.endsWith("=")} ws=${/\s/.test(c)}`;
}

// The TikTok copied code is used EXACTLY as pasted. Only if a call rejects it as
// an "incorrect/invalid code" do we fall back to the alternatives TikTok's docs
// mention (`+` -> `%2B`, which some request paths require) and, last, dropping a
// leading `#`. Ordered most-faithful first.
function sparkCandidates(base) {
  const out = [];
  const add = (c) => {
    if (c && !out.includes(c)) out.push(c);
  };
  // If the user pasted a code that was already `%2B`-encoded (e.g. copied out of
  // a URL), the literal `+` is the faithful form — try that first.
  const decoded = /%2[bB]/.test(base) ? base.replace(/%2[bB]/g, "+") : base;
  add(decoded); // 1. exactly as pasted (or `%2B` decoded back to `+`)
  add(base); // 2. the raw paste, if it differed from (1)
  if (decoded.includes("+")) add(decoded.replace(/\+/g, "%2B")); // 3. documented `+` -> `%2B`
  if (decoded.startsWith("#")) {
    const noHash = decoded.slice(1);
    add(noHash); // 4. without a leading `#`
    if (noHash.includes("+")) add(noHash.replace(/\+/g, "%2B")); // 5. no `#` + `+` -> `%2B`
  }
  return out;
}

const SPARK_FORMAT_ERR = /incorrect|invalid|post code|auth[_ ]?code|not\s+valid/i;
// TikTok's MCP is enabling tt_video_authorize_apply per ad account ("This tool
// is currently being rolled out and will be available for this advertiser ID
// soon"). Until it reaches an account, codes can only be applied in Ads Manager.
const SPARK_ROLLOUT_ERR = /being rolled out|available for this advertiser|estimated date of availability/i;

// A structure-only description of an MCP response: key names + value *types*
// (and, for strings, only their length) — NEVER any value, so the Spark
// code / tokens / captions can't leak into the function logs.
function describeShape(v, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[${describeShape(v[0], depth + 1)}]x${v.length}`;
  }
  const t = typeof v;
  if (t !== "object") {
    if (t === "string") return `str(${v.length})`;
    return t; // number | boolean
  }
  if (depth >= 4) return "{…}";
  const parts = Object.keys(v)
    .slice(0, 40)
    .map((k) => `${k}:${describeShape(v[k], depth + 1)}`);
  return `{${parts.join(", ")}}`;
}

// A TikTok post/item id is a long all-digit string (currently 19 chars).
const looksLikeItemId = (s) => typeof s === "string" && /^\d{15,25}$/.test(s);

// Breadth-first walk: first primitive value whose KEY matches `keyRe` and whose
// value passes `ok` (default: any non-empty scalar). Used so we read whatever
// field the MCP server actually puts the item / identity id in.
function deepFindByKey(root, keyRe, ok) {
  const pass = ok || ((val) => (typeof val === "string" || typeof val === "number") && String(val).length > 0);
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < 5000) {
    const node = queue.shift();
    seen++;
    if (node == null || typeof node !== "object") continue;
    for (const [k, val] of Object.entries(node)) {
      if (keyRe.test(k) && pass(val, k)) return val;
      if (val && typeof val === "object") queue.push(val);
    }
  }
  return null;
}

async function resolveSparkCode(client, advertiserId, rawCode) {
  // Only trim surrounding whitespace/newlines from the copy — never touch #, +, =.
  const base = String(rawCode || "").trim();
  if (!base) throw new Error("No Spark code provided.");

  const candidates = sparkCandidates(base);
  console.log(`[wh-warmup] spark ${sparkFingerprint(base)} candidates=${candidates.length}`);

  // 1. Put the creator's authorization into effect — try each candidate form
  //    until one is accepted. Applying an already-applied authorization is fine,
  //    so retrying is safe.
  let workingCode = null;
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      await mcpCall(client, "tt_video_authorize_apply", {
        advertiser_id: String(advertiserId),
        auth_code: candidates[i],
      });
      workingCode = candidates[i];
      if (i > 0) console.log(`[wh-warmup] spark authorized with candidate #${i + 1}`);
      break;
    } catch (err) {
      lastErr = err;
      if (SPARK_ROLLOUT_ERR.test(err.message || "")) break; // -> already-authorized fallback below
      // A non-format error (network, permissions, quota, duet) -> stop, surface it.
      if (!SPARK_FORMAT_ERR.test(err.message || "")) throw err;
      console.warn(`[wh-warmup] spark candidate #${i + 1} rejected: ${err.message}`);
    }
  }
  // Apply isn't available on this ad account yet — the post can still be used
  // if the code was already applied to it in Ads Manager: info_get only reads.
  let info = null;
  if (!workingCode && SPARK_ROLLOUT_ERR.test(lastErr?.message || "")) {
    console.warn(`[wh-warmup] tt_video_authorize_apply not rolled out for adv=${advertiserId}; trying already-authorized lookup`);
    for (const c of candidates) {
      try {
        info = await mcpCall(client, "tt_video_info_get", { advertiser_id: String(advertiserId), auth_code: c });
        workingCode = c;
        break;
      } catch (err) {
        console.warn(`[wh-warmup] tt_video_info_get (no apply) failed: ${err.message}`);
      }
    }
    if (!workingCode) {
      throw new Error(
        `TikTok hasn't enabled Spark-code authorization through the API for ad account ${advertiserId} yet ` +
          `(TikTok says: available around December). Fix: open this ad account in TikTok Ads Manager → ` +
          `Tools → Creatives → Spark Ads posts → Apply for authorization, paste the code there once, then retry here. ` +
          `Or link the TikTok account to the Business Center and use "Pick from linked accounts" in the Campaign Creator instead of using a code.`
      );
    }
  }

  if (!workingCode) {
    throw new Error(
      `Spark authorization failed for every code format tried [${sparkFingerprint(base)}]. ` +
        `If the post is a duet/stitch it needs the original owner's code too. Last error: ${lastErr?.message || "unknown"}`
    );
  }

  // 2. Read the authorized post -> item_id (same code form that just worked).
  if (!info) {
    info = await mcpCall(client, "tt_video_info_get", {
      advertiser_id: String(advertiserId),
      auth_code: workingCode,
    });
  }
  console.log(`[wh-warmup] tt_video_info_get shape: ${describeShape(info)}`);

  // The MCP server may nest this under video_info / video_infos[] / data — take
  // whatever key ends in "item_id" and holds an id-shaped value, then fall back
  // to any long all-digit string anywhere in the response.
  // Don't mistake another 19-digit id (advertiser, BC, TT user, identity…) for
  // the post id in the broad fallback.
  const NOT_ITEM_ID = /(advertiser|bc|business_center|owner|creator|author|tt_user|user|identity|account|campaign|adgroup|ad)_id$/i;
  let itemId = String(
    deepFindByKey(info, /(^|_)item_id$/i, (v) => looksLikeItemId(String(v))) ||
      deepFindByKey(info, /(^|_)(tiktok_item_id|post_id)$/i, (v) => looksLikeItemId(String(v))) ||
      deepFindByKey(info, /_id$/i, (v, k) => looksLikeItemId(String(v)) && !NOT_ITEM_ID.test(k || "")) ||
      ""
  );

  // Fallback: the authorized post also shows up in the account's Spark posts list.
  if (!itemId) {
    try {
      const list = await mcpCall(client, "tt_video_list_get", {
        advertiser_id: String(advertiserId),
        page_size: 50,
      });
      console.log(`[wh-warmup] tt_video_list_get shape: ${describeShape(list)}`);
      const rows = list?.list || list?.videos || list?.video_list || (Array.isArray(list) ? list : []);
      const authVid = String(deepFindByKey(info, /(^|_)video_id$/i) || "");
      const hit =
        (authVid && rows.find((r) => String(deepFindByKey(r, /(^|_)video_id$/i) || "") === authVid)) ||
        rows[0];
      if (hit) itemId = String(deepFindByKey(hit, /(^|_)item_id$/i, (v) => looksLikeItemId(String(v))) || "");
    } catch (e) {
      console.warn(`[wh-warmup] tt_video_list_get fallback failed: ${e.message}`);
    }
  }

  if (!itemId) {
    throw new Error(
      `Spark code authorized but did not resolve to a post (no item_id). ` +
        `Response shape: ${describeShape(info)}`
    );
  }

  // 3. Identity: prefer one carried in the info response, else look it up.
  let identityId = String(deepFindByKey(info, /(^|_)identity_id$/i) || "");
  if (!identityId) {
    const creator = norm(
      deepFindByKey(info, /(^|_)(username|unique_id|display_name|nickname|author_name|profile_name)$/i) || ""
    );
    const ids = await mcpCall(client, "identity_get", {
      advertiser_id: String(advertiserId),
      identity_type: "AUTH_CODE",
      page_size: 100,
    });
    console.log(`[wh-warmup] identity_get(AUTH_CODE) shape: ${describeShape(ids)}`);
    const idList = ids?.identity_list || ids?.list || [];
    const match = creator
      ? idList.find((x) => norm(x.display_name) === creator || norm(x.identity_id) === creator || norm(x.profile_name) === creator)
      : null;
    identityId = String((match || idList[idList.length - 1] || {}).identity_id || "");
  }
  if (!identityId) throw new Error("Spark code authorized but no AUTH_CODE identity was found for the ad account.");

  // 4. Post type — a photo/carousel post must be delivered as CAROUSEL_ADS, a
  //    video post as SINGLE_VIDEO. Detect from the info response; ad_create also
  //    retries with the other format if this guess is wrong.
  const typeHint = String(
    deepFindByKey(info, /(item_type|content_type|media_type|post_type|material_type|video_type)$/i) || ""
  ).toUpperCase();
  let postType = "VIDEO";
  if (/CAROUSEL|PHOTO|IMAGE|SLIDE/.test(typeHint)) {
    postType = "CAROUSEL";
  } else if (!/VIDEO/.test(typeHint) && deepFindByKey(info, /(^|_)(photo_info|photo_list|photos|image_list|image_post_info|carousel)$/i)) {
    postType = "CAROUSEL";
  }
  console.log(`[wh-warmup] spark post type: ${postType} (hint="${typeHint}")`);

  return { item_id: itemId, identity_id: identityId, post_type: postType };
}

// ---------------------------------------------------------------------------
// Full create sequence for ONE advertiser. Throws on any failure; if a campaign
// was already created it is rolled back (best-effort) and the id is attached to
// the error as `.rolledBackCampaignId`.
// ---------------------------------------------------------------------------

async function createWarmupForAdvertiser({ client, advertiserId, currency, targetCountry, locationId, sparkCode, campaignName }) {
  const names = whNames();
  if (campaignName) names.campaign = campaignName; // wh1, wh2, … — see wh-warmup.js createBatch
  const budget = whDailyBudget(currency);

  // Read-only resolutions FIRST — a bad country/Spark code creates nothing.
  // The UI sends a location_id picked from this advertiser's own valid country
  // list; use it directly. Fall back to name resolution only if it wasn't sent.
  const loc = locationId
    ? { location_id: String(locationId), name: String(targetCountry || locationId) }
    : await resolveCountryLocationId(client, advertiserId, targetCountry);
  const spark = await resolveSparkCode(client, advertiserId, sparkCode);

  let campaignId = null;
  try {
    // 1. Campaign — Traffic, CBO ON, daily budget.
    const camp = await mcpCall(client, "campaign_create", {
      advertiser_id: String(advertiserId),
      objective_type: "TRAFFIC",
      campaign_name: names.campaign,
      budget_optimize_on: true,
      budget_mode: "BUDGET_MODE_DAY",
      budget,
      operation_status: "ENABLE",
      request_id: reqId(),
    });
    campaignId = String(camp?.campaign_id || "");
    if (!campaignId) throw new Error("campaign_create returned no campaign_id.");

    // 2. Ad group — TikTok only, Website, Click optimization, no-bid, starts 3h ago.
    const agBody = {
      advertiser_id: String(advertiserId),
      campaign_id: campaignId,
      adgroup_name: names.adgroup,
      promotion_type: "WEBSITE",
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
      location_ids: [loc.location_id],
      optimization_goal: "CLICK",
      billing_event: "CPC",
      bid_type: "BID_TYPE_NO_BID",
      pacing: "PACING_MODE_SMOOTH",
      budget_mode: "BUDGET_MODE_DAY", // ignored under CBO, still required by the endpoint
      budget, // ignored under CBO, still required
      schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: startTimeMinus3h(),
      operation_status: "ENABLE",
      request_id: reqId(),
    };
    let ag;
    let usedStart = agBody.schedule_start_time;
    try {
      ag = await mcpCall(client, "adgroup_create", agBody);
    } catch (err) {
      if (/schedul|start.?time|past|time.*earlier/i.test(err.message || "")) {
        agBody.schedule_start_time = startTimeNow();
        usedStart = agBody.schedule_start_time;
        ag = await mcpCall(client, "adgroup_create", agBody);
      } else {
        throw err;
      }
    }
    const adgroupId = String(ag?.adgroup_id || "");
    if (!adgroupId) throw new Error("adgroup_create returned no adgroup_id.");

    // 3. Spark ad — Learn More CTA, generated Etsy destination. A photo/carousel
    //    Spark post must use ad_format CAROUSEL_ADS; a video post SINGLE_VIDEO.
    //    Spark Ads Pull (AUTH_CODE + tiktok_item_id) needs no image_ids/music_id
    //    for either — the post carries its own content.
    const adCreative = (adFormat) => ({
      advertiser_id: String(advertiserId),
      adgroup_id: adgroupId,
      creatives: [
        {
          ad_name: names.ad,
          ad_format: adFormat,
          identity_type: "AUTH_CODE",
          identity_id: spark.identity_id,
          tiktok_item_id: spark.item_id,
          call_to_action: "LEARN_MORE",
          landing_page_url: names.url,
          operation_status: "ENABLE",
        },
      ],
    });
    const firstFormat = spark.post_type === "CAROUSEL" ? "CAROUSEL_ADS" : "SINGLE_VIDEO";
    const otherFormat = firstFormat === "CAROUSEL_ADS" ? "SINGLE_VIDEO" : "CAROUSEL_ADS";
    // TikTok's wording when the ad_format doesn't match the post's real type.
    const FORMAT_MISMATCH = /photo post|carousel ad|can be delivered|ad_format|single[_ ]video|video post|not a (photo|video)|must be a (photo|video)/i;
    let ad;
    try {
      ad = await mcpCall(client, "ad_create", adCreative(firstFormat));
    } catch (err) {
      if (!FORMAT_MISMATCH.test(err.message || "")) throw err;
      console.warn(`[wh-warmup] ad_create ${firstFormat} rejected (${err.message}) — retrying as ${otherFormat}`);
      try {
        ad = await mcpCall(client, "ad_create", adCreative(otherFormat));
      } catch (err2) {
        throw new Error(`ad_create failed as ${firstFormat} (${err.message}) and as ${otherFormat} (${err2.message})`);
      }
    }
    const adId = String((ad?.ad_ids || [])[0] || (ad?.creatives || [])[0]?.ad_id || "");

    return {
      campaign_id: campaignId,
      adgroup_id: adgroupId,
      ad_id: adId || null,
      campaign_name: names.campaign,
      destination_url: names.url,
      location_id: loc.location_id,
      target_country: targetCountry,
      spark_item_id: spark.item_id,
      daily_budget: budget,
      currency: currency || null,
      schedule_start_time: usedStart,
    };
  } catch (err) {
    if (campaignId) {
      try {
        await deleteCampaign({ client, advertiserId: String(advertiserId), campaignId });
      } catch (_) {
        /* leave the empty campaign; it has no ads so it will not spend */
      }
      err.rolledBackCampaignId = campaignId;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cleanup — check one WH campaign's live status. Once genuinely Active:
// PAUSE first, THEN delete — never the other way around. This is the money-
// safety guarantee: if delete never succeeds (TikTok error, retry cap,
// whatever), the campaign is still paused and cannot spend another cent.
// Pause itself is retried EVERY cycle with no cap and no give-up (re-issued
// even if already paused — harmless, and closes the door on anything that
// might have re-enabled it). Idempotent: DELETED / FAILED rows are terminal
// and never passed here. Returns { status, patch } — patch is written back.
// ---------------------------------------------------------------------------

const CLEANUP_ATTEMPT_CAP = 5;

async function cleanupOneWarmup({ client, row, advertiserStatus, timezone }) {
  const advId = String(row.advertiser_id);
  const campaignId = String(row.campaign_id);
  const now = new Date().toISOString();
  const deletedPatch = { cleanup_status: "DELETED", deleted_at: now, cleanup_error: null, updated_at: now };

  // 1. Does the campaign still exist, and is it already deleted on TikTok's side?
  try {
    const cr = await mcpCall(client, "campaign_get", {
      advertiser_id: advId,
      fields: ["campaign_id", "operation_status", "secondary_status"],
      filtering: { campaign_ids: [campaignId] },
    });
    const c = (cr?.list || []).find((x) => String(x.campaign_id) === campaignId);
    if (!c) return { status: "DELETED", patch: deletedPatch }; // gone
    if (/DELETE/i.test(String(c.secondary_status || c.operation_status || ""))) {
      return { status: "DELETED", patch: deletedPatch };
    }
  } catch (err) {
    if (/not exist|not found|no such|deleted/i.test(err.message || "")) {
      return { status: "DELETED", patch: deletedPatch };
    }
    return { status: row.cleanup_status, patch: { cleanup_error: err.message, updated_at: now } };
  }

  // 2. Derive the effective status to check for genuine "Active".
  let detail;
  try {
    detail = await loadCampaignDetail({
      client,
      advertiserId: advId,
      advertiserStatus,
      campaignId,
      timezone: timezone || null,
    });
  } catch (err) {
    if (/not exist|not found|no such|deleted/i.test(err.message || "")) {
      return { status: "DELETED", patch: deletedPatch };
    }
    return { status: row.cleanup_status, patch: { cleanup_error: err.message, updated_at: now } };
  }

  const label = String(detail.effective_status || "").toLowerCase();
  const advHealthyEarly = ["", "STATUS_ENABLE"].includes(String(advertiserStatus || "").toUpperCase());

  if (label === "deleted") return { status: "DELETED", patch: deletedPatch };

  if (label !== "active") {
    // The account is suspended/limited: the campaign can never go Active and we
    // can't delete it either — stop polling it.
    if (!advHealthyEarly || label.includes("suspend") || label.includes("punish")) {
      return {
        status: "FAILED",
        patch: {
          cleanup_status: "FAILED",
          cleanup_error: "Advertiser account is suspended — warmup campaign can neither go Active nor be deleted.",
          updated_at: now,
        },
      };
    }
    // In Review / Pending / Out of Budget … keep waiting, but give up after 3 days.
    const ageMs = Date.now() - Date.parse(row.created_at || now);
    if (ageMs > 3 * 24 * 3600 * 1000) {
      return {
        status: "FAILED",
        patch: {
          cleanup_status: "FAILED",
          cleanup_error: `Never reached Active after 3 days (last status: ${detail.effective_status}). Delete it manually in TikTok if needed.`,
          updated_at: now,
        },
      };
    }
    return { status: "WAITING_FOR_ACTIVE", patch: { updated_at: now } };
  }

  // It is genuinely Active. Step 1: PAUSE — retried every cycle, uncapped,
  // never skipped even if a previous cycle already paused it (idempotent on
  // TikTok's side, and re-asserting it every pass is exactly the guarantee
  // this exists for).
  const becameActivePatch = row.became_active_at ? {} : { became_active_at: now };
  try {
    await setCampaignStatus({ client, advertiserId: advId, campaignId, operationStatus: "DISABLE" });
  } catch (err) {
    return {
      status: "PAUSE_PENDING",
      patch: {
        cleanup_status: "PAUSE_PENDING",
        cleanup_error: `Pause failed, retrying every cycle: ${err.message || "unknown error"}`,
        updated_at: now,
        ...becameActivePatch,
      },
    };
  }

  // Step 2: now that it's paused (so it can't spend either way), delete it.
  // Unlike pause, this DOES eventually give up — that's fine, since the
  // account is already safe by this point.
  const patch = { cleanup_status: "DELETE_PENDING", updated_at: now, ...becameActivePatch };
  const advHealthy = advHealthyEarly;

  try {
    await deleteCampaign({ client, advertiserId: advId, campaignId });
    return { status: "DELETED", patch: { ...patch, cleanup_status: "DELETED", deleted_at: now, cleanup_error: null } };
  } catch (err) {
    const msg = err.message || "delete failed";
    // Already gone -> success.
    if (/not exist|not found|no such|already.*delet/i.test(msg)) {
      return { status: "DELETED", patch: { ...patch, cleanup_status: "DELETED", deleted_at: now, cleanup_error: null } };
    }
    const attempts = Number(row.cleanup_attempts || 0) + 1;
    const giveUp = !advHealthy || attempts >= CLEANUP_ATTEMPT_CAP;
    return {
      status: giveUp ? "FAILED" : "DELETE_PENDING",
      patch: {
        ...patch,
        cleanup_status: giveUp ? "FAILED" : "DELETE_PENDING",
        cleanup_attempts: attempts,
        cleanup_error: giveUp
          ? `Paused successfully, but delete permanently failed: ${msg} (${advHealthy ? `${attempts} attempts` : "advertiser account suspended"}). It is PAUSED and not spending — delete it manually in TikTok when convenient.`
          : `Paused; delete retry: ${msg}`,
      },
    };
  }
}

module.exports = {
  whDailyBudget,
  whAccountSafetyCap,
  whNames,
  listCountryRegions,
  listAllCountryRegions,
  resolveCountryLocationId,
  resolveSparkCode,
  createWarmupForAdvertiser,
  cleanupOneWarmup,
  CLEANUP_ATTEMPT_CAP,
};
