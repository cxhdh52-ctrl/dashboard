// ============================== SPARK MAKER ==============================
// Burns angle (hook) text onto raw clips and slideshow images, entirely in the
// browser — video goes through WebCodecs via Mediabunny, images through
// <canvas>. Every clip × angle (or hook slide × angle) combination comes back
// as a ready-to-post file. Nothing is uploaded anywhere.

const MEDIABUNNY_URL = "https://cdn.jsdelivr.net/npm/mediabunny@1.59.1/dist/bundles/mediabunny.min.mjs";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
const SETTINGS_KEY = "sparkMaker.v1";
const LIBRARY_ENDPOINT = "/.netlify/functions/creative-library";

const W = 1080, H = 1920;
// TikTok's own UI covers the top tabs, the right-hand action buttons and the
// bottom caption/username. Text is kept between SAFE_TOP and SAFE_BOTTOM and
// SIDE_MARGIN in from both edges (symmetric, so it stays visually centred).
const SAFE_TOP = 200, SAFE_BOTTOM = 1440, SIDE_MARGIN = 130;
const PRESET_TOP = 250;                         // "top": block starts here
const PRESET_CENTER = { upper: 0.32, middle: 0.45 }; // block centre, fraction of H
const THUMB_W = 270, THUMB_H = 480;
const FONT_STACK = '"TikTok Sans", "Helvetica Neue", Arial, sans-serif';

const sm = {
  tab: "videos",
  clips: [],     // { file, name, thumb, pos }
  hooks: [],     // { file, name, img, sw, sh, thumb, pos }
  middles: [],   // { file, name, img, sw, sh }
  checkout: null,
  results: [],   // { name, blob, group, angle, source }
  busy: false,
  cancelled: false,
  conversion: null,
};

let mbPromise = null;
const loadMediabunny = () => (mbPromise ||= import(MEDIABUNNY_URL));
let zipPromise = null;
const loadJsZip = () => (zipPromise ||= import(JSZIP_URL).then((m) => m.default || m));

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- settings

function readOpts() {
  return {
    style: $("smStyle").value,
    scale: Number($("smSize").value) / 100,
    preset: $("smPosition").value,
  };
}

function angleList() {
  return $("smAngles").value.split("\n").map((s) => s.trim()).filter(Boolean);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      angles: $("smAngles").value,
      style: $("smStyle").value,
      size: $("smSize").value,
      preset: $("smPosition").value,
      checkoutText: $("smCheckoutText").value,
      tab: sm.tab,
    }));
  } catch (_) {}
}

function restoreSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch (_) {}
  if (!s) return;
  if (typeof s.angles === "string") $("smAngles").value = s.angles;
  if (s.style) $("smStyle").value = s.style;
  if (s.size) $("smSize").value = s.size;
  if (s.preset) $("smPosition").value = s.preset;
  if (typeof s.checkoutText === "string") $("smCheckoutText").value = s.checkoutText;
  if (s.tab === "slides") sm.tab = "slides";
}

// ---------------------------------------------------------------- drawing

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function fontFor(size) {
  return `800 ${size}px ${FONT_STACK}`;
}

// Greedy word wrap by measured width. "|" forces a line break.
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of text.split("|")) {
    let line = "";
    for (const word of para.trim().split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxW) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

// Biggest size (up to the style's max × user scale) that fits in ≤4 lines
// within the safe width.
function layoutText(ctx, text, style, scale) {
  const boxed = style !== "outline";
  const maxSize = Math.round((boxed ? 64 : 78) * scale);
  const minSize = 34;
  let size = maxSize;
  let lines = [];
  for (;;) {
    ctx.font = fontFor(size);
    const pad = boxed ? size * 0.42 : size * 0.12;
    const avail = W - 2 * SIDE_MARGIN - 2 * pad;
    lines = wrapLines(ctx, text, avail);
    const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    if ((lines.length <= 4 && widest <= avail) || size <= minSize) break;
    size -= 2;
  }
  const lineH = Math.round(size * (boxed ? 1.32 : 1.2));
  return { size, lines, lineH, blockH: lines.length * lineH, boxed };
}

function blockTop(L, pos, preset) {
  let top;
  if (typeof pos === "number") top = pos * H - L.blockH / 2;
  else if (preset === "top") top = PRESET_TOP;
  else top = (PRESET_CENTER[preset] || PRESET_CENTER.upper) * H - L.blockH / 2;
  return Math.max(SAFE_TOP, Math.min(SAFE_BOTTOM - L.blockH, top));
}

// Draws text into a W×H coordinate space (callers scale the context for previews).
function drawAngle(ctx, text, opts, pos) {
  if (!text || !text.trim()) return;
  ctx.save();
  const L = layoutText(ctx, text, opts.style, opts.scale);
  const top = blockTop(L, pos, opts.preset);
  const cx = W / 2;
  ctx.font = fontFor(L.size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineY = (i) => top + i * L.lineH + L.lineH / 2 + L.size * 0.04;

  if (!L.boxed) {
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(4, L.size * 0.17);
    ctx.strokeStyle = "#000";
    // All outlines first so a line's stroke never covers the previous line's fill.
    L.lines.forEach((line, i) => ctx.strokeText(line, cx, lineY(i)));
    ctx.fillStyle = "#fff";
    L.lines.forEach((line, i) => ctx.fillText(line, cx, lineY(i)));
  } else {
    const white = opts.style === "white";
    const padX = L.size * 0.42;
    const r = L.size * 0.26;
    ctx.fillStyle = white ? "#fff" : "#000";
    L.lines.forEach((line, i) => {
      const w = ctx.measureText(line).width + padX * 2;
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, top + i * L.lineH, w, L.lineH, r);
      ctx.fill();
    });
    ctx.fillStyle = white ? "#000" : "#fff";
    L.lines.forEach((line, i) => ctx.fillText(line, cx, lineY(i)));
  }
  ctx.restore();
}

function drawCover(ctx, src, sw, sh, w, h) {
  const s = Math.max(w / sw, h / sh);
  ctx.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
}

// Near-9:16 images are cropped to fill. Off-ratio ones (screenshots, square
// photos) are shown whole over a blurred, darkened copy of themselves so
// nothing important gets cut off.
function drawFitted(ctx, src, sw, sh, w, h) {
  if (Math.abs(sw / sh / (w / h) - 1) < 0.15) {
    drawCover(ctx, src, sw, sh, w, h);
    return;
  }
  ctx.save();
  if ("filter" in ctx) {
    ctx.filter = `blur(${Math.round(w / 27)}px) brightness(0.55)`;
    drawCover(ctx, src, sw, sh, w, h);
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
  const s = Math.min(w / sw, h / sh);
  ctx.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
}

// ---------------------------------------------------------------- loading inputs

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, sw: img.naturalWidth, sh: img.naturalHeight, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read image ${file.name}`));
    };
    img.src = url;
  });
}

async function imageEntry(file) {
  const { img, sw, sh } = await loadImage(file);
  const thumb = makeCanvas(THUMB_W, THUMB_H);
  drawFitted(thumb.getContext("2d"), img, sw, sh, THUMB_W, THUMB_H);
  return { file, name: file.name, img, sw, sh, thumb, pos: null };
}

// First-ish frame through the same decoder the export uses, so the preview
// matches the output exactly (rotation, crop).
async function videoThumb(file) {
  try {
    const MB = await loadMediabunny();
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const sink = new MB.CanvasSink(track, { width: THUMB_W, height: THUMB_H, fit: "cover" });
    const start = await track.getFirstTimestamp();
    const wrapped = await sink.getCanvas(start + 0.4);
    if (!wrapped) return null;
    const c = makeCanvas(THUMB_W, THUMB_H);
    c.getContext("2d").drawImage(wrapped.canvas, 0, 0);
    return c;
  } catch (err) {
    console.warn("[SparkMaker] thumbnail failed", file.name, err);
    return null;
  }
}

// ---------------------------------------------------------------- rendering outputs

async function renderVideo(MB, clip, angle, opts, onProgress) {
  const overlay = makeCanvas(W, H);
  drawAngle(overlay.getContext("2d"), angle, opts, clip.pos);
  const frame = makeCanvas(W, H);
  const fctx = frame.getContext("2d");

  const input = new MB.Input({ source: new MB.BlobSource(clip.file), formats: MB.ALL_FORMATS });
  const output = new MB.Output({
    format: new MB.Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new MB.BufferTarget(),
  });
  const conversion = await MB.Conversion.init({
    input,
    output,
    video: {
      width: W,
      height: H,
      fit: "cover",
      codec: "avc",
      quality: MB.QUALITY_HIGH,
      forceTranscode: true,
      allowTransformationMetadata: false,
      process: (sample) => {
        sample.draw(fctx, 0, 0, W, H);
        fctx.drawImage(overlay, 0, 0);
        return frame;
      },
      processedWidth: W,
      processedHeight: H,
    },
  });
  const videoDropped = conversion.discardedTracks.find((d) => d.track.type === "video");
  if (!conversion.isValid || videoDropped) {
    const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(", ");
    throw new Error(`${clip.name} can't be converted in this browser (${why || "no video track"})`);
  }
  sm.conversion = conversion;
  conversion.onProgress = onProgress;
  await conversion.execute();
  sm.conversion = null;
  return new Blob([output.target.buffer], { type: "video/mp4" });
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image export failed"))), "image/jpeg", 0.92),
  );
}

async function renderSlide(entry, text, opts, pos) {
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");
  drawFitted(ctx, entry.img, entry.sw, entry.sh, W, H);
  if (text) drawAngle(ctx, text, opts, pos);
  return canvasToJpeg(c);
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "angle";
}

const pad2 = (n) => String(n).padStart(2, "0");

// ---------------------------------------------------------------- UI: inputs

function renderFileLists() {
  const chips = (items, kind) =>
    items
      .map(
        (it, i) =>
          `<span class="sm-chip" title="${escapeAttr(it.name)}">${kind === "clips" ? "Clip" : kind === "hooks" ? "Hook" : "Slide"} ${i + 1} · ${escapeHtml(shortName(it.name))}<button type="button" data-sm-remove="${kind}:${i}" aria-label="Remove">✕</button></span>`,
      )
      .join("");
  $("smClipList").innerHTML = chips(sm.clips, "clips");
  $("smHookList").innerHTML = chips(sm.hooks, "hooks");
  $("smMiddleList").innerHTML = chips(sm.middles, "middles");
  $("smCheckoutList").innerHTML = sm.checkout
    ? `<span class="sm-chip">${escapeHtml(shortName(sm.checkout.name))}<button type="button" data-sm-remove="checkout:0" aria-label="Remove">✕</button></span>`
    : "";
}

function shortName(name) {
  return name.length > 22 ? `${name.slice(0, 12)}…${name.slice(-8)}` : name;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const escapeAttr = escapeHtml;

async function addFiles(kind, fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  setStatus(`Loading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  try {
    if (kind === "clips") {
      for (const file of files) {
        const entry = { file, name: file.name, thumb: null, pos: null };
        sm.clips.push(entry);
        renderFileLists();
        renderPreview();
        entry.thumb = await videoThumb(file);
        renderPreview();
      }
    } else if (kind === "checkout") {
      sm.checkout = await imageEntry(files[0]);
    } else {
      for (const file of files) sm[kind].push(await imageEntry(file));
    }
    setStatus("");
  } catch (err) {
    setStatus(err.message, "bad");
  }
  renderFileLists();
  renderPreview();
}

function removeFile(spec) {
  const [kind, idx] = spec.split(":");
  if (kind === "checkout") sm.checkout = null;
  else sm[kind].splice(Number(idx), 1);
  renderFileLists();
  renderPreview();
}

// ---------------------------------------------------------------- UI: preview

function drawPreviewTile(canvas, thumb, text, pos) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (thumb) ctx.drawImage(thumb, 0, 0, canvas.width, canvas.height);
  else {
    ctx.fillStyle = "#666";
    ctx.font = `600 ${Math.round(canvas.width / 11)}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.fillText("loading…", canvas.width / 2, canvas.height * 0.85);
  }
  ctx.scale(canvas.width / W, canvas.height / H);
  drawAngle(ctx, text, readOpts(), pos);
}

function previewRows() {
  const angles = angleList();
  if (sm.tab === "videos") {
    return sm.clips.map((c, i) => ({ key: `clips:${i}`, label: `Clip ${i + 1}`, entry: c, texts: angles }));
  }
  const rows = sm.hooks.map((h, i) => ({ key: `hooks:${i}`, label: `Hook slide ${i + 1}`, entry: h, texts: angles }));
  const ck = $("smCheckoutText").value.trim();
  if (sm.checkout) rows.push({ key: "checkout:0", label: "Checkout slide", entry: sm.checkout, texts: [ck] });
  return rows;
}

function entryFor(key) {
  const [kind, idx] = key.split(":");
  return kind === "checkout" ? sm.checkout : sm[kind][Number(idx)];
}

function renderPreview() {
  const wrap = $("smPreview");
  const rows = previewRows();
  const angles = angleList();
  updateSummary();
  if (!rows.length) {
    wrap.innerHTML = `<p class="sm-empty">${
      sm.tab === "videos" ? "Add raw clips and angles to see previews." : "Add hook slides and angles to see previews."
    }</p>`;
    return;
  }
  if (!angles.length && sm.tab === "videos") {
    wrap.innerHTML = `<p class="sm-empty">Write at least one angle (one per line).</p>`;
    return;
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  wrap.innerHTML = rows
    .map(
      (r) => `<div class="sm-row">
        <div class="sm-row-head">${escapeHtml(r.label)}${
          typeof r.entry.pos === "number" ? ` <button type="button" class="sm-reset" data-sm-reset="${r.key}">reset position</button>` : ""
        }</div>
        <div class="sm-row-tiles">${(r.texts.length ? r.texts : [""])
          .map(
            (t, j) => `<div class="sm-tile"><canvas data-sm-row="${r.key}" data-sm-text="${j}" width="${Math.round(
              135 * dpr,
            )}" height="${Math.round(240 * dpr)}"></canvas><div class="sm-tile-cap">${
              r.key.startsWith("checkout") ? "checkout" : `angle ${j + 1}`
            }</div></div>`,
          )
          .join("")}</div>
      </div>`,
    )
    .join("");
  redrawAllTiles();
}

function redrawAllTiles(onlyKey) {
  const rows = previewRows();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  $("smPreview").querySelectorAll("canvas[data-sm-row]").forEach((cv) => {
    const r = byKey[cv.dataset.smRow];
    if (!r || (onlyKey && onlyKey !== r.key)) return;
    drawPreviewTile(cv, r.entry.thumb, r.texts[Number(cv.dataset.smText)] || "", r.entry.pos);
  });
}

function updateSummary() {
  const n = angleList().length;
  let text = "";
  if (sm.tab === "videos") {
    text = `${sm.clips.length} clip${sm.clips.length === 1 ? "" : "s"} × ${n} angle${n === 1 ? "" : "s"} = ${
      sm.clips.length * n
    } spark${sm.clips.length * n === 1 ? "" : "s"}`;
  } else {
    const per = 1 + sm.middles.length + (sm.checkout ? 1 : 0);
    text = `${sm.hooks.length} hook slide${sm.hooks.length === 1 ? "" : "s"} × ${n} angle${n === 1 ? "" : "s"} = ${
      sm.hooks.length * n
    } slideshow${sm.hooks.length * n === 1 ? "" : "s"} (${per} image${per === 1 ? "" : "s"} each)`;
  }
  $("smSummary").textContent = text;
  $("smGenerateBtn").disabled = sm.busy || !canGenerate();
}

function canGenerate() {
  const n = angleList().length;
  return sm.tab === "videos" ? sm.clips.length > 0 && n > 0 : sm.hooks.length > 0 && n > 0;
}

// Drag text on any tile — moves it for every angle on that clip/slide.
function wireDrag() {
  const wrap = $("smPreview");
  let dragKey = null;
  let raf = 0;
  const posFromEvent = (cv, e) => {
    const rect = cv.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  };
  wrap.addEventListener("pointerdown", (e) => {
    const cv = e.target.closest("canvas[data-sm-row]");
    if (!cv || sm.busy) return;
    dragKey = cv.dataset.smRow;
    cv.setPointerCapture(e.pointerId);
    entryFor(dragKey).pos = posFromEvent(cv, e);
    redrawAllTiles(dragKey);
    e.preventDefault();
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!dragKey) return;
    const cv = e.target.closest("canvas[data-sm-row]");
    if (!cv) return;
    entryFor(dragKey).pos = posFromEvent(cv, e);
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        redrawAllTiles(dragKey);
      });
  });
  const end = () => {
    if (!dragKey) return;
    dragKey = null;
    renderPreview(); // shows the "reset position" link
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sm-reset]");
    if (!btn) return;
    entryFor(btn.dataset.smReset).pos = null;
    renderPreview();
  });
}

// ---------------------------------------------------------------- generate

function setStatus(msg, kind = "") {
  const el = $("smStatus");
  el.textContent = msg;
  el.className = `eng-placeholder ${kind}`;
}

function setBusy(busy) {
  sm.busy = busy;
  $("smCancelBtn").hidden = !busy;
  $("smGenerateBtn").disabled = busy || !canGenerate();
  document.querySelectorAll("#sparkMakerModal [data-sm-lock]").forEach((el) => (el.disabled = busy));
}

// Every angle you make sparks with lands in the Creative Library (duplicates
// are skipped server-side), so it can be tagged on campaigns later.
// Fire-and-forget — the library not being set up never blocks rendering.
function registerAngles(angles) {
  fetch(LIBRARY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add_angles", texts: angles, source: "spark_maker" }),
  }).catch(() => {});
}

async function generate() {
  if (sm.busy || !canGenerate()) return;
  const angles = angleList();
  const opts = readOpts();
  saveSettings();
  registerAngles(angles);
  clearResults();
  sm.cancelled = false;
  setBusy(true);
  try {
    if (document.fonts) await document.fonts.load(fontFor(60)).catch(() => {});
    if (sm.tab === "videos") await generateVideos(angles, opts);
    else await generateSlides(angles, opts);
    if (sm.cancelled) setStatus(`Stopped — ${sm.results.length} finished file(s) kept below.`, "warn");
    else setStatus(`Done — ${countOutputs()} ready.`, "ok");
  } catch (err) {
    if (!sm.cancelled) console.error("[SparkMaker]", err);
    setStatus(sm.cancelled ? "Stopped." : `Failed: ${err.message}`, sm.cancelled ? "warn" : "bad");
  } finally {
    sm.conversion = null;
    setBusy(false);
    renderResults();
  }
}

function countOutputs() {
  if (sm.tab === "videos") return `${sm.results.length} spark${sm.results.length === 1 ? "" : "s"}`;
  const sets = new Set(sm.results.map((r) => r.group)).size;
  return `${sets} slideshow${sets === 1 ? "" : "s"}`;
}

async function generateVideos(angles, opts) {
  setStatus("Loading video engine…", "busy");
  const MB = await loadMediabunny();
  if (!(await MB.canEncodeVideo("avc", { width: W, height: H }))) {
    throw new Error("This browser can't encode H.264 video. Use Chrome, Edge or Safari 17+.");
  }
  const total = sm.clips.length * angles.length;
  let done = 0;
  const t0 = performance.now();
  for (let i = 0; i < sm.clips.length; i++) {
    for (let j = 0; j < angles.length; j++) {
      if (sm.cancelled) return;
      const label = `Rendering ${done + 1}/${total} — clip ${i + 1}, angle ${j + 1}`;
      setStatus(label, "busy");
      const blob = await renderVideo(MB, sm.clips[i], angles[j], opts, (p) => {
        setStatus(`${label} · ${Math.round(p * 100)}%${eta(t0, done + p, total)}`, "busy");
      });
      done++;
      sm.results.push({
        name: `c${i + 1}_a${j + 1}_${slug(angles[j])}.mp4`,
        blob,
        group: null,
        angle: angles[j],
        source: sm.clips[i].name,
      });
      renderResults();
    }
  }
}

function eta(t0, done, total) {
  if (done < 0.3) return "";
  const per = (performance.now() - t0) / done;
  const left = Math.round((per * (total - done)) / 1000);
  return left > 2 ? ` · ~${left >= 90 ? `${Math.round(left / 60)} min` : `${left}s`} left` : "";
}

async function generateSlides(angles, opts) {
  const checkoutText = $("smCheckoutText").value.trim();
  // Shared slides are identical in every set — render them once.
  setStatus("Rendering shared slides…", "busy");
  const middles = [];
  for (const m of sm.middles) middles.push(await renderSlide(m, "", opts, null));
  const checkout = sm.checkout ? await renderSlide(sm.checkout, checkoutText, opts, sm.checkout.pos) : null;

  const total = sm.hooks.length * angles.length;
  let done = 0;
  for (let i = 0; i < sm.hooks.length; i++) {
    for (let j = 0; j < angles.length; j++) {
      if (sm.cancelled) return;
      setStatus(`Rendering slideshow ${done + 1}/${total}…`, "busy");
      const group = `h${i + 1}_a${j + 1}_${slug(angles[j])}`;
      const files = [await renderSlide(sm.hooks[i], angles[j], opts, sm.hooks[i].pos), ...middles];
      const sources = [sm.hooks[i].name, ...sm.middles.map((m) => m.name)];
      if (checkout) {
        files.push(checkout);
        sources.push(sm.checkout.name);
      }
      files.forEach((blob, k) =>
        sm.results.push({ name: `${group}/${pad2(k + 1)}.jpg`, blob, group, angle: angles[j], source: sources[k] }),
      );
      done++;
      renderResults();
    }
  }
}

function cancel() {
  sm.cancelled = true;
  if (sm.conversion) sm.conversion.cancel().catch(() => {});
}

// ---------------------------------------------------------------- results

function clearResults() {
  sm.results = [];
  renderResults();
}

function fmtSize(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function resultGroups() {
  // Videos: one entry per file. Slides: one entry per slideshow set.
  const groups = [];
  const byGroup = new Map();
  for (const r of sm.results) {
    if (!r.group) {
      groups.push({ id: r.name, label: r.name, angle: r.angle, items: [r] });
      continue;
    }
    if (!byGroup.has(r.group)) {
      const g = { id: r.group, label: r.group, angle: r.angle, items: [] };
      byGroup.set(r.group, g);
      groups.push(g);
    }
    byGroup.get(r.group).items.push(r);
  }
  return groups;
}

function canShareFiles(files) {
  try {
    return !!(navigator.canShare && navigator.canShare({ files }));
  } catch (_) {
    return false;
  }
}

function toFiles(items) {
  return items.map((r) => new File([r.blob], r.name.replace(/\//g, "_"), { type: r.blob.type }));
}

function renderResults() {
  const wrap = $("smResults");
  const groups = resultGroups();
  $("smResultsBar").hidden = !groups.length;
  if (!groups.length) {
    wrap.innerHTML = "";
    return;
  }
  const totalBytes = sm.results.reduce((s, r) => s + r.blob.size, 0);
  $("smResultsCount").textContent = `${countOutputs()} · ${fmtSize(totalBytes)}`;
  $("smShareAllBtn").hidden = !canShareFiles(toFiles(sm.results.slice(0, 1)));
  wrap.innerHTML = groups
    .map((g, gi) => {
      const size = g.items.reduce((s, r) => s + r.blob.size, 0);
      const meta = g.items.length > 1 ? `${g.items.length} images · ${fmtSize(size)}` : fmtSize(size);
      return `<div class="sm-result">
        <div class="sm-result-main"><div class="sm-result-name">${escapeHtml(g.label)}</div>
        <div class="sm-result-sub">${escapeHtml(g.angle || "")} · ${meta}</div></div>
        <button type="button" class="icon-btn" data-sm-dl="${gi}">Download</button>
      </div>`;
    })
    .join("");
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function zipOf(items, withManifest) {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  // Video/JPEG are already compressed — store, don't deflate.
  for (const r of items) zip.file(r.name, r.blob, { compression: "STORE" });
  if (withManifest) {
    const csv = ["file,source,angle", ...items.map((r) => [r.name, r.source, r.angle].map(csvCell).join(","))];
    zip.file("manifest.csv", csv.join("\n"));
  }
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

async function downloadGroup(gi) {
  const g = resultGroups()[gi];
  if (!g) return;
  if (g.items.length === 1) return downloadBlob(g.items[0].blob, g.items[0].name);
  // On iPad, a slideshow set goes straight to the share sheet ("Save N images").
  const files = toFiles(g.items);
  if (canShareFiles(files) && isTouchDevice()) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  downloadBlob(await zipOf(g.items, false), `${g.id}.zip`);
}

function isTouchDevice() {
  return navigator.maxTouchPoints > 1;
}

async function downloadAll() {
  if (!sm.results.length) return;
  const btn = $("smZipBtn");
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Zipping…";
  try {
    downloadBlob(await zipOf(sm.results, true), `sparks_${stamp()}.zip`);
  } catch (err) {
    setStatus(`Zip failed: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function shareAll() {
  try {
    await navigator.share({ files: toFiles(sm.results) });
  } catch (err) {
    if (err && err.name !== "AbortError") setStatus(`Share failed: ${err.message}`, "bad");
  }
}

// ---------------------------------------------------------------- tabs / open

function applyTab(tab) {
  sm.tab = tab;
  document.querySelectorAll("#smTabs .tracker-tab").forEach((b) => b.classList.toggle("active", b.dataset.smTab === tab));
  $("smVideosPane").hidden = tab !== "videos";
  $("smSlidesPane").hidden = tab !== "slides";
  clearResults();
  renderPreview();
}

function open() {
  $("sparkMakerModal").classList.add("open");
  renderPreview();
  renderResults();
  // Warm the font + video engine while the user picks files.
  if (document.fonts) document.fonts.load(fontFor(60)).then(() => redrawAllTiles()).catch(() => {});
  loadMediabunny().catch(() => {});
}

function close() {
  $("sparkMakerModal").classList.remove("open");
}

// Opens the Spark Maker with these angles in the box (from the Creative
// Library's "Spark" / "Save & open Spark Maker").
export function openSparkMakerWithAngles(texts) {
  if (Array.isArray(texts) && texts.length) {
    $("smAngles").value = texts.join("\n");
    saveSettings();
  }
  open();
}

export function initSparkMaker({ onOpen } = {}) {
  restoreSettings();
  $("toolsSparkMakerBtn").addEventListener("click", () => {
    if (onOpen) onOpen();
    open();
  });
  $("closeSparkMakerModal").addEventListener("click", close);
  $("sparkMakerModal").addEventListener("click", (e) => {
    if (e.target.id === "sparkMakerModal" && !sm.busy) close();
  });
  $("smTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sm-tab]");
    if (b && !sm.busy) {
      applyTab(b.dataset.smTab);
      saveSettings();
    }
  });
  for (const [inputId, kind] of [
    ["smClipInput", "clips"],
    ["smHookInput", "hooks"],
    ["smMiddleInput", "middles"],
    ["smCheckoutInput", "checkout"],
  ]) {
    $(inputId).addEventListener("change", async (e) => {
      await addFiles(kind, e.target.files);
      e.target.value = "";
    });
  }
  $("sparkMakerModal").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-sm-remove]");
    if (rm && !sm.busy) removeFile(rm.dataset.smRemove);
    const dl = e.target.closest("[data-sm-dl]");
    if (dl) downloadGroup(Number(dl.dataset.smDl));
  });
  const rerender = () => {
    saveSettings();
    renderPreview();
  };
  $("smAngles").addEventListener("input", rerender);
  $("smCheckoutText").addEventListener("input", rerender);
  $("smStyle").addEventListener("change", rerender);
  $("smPosition").addEventListener("change", () => {
    // A new preset is a fresh start — drop per-clip drags.
    [...sm.clips, ...sm.hooks, sm.checkout].forEach((e) => e && (e.pos = null));
    rerender();
  });
  $("smSize").addEventListener("input", () => {
    $("smSizeVal").textContent = `${$("smSize").value}%`;
    rerender();
  });
  $("smSizeVal").textContent = `${$("smSize").value}%`;
  $("smGenerateBtn").addEventListener("click", generate);
  $("smCancelBtn").addEventListener("click", cancel);
  $("smZipBtn").addEventListener("click", downloadAll);
  $("smShareAllBtn").addEventListener("click", shareAll);
  wireDrag();
  applyTab(sm.tab);
}
