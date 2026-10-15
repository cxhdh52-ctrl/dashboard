// GET  /.netlify/functions/tiktok-connections
//        -> { connections: [...], advertisers: [...] }   (never includes tokens)
//
// POST /.netlify/functions/tiktok-connections   { action, ... }
//        action "track"      : { selections: [{ connection_id, advertiser_id, tracked }] }  (no password)
//        action "refresh"    : { connection_id }   -> re-scan one connection's advertisers  (no password)
//        action "disconnect" : { password, connection_id }   -> forget the connection       (PASSWORD)
//
// Only "disconnect" needs the admin password. "track" / "refresh" work directly
// once a TikTok connection is authenticated.

const {
  getSupabase,
  sbErr,
  resolveConfig,
  checkPassword,
  SupabaseOAuthProvider,
  connectMcp,
  discoverAndStoreAdvertisers,
  json,
} = require("./_shared/tiktok-mcp");

const CONNECTION_COLUMNS_BASE =
  "id, label, tiktok_email, tiktok_display_name, status, last_verified_at, created_at";
const CONNECTION_COLUMNS = `${CONNECTION_COLUMNS_BASE}, bc_id, bc_name, bc_count, affiliate_network`;

// Reads connections, gracefully degrading if the bc_* / affiliate_network
// columns haven't been added yet (migration supabase/tiktok_bc_networks.sql).
async function readConnections(supabase) {
  let res = await supabase.from("tiktok_connections").select(CONNECTION_COLUMNS).order("created_at", { ascending: true });
  if (res.error && /bc_(id|name|count)|affiliate_network/.test(res.error.message || "")) {
    res = await supabase.from("tiktok_connections").select(CONNECTION_COLUMNS_BASE).order("created_at", { ascending: true });
    if (!res.error)
      res.data = (res.data || []).map((c) => ({
        ...c,
        bc_id: null,
        bc_name: null,
        bc_count: 0,
        affiliate_network: "GLITCHY",
      }));
  }
  return res;
}

const ADVERTISER_COLUMNS =
  "connection_id, advertiser_id, advertiser_name, bc_id, bc_name, currency, timezone, display_timezone, status, role, country, tracked, updated_at";
const ADVERTISER_COLUMNS_ORDERED = `${ADVERTISER_COLUMNS}, list_order`;

// Ordered by list_order (the position TikTok's own auth_advertiser_get
// returned it in — the closest available proxy for "BC order"), nulls last,
// alphabetical as the tiebreak. Falls back to plain alphabetical if
// supabase/tiktok_advertiser_order.sql hasn't been run yet.
async function readAdvertisers(supabase) {
  let res = await supabase
    .from("tiktok_advertisers")
    .select(ADVERTISER_COLUMNS_ORDERED)
    .order("list_order", { ascending: true, nullsFirst: false })
    .order("advertiser_name", { ascending: true });
  if (res.error && /list_order/.test(res.error.message || "")) {
    res = await supabase.from("tiktok_advertisers").select(ADVERTISER_COLUMNS).order("advertiser_name", { ascending: true });
  }
  return res;
}

exports.handler = async function (event) {
  try {
    const supabase = getSupabase();

    // ---- read-only diagnostic: every tool the TikTok MCP server exposes
    // (GET ?tools=1). Uses the most recently refreshed active connection. ----
    if (event.httpMethod === "GET" && (event.queryStringParameters || {}).tools) {
      const { data: connection } = await supabase
        .from("tiktok_connections")
        .select("*")
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!connection) return json(404, { error: "No active TikTok connection." });
      const { serverUrl, redirectUrl } = resolveConfig();
      const provider = new SupabaseOAuthProvider({ supabase, serverUrl, redirectUrl, connection });
      const { client } = await connectMcp({ provider, serverUrl });
      try {
        const tools = [];
        let cursor;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return json(200, {
          count: tools.length,
          tools: tools
            .map((t) => ({
              name: t.name,
              description: (t.description || "").slice(0, 300),
              params: Object.keys((t.inputSchema && t.inputSchema.properties) || {}),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        });
      } finally {
        await client.close().catch(() => {});
      }
    }

    if (event.httpMethod === "GET") {
      const [connectionsRes, advertisersRes] = await Promise.all([
        readConnections(supabase),
        readAdvertisers(supabase),
      ]);
      if (connectionsRes.error) return json(500, { error: "Supabase read failed", details: sbErr(connectionsRes.error) });
      if (advertisersRes.error) return json(500, { error: "Supabase read failed", details: sbErr(advertisersRes.error) });
      return json(200, {
        connections: connectionsRes.data || [],
        advertisers: advertisersRes.data || [],
      });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Use GET or POST" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (_) {
      body = {};
    }

    // Only disconnect is password-gated.
    if (body.action === "disconnect") {
      const pw = checkPassword(body.password);
      if (!pw.ok) return json(pw.code, { error: pw.error });
    }

    switch (body.action) {
      case "set_network": {
        const net = String(body.affiliate_network || "").toUpperCase();
        if (net !== "GLITCHY" && net !== "MABAC") {
          return json(400, { error: "affiliate_network must be GLITCHY or MABAC" });
        }
        if (!body.connection_id) return json(400, { error: "connection_id is required" });
        const { error } = await supabase
          .from("tiktok_connections")
          .update({ affiliate_network: net, updated_at: new Date().toISOString() })
          .eq("id", body.connection_id);
        if (error) {
          if (/affiliate_network/.test(error.message || "")) {
            return json(400, { error: "Run the supabase/tiktok_bc_networks.sql migration first." });
          }
          return json(500, { error: "Update failed", details: error.message });
        }
        // Keep denormalised campaign rows in step.
        await supabase
          .from("tiktok_campaigns")
          .update({ affiliate_network: net, updated_at: new Date().toISOString() })
          .eq("connection_id", body.connection_id);
        return json(200, { ok: true, affiliate_network: net });
      }

      case "track": {
        const selections = Array.isArray(body.selections) ? body.selections : [];
        const now = new Date().toISOString();
        let updated = 0;
        for (const s of selections) {
          if (!s.connection_id || !s.advertiser_id) continue;
          const { error } = await supabase
            .from("tiktok_advertisers")
            .update({ tracked: !!s.tracked, updated_at: now })
            .eq("connection_id", s.connection_id)
            .eq("advertiser_id", String(s.advertiser_id));
          if (error) return json(500, { error: "Update failed", details: error.message });
          updated += 1;
        }
        return json(200, { ok: true, updated });
      }

      case "refresh": {
        if (!body.connection_id) return json(400, { error: "connection_id is required" });
        const { data: conn, error } = await supabase
          .from("tiktok_connections")
          .select("*")
          .eq("id", body.connection_id)
          .maybeSingle();
        if (error) return json(500, { error: "Supabase read failed", details: sbErr(error) });
        if (!conn) return json(404, { error: "Connection not found" });

        const { serverUrl, redirectUrl } = resolveConfig();
        const provider = new SupabaseOAuthProvider({
          supabase,
          serverUrl,
          redirectUrl,
          connection: conn,
        });
        const { client } = await connectMcp({ provider, serverUrl });
        let discovery;
        try {
          discovery = await discoverAndStoreAdvertisers({
            supabase,
            client,
            connectionId: conn.id,
          });
        } finally {
          await client.close().catch(() => {});
        }
        await supabase
          .from("tiktok_connections")
          .update({ last_verified_at: new Date().toISOString(), status: "active" })
          .eq("id", conn.id);
        return json(200, { ok: true, ...discovery });
      }

      case "disconnect": {
        if (!body.connection_id) return json(400, { error: "connection_id is required" });
        await supabase.from("tiktok_advertisers").delete().eq("connection_id", body.connection_id);
        const { error } = await supabase
          .from("tiktok_connections")
          .delete()
          .eq("id", body.connection_id);
        if (error) return json(500, { error: "Delete failed", details: error.message });
        return json(200, { ok: true });
      }

      default:
        return json(400, { error: `Unknown action: ${body.action}` });
    }
  } catch (err) {
    return json(500, { error: "Request failed", details: err.message });
  }
};
