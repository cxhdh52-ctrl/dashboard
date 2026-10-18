// ============================== CREATIVE LIBRARY ==============================
// Angles (hooks) with their real performance — every campaign tagged with an
// angle adds its spend/revenue since launch — plus "Make variations", which
// asks Claude for new takes on an angle using the whole library as context.
// Backend: netlify/functions/creative-library.js.

const ENDPOINT = "/.netlify/functions/creative-library";

const VERDICT = {
  winner: ["good", "Winner"],
  break_even: ["warn", "Break-even"],
  dead: ["bad", "Dead"],
  testing: ["neutral", "Testing"],
  untested: ["none", "Untested"],
};

const lib = {
  tab: "angles",
  angles: [],
  campaigns: [],
  aiConfigured: false,
  loaded: false,
  offerFilter: "all",
  geoFilter: "all",
  sort: "profit",
  showArchived: false,
  untaggedOnly: true,
  campaignSearch: "",
  selectedCampaigns: new Set(),
  variations: null, // { angleId, items: [{ text, why, checked }], busy, error }
  password: null,
};

let deps = { askPassword: null, openSparkMaker: null, onOpen: null };

const $ = (id) => document.getElementById(id);

async function call(action, payload = {}) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

// Exported for other tools (Spark Maker, Campaign Creator).
export async function addLibraryAngles(texts, { source = "manual", offer = null, geo = null, parentId = null } = {}) {
  return call("add_angles", { texts, source, offer, geo, parent_id: parentId });
}

export async function listLibraryAngles() {
  const data = await call("list");
  return (data.angles || []).filter((a) => a.status !== "archived");
}

export async function tagCampaignsWithAngle(angleId, campaignIds) {
  return call("tag", { angle_id: angleId, campaign_ids: campaignIds });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const money = (v) => {
  const n = Number(v) || 0;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
};

function setMsg(text, kind = "") {
  const el = $("clMsg");
  el.textContent = text || "";
  el.className = `eng-placeholder ${kind}`;
}

// ---------------------------------------------------------------- load

async function load() {
  setMsg("Loading…", "busy");
  try {
    const data = await call("list");
    lib.angles = data.angles || [];
    lib.campaigns = data.campaigns || [];
    lib.aiConfigured = !!data.ai_configured;
    lib.loaded = true;
    setMsg("");
  } catch (err) {
    setMsg(err.code === "migration_required" ? "Setup needed: run supabase/creative_library.sql in the Supabase SQL editor." : err.message, "bad");
  }
  render();
}

function render() {
  document.querySelectorAll("#clTabs .tracker-tab").forEach((b) => b.classList.toggle("active", b.dataset.clTab === lib.tab));
  $("clAnglesPane").hidden = lib.tab !== "angles";
  $("clCampaignsPane").hidden = lib.tab !== "campaigns";
  if (lib.tab === "angles") renderAngles();
  else renderCampaigns();
}

// ---------------------------------------------------------------- angles tab

function offers() {
  return [...new Set(lib.angles.map((a) => a.offer).filter(Boolean))].sort();
}

function geos() {
  return [...new Set(lib.angles.map((a) => a.geo).filter(Boolean))].sort();
}

function visibleAngles() {
  let list = lib.angles.filter((a) => lib.showArchived || a.status !== "archived");
  if (lib.offerFilter !== "all") list = list.filter((a) => a.offer === lib.offerFilter);
  if (lib.geoFilter !== "all") list = list.filter((a) => a.geo === lib.geoFilter);
  const by = {
    profit: (a, b) => b.stats.profit - a.stats.profit || b.stats.spend - a.stats.spend,
    roas: (a, b) => b.stats.roas - a.stats.roas || b.stats.spend - a.stats.spend,
    spend: (a, b) => b.stats.spend - a.stats.spend,
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  }[lib.sort];
  return list.sort(by);
}

function renderAngles() {
  const offerBtns = ["all", ...offers()]
    .map((o) => `<button type="button" class="tracker-filter-btn ${lib.offerFilter === o ? "active" : ""}" data-cl-offer="${escapeHtml(o)}">${o === "all" ? "All" : escapeHtml(o)}</button>`)
    .join("");
  const geoList = geos();
  const geoBtns = geoList.length
    ? `<span class="cl-filter-sep"></span>` +
      ["all", ...geoList]
        .map((g) => `<button type="button" class="tracker-filter-btn ${lib.geoFilter === g ? "active" : ""}" data-cl-geo="${escapeHtml(g)}">${g === "all" ? "All geos" : escapeHtml(g)}</button>`)
        .join("")
    : "";
  $("clOfferFilter").innerHTML = offerBtns + geoBtns;
  $("clOfferFilter").hidden = offers().length === 0 && geoList.length === 0;

  const list = visibleAngles();
  const totals = list.reduce(
    (t, a) => ({ spend: t.spend + a.stats.spend, profit: t.profit + a.stats.profit, winners: t.winners + (a.verdict === "winner" ? 1 : 0) }),
    { spend: 0, profit: 0, winners: 0 },
  );
  $("clSummary").textContent = lib.loaded
    ? `${list.length} angle${list.length === 1 ? "" : "s"} · ${totals.winners} winner${totals.winners === 1 ? "" : "s"} · ${money(totals.spend)} spend · ${money(totals.profit)} profit`
    : "";

  const byId = new Map(lib.angles.map((a) => [a.id, a]));
  if (!list.length) {
    $("clAngleList").innerHTML = lib.loaded
      ? `<p class="sm-empty">No angles yet. Add one above, or make sparks in the Spark Maker — its angles land here automatically.</p>`
      : "";
    return;
  }
  $("clAngleList").innerHTML = list
    .map((a) => {
      const [tone, label] = VERDICT[a.verdict] || VERDICT.untested;
      const parent = a.parent_id && byId.get(a.parent_id);
      const s = a.stats;
      const nums = s.campaigns
        ? `<span>${s.campaigns} campaign${s.campaigns === 1 ? "" : "s"}</span><span>${money(s.spend)} spend</span><span>${money(s.revenue)} rev</span><span class="${s.profit >= 0 ? "cl-pos" : "cl-neg"}">${money(s.profit)}</span><span>${s.roas.toFixed(2)}x</span>`
        : `<span>Not tagged on any campaign yet</span>`;
      const open = lib.variations && lib.variations.angleId === a.id;
      return `<div class="cl-angle ${a.status === "archived" ? "archived" : ""}" data-angle="${a.id}">
        <div class="cl-angle-main">
          <span class="status-badge ${tone}">${label}</span>
          <div class="cl-angle-body">
            <div class="cl-angle-text">${escapeHtml(a.text)}</div>
            <div class="cl-angle-meta">${a.offer ? `<span class="cl-offer">${escapeHtml(a.offer)}</span>` : ""}${a.geo ? `<span class="cl-offer">${escapeHtml(a.geo)}</span>` : ""}${
              parent ? `<span>variation of “${escapeHtml(parent.text.slice(0, 50))}${parent.text.length > 50 ? "…" : ""}”</span>` : ""
            }${nums}</div>
          </div>
          <div class="cl-angle-actions">
            <button type="button" class="icon-btn ${open ? "active" : ""}" data-cl-act="vary">Make variations</button>
            <button type="button" class="icon-btn" data-cl-act="spark" title="Open Spark Maker with this angle">Spark</button>
            <button type="button" class="icon-btn" data-cl-act="edit" title="Edit text / offer">Edit</button>
            <button type="button" class="icon-btn" data-cl-act="archive">${a.status === "archived" ? "Restore" : "Archive"}</button>
          </div>
        </div>
        ${open ? variationsPanel(a) : ""}
      </div>`;
    })
    .join("");
}

function variationsPanel(a) {
  const v = lib.variations;
  if (!lib.aiConfigured) {
    return `<div class="cl-vary"><p class="eng-placeholder warn">Make variations needs a Claude API key: add <b>ANTHROPIC_API_KEY</b> in Vercel → Settings → Environment Variables, then redeploy.</p></div>`;
  }
  const items = (v.items || [])
    .map(
      (it, i) => `<label class="cl-var">
        <input type="checkbox" data-cl-var="${i}" ${it.checked ? "checked" : ""} />
        <span><span class="cl-var-text">${escapeHtml(it.text)}</span><span class="cl-var-why">${escapeHtml(it.why)}</span></span>
      </label>`,
    )
    .join("");
  const checked = (v.items || []).filter((x) => x.checked).length;
  return `<div class="cl-vary">
    <div class="cl-vary-controls">
      <select id="clVarCount">${[5, 8, 10, 15].map((n) => `<option value="${n}" ${n === (v.count || 8) ? "selected" : ""}>${n} variations</option>`).join("")}</select>
      <input type="text" id="clVarGuidance" placeholder="Optional direction, e.g. shorter, POV style, different situations" value="${escapeHtml(v.guidance || "")}" autocomplete="off" />
      <button type="button" class="icon-btn primary" data-cl-act="generate" ${v.busy ? "disabled" : ""}>${v.busy ? "Thinking…" : v.items ? "Regenerate" : "Generate"}</button>
    </div>
    ${v.error ? `<div class="eng-placeholder bad">${escapeHtml(v.error)}</div>` : ""}
    ${items ? `<div class="cl-var-list">${items}</div>
    <div class="cl-vary-foot">
      <span class="eng-hint">Tick the ones you like. Your picks (and the ones you skip) teach future suggestions.</span>
      <button type="button" class="icon-btn" data-cl-act="save-vars" ${checked ? "" : "disabled"}>Save ${checked || ""} to library</button>
      <button type="button" class="icon-btn primary" data-cl-act="save-vars-spark" ${checked ? "" : "disabled"}>Save &amp; open Spark Maker</button>
    </div>` : ""}
  </div>`;
}

async function getPassword() {
  if (lib.password) return lib.password;
  const pw = deps.askPassword ? await deps.askPassword({ title: "Make variations", hint: "Enter the dashboard password (each run uses Claude API credit)." }) : null;
  if (pw) lib.password = pw;
  return pw;
}

async function generateVariations(angleId) {
  const v = lib.variations;
  v.count = Number(($("clVarCount") || {}).value) || 8;
  v.guidance = (($("clVarGuidance") || {}).value || "").trim();
  const password = await getPassword();
  if (!password) return;
  v.busy = true;
  v.error = null;
  renderAngles();
  try {
    // Regenerating counts the previous batch's unpicked lines as "dropped".
    if (v.items && v.items.length) await recordFeedback(angleId, [], v.items.map((x) => x.text));
    const data = await call("variations", { password, angle_id: angleId, count: v.count, guidance: v.guidance });
    v.items = (data.variations || []).map((x) => ({ ...x, checked: false }));
  } catch (err) {
    if (err.status === 401) lib.password = null;
    v.error = err.message;
  } finally {
    v.busy = false;
    renderAngles();
  }
}

async function recordFeedback(angleId, kept, dropped) {
  const angle = lib.angles.find((a) => a.id === angleId);
  return call("feedback", { angle_id: angleId, kept, dropped, offer: angle ? angle.offer : null, geo: angle ? angle.geo : null });
}

async function saveVariations(angleId, thenSpark) {
  const v = lib.variations;
  const kept = v.items.filter((x) => x.checked).map((x) => x.text);
  const dropped = v.items.filter((x) => !x.checked).map((x) => x.text);
  try {
    await recordFeedback(angleId, kept, dropped);
    lib.variations = null;
    await load();
    setMsg(`Saved ${kept.length} variation${kept.length === 1 ? "" : "s"}.`, "ok");
    if (thenSpark && deps.openSparkMaker) {
      close();
      deps.openSparkMaker(kept);
    }
  } catch (err) {
    setMsg(err.message, "bad");
  }
}

async function onAngleAction(btn) {
  const row = btn.closest("[data-angle]");
  const id = row && row.dataset.angle;
  const angle = lib.angles.find((a) => a.id === id);
  if (!angle) return;
  const act = btn.dataset.clAct;
  if (act === "vary") {
    lib.variations = lib.variations && lib.variations.angleId === id ? null : { angleId: id, items: null };
    renderAngles();
  } else if (act === "generate") {
    generateVariations(id);
  } else if (act === "save-vars") {
    saveVariations(id, false);
  } else if (act === "save-vars-spark") {
    saveVariations(id, true);
  } else if (act === "spark") {
    close();
    if (deps.openSparkMaker) deps.openSparkMaker([angle.text]);
  } else if (act === "archive") {
    await patchAngle(id, { status: angle.status === "archived" ? "active" : "archived" });
  } else if (act === "edit") {
    startEdit(row, angle);
  }
}

function startEdit(row, angle) {
  const body = row.querySelector(".cl-angle-body");
  body.innerHTML = `<div class="cl-edit">
    <input type="text" class="cl-edit-text" value="${escapeHtml(angle.text)}" />
    <input type="text" class="cl-edit-offer" value="${escapeHtml(angle.offer || "")}" placeholder="Offer (e.g. CPI)" />
    <input type="text" class="cl-edit-geo" value="${escapeHtml(angle.geo || "")}" placeholder="Geo (e.g. US)" maxlength="2" />
    <button type="button" class="icon-btn primary" data-cl-edit="save">Save</button>
    <button type="button" class="icon-btn" data-cl-edit="cancel">Cancel</button>
  </div>`;
  body.querySelector(".cl-edit-text").focus();
}

async function patchAngle(id, patch) {
  try {
    await call("update_angle", { id, patch });
    await load();
  } catch (err) {
    setMsg(err.message, "bad");
  }
}

async function addAngleFromInput() {
  const texts = $("clNewAngle").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!texts.length) return;
  try {
    const { angles } = await addLibraryAngles(texts, {
      offer: $("clNewOffer").value.trim() || null,
      geo: $("clNewGeo").value.trim() || null,
    });
    $("clNewAngle").value = "";
    setMsg(angles.length ? `Added ${angles.length} angle${angles.length === 1 ? "" : "s"}.` : "Already in the library.", angles.length ? "ok" : "warn");
    await load();
  } catch (err) {
    setMsg(err.message, "bad");
  }
}

// ---------------------------------------------------------------- campaigns tab

function visibleCampaigns() {
  const q = lib.campaignSearch.toLowerCase();
  return lib.campaigns.filter(
    (c) =>
      (!lib.untaggedOnly || !c.angle_id) &&
      (!q || `${c.campaign_name} ${c.advertiser_name || ""}`.toLowerCase().includes(q)),
  );
}

function angleOptions(selectedId, { includeNone = true } = {}) {
  const active = lib.angles.filter((a) => a.status !== "archived" || a.id === selectedId);
  return (
    (includeNone ? `<option value="">— no angle —</option>` : "") +
    active
      .map((a) => `<option value="${a.id}" ${a.id === selectedId ? "selected" : ""}>${escapeHtml(a.text.length > 70 ? `${a.text.slice(0, 70)}…` : a.text)}</option>`)
      .join("")
  );
}

function renderCampaigns() {
  const list = visibleCampaigns();
  for (const id of [...lib.selectedCampaigns]) if (!list.some((c) => String(c.campaign_id) === id)) lib.selectedCampaigns.delete(id);
  $("clBulkAngle").innerHTML = angleOptions(($("clBulkAngle") || {}).value || "", { includeNone: false });
  $("clBulkApply").disabled = !lib.selectedCampaigns.size || !lib.angles.length;
  $("clBulkApply").textContent = lib.selectedCampaigns.size ? `Tag ${lib.selectedCampaigns.size} selected` : "Tag selected";
  if (!list.length) {
    $("clCampaignTable").innerHTML = `<p class="sm-empty">${lib.untaggedOnly ? "Every campaign has an angle." : "No campaigns."}</p>`;
    return;
  }
  $("clCampaignTable").innerHTML = `<table class="tracker-table cl-camp-table">
    <thead><tr><th></th><th>Campaign</th><th>Account</th><th>Status</th><th>Created</th><th>Angle</th><th class="num">Spend</th><th class="num">Profit</th></tr></thead>
    <tbody>${list
      .map((c) => {
        const id = String(c.campaign_id);
        const created = c.create_time ? new Date(c.create_time).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
        const life = c.life;
        return `<tr data-camp="${id}">
          <td><input type="checkbox" class="cl-camp-check" ${lib.selectedCampaigns.has(id) ? "checked" : ""} /></td>
          <td>${escapeHtml(c.campaign_name)}</td>
          <td>${escapeHtml(c.advertiser_name || c.advertiser_id)}</td>
          <td><span class="status-badge ${escapeHtml(c.effective_tone || "neutral")}">${escapeHtml(c.effective_status || "—")}</span></td>
          <td>${created}</td>
          <td><select class="cl-camp-angle">${angleOptions(c.angle_id)}</select></td>
          <td class="num">${life ? money(life.spend) : "—"}</td>
          <td class="num ${life ? (life.revenue - life.spend >= 0 ? "cl-pos" : "cl-neg") : ""}">${life ? money(life.revenue - life.spend) : "—"}</td>
        </tr>`;
      })
      .join("")}</tbody></table>`;
}

async function tag(angleId, ids) {
  setMsg(`Tagging ${ids.length} campaign${ids.length === 1 ? "" : "s"}… (older campaigns read their history from TikTok)`, "busy");
  try {
    const r = await tagCampaignsWithAngle(angleId || null, ids);
    const errs = Object.keys(r.backfill_errors || {}).length;
    lib.selectedCampaigns.clear();
    await load();
    setMsg(
      angleId
        ? `Tagged ${r.tagged}.${errs ? ` ${errs} couldn't read past spend from TikTok — they count from today.` : ""}`
        : `Removed the angle from ${ids.length}.`,
      errs ? "warn" : "ok",
    );
  } catch (err) {
    setMsg(err.message, "bad");
  }
}

// ---------------------------------------------------------------- open / wire

function open() {
  $("creativeLibraryModal").classList.add("open");
  load();
}

function close() {
  $("creativeLibraryModal").classList.remove("open");
}

export function initCreativeLibrary({ onOpen, askPassword, openSparkMaker } = {}) {
  deps = { onOpen, askPassword, openSparkMaker };
  $("toolsCreativeLibraryBtn").addEventListener("click", () => {
    if (onOpen) onOpen();
    open();
  });
  $("closeCreativeLibraryModal").addEventListener("click", close);
  $("creativeLibraryModal").addEventListener("click", (e) => {
    if (e.target.id === "creativeLibraryModal") close();
  });
  $("clTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cl-tab]");
    if (!b) return;
    lib.tab = b.dataset.clTab;
    render();
  });
  $("clOfferFilter").addEventListener("click", (e) => {
    const g = e.target.closest("[data-cl-geo]");
    if (g) {
      lib.geoFilter = g.dataset.clGeo;
      return renderAngles();
    }
    const b = e.target.closest("[data-cl-offer]");
    if (!b) return;
    lib.offerFilter = b.dataset.clOffer;
    renderAngles();
  });
  $("clSort").addEventListener("change", (e) => {
    lib.sort = e.target.value;
    renderAngles();
  });
  $("clShowArchived").addEventListener("change", (e) => {
    lib.showArchived = e.target.checked;
    renderAngles();
  });
  $("clAddAngleBtn").addEventListener("click", addAngleFromInput);
  $("clNewAngle").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      addAngleFromInput();
    }
  });
  $("clAngleList").addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-cl-edit]");
    if (editBtn) {
      const row = editBtn.closest("[data-angle]");
      if (editBtn.dataset.clEdit === "cancel") return renderAngles();
      return patchAngle(row.dataset.angle, {
        text: row.querySelector(".cl-edit-text").value,
        offer: row.querySelector(".cl-edit-offer").value,
        geo: row.querySelector(".cl-edit-geo").value,
      });
    }
    const btn = e.target.closest("[data-cl-act]");
    if (btn) onAngleAction(btn);
  });
  $("clAngleList").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-cl-var]");
    if (!cb || !lib.variations || !lib.variations.items) return;
    lib.variations.items[Number(cb.dataset.clVar)].checked = cb.checked;
    // Keep typed direction / count across the re-render.
    lib.variations.guidance = (($("clVarGuidance") || {}).value || "").trim();
    lib.variations.count = Number(($("clVarCount") || {}).value) || lib.variations.count;
    renderAngles();
  });
  $("clUntaggedOnly").addEventListener("change", (e) => {
    lib.untaggedOnly = e.target.checked;
    renderCampaigns();
  });
  $("clCampaignSearch").addEventListener("input", (e) => {
    lib.campaignSearch = e.target.value.trim();
    renderCampaigns();
  });
  $("clCampaignTable").addEventListener("change", (e) => {
    const tr = e.target.closest("[data-camp]");
    if (!tr) return;
    if (e.target.classList.contains("cl-camp-check")) {
      if (e.target.checked) lib.selectedCampaigns.add(tr.dataset.camp);
      else lib.selectedCampaigns.delete(tr.dataset.camp);
      renderCampaigns();
    } else if (e.target.classList.contains("cl-camp-angle")) {
      tag(e.target.value, [tr.dataset.camp]);
    }
  });
  $("clBulkApply").addEventListener("click", () => {
    const angleId = $("clBulkAngle").value;
    if (angleId && lib.selectedCampaigns.size) tag(angleId, [...lib.selectedCampaigns]);
  });
}
