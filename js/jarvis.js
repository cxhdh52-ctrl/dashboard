// ============================== JARVIS ==============================
// Chat with the dashboard: questions go to /.netlify/functions/jarvis, which
// answers from the dashboard's own data (read-only). The conversation is kept
// in this browser only (localStorage) so it survives a reload.

const ENDPOINT = "/.netlify/functions/jarvis";
const STORE_KEY = "jarvis.v1";
const MAX_KEEP = 40;

const jv = { messages: [], busy: false, password: null, askPassword: null };
const $ = (id) => document.getElementById(id);

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    if (Array.isArray(saved)) jv.messages = saved.filter((m) => m && typeof m.content === "string");
  } catch (_) {}
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(jv.messages.slice(-MAX_KEEP)));
  } catch (_) {}
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Tiny markdown: **bold**, `code`, "- " bullets, "1. " lists, | tables |, headings.
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}
function md(text) {
  const lines = String(text).split("\n");
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [head, ...rest] = body;
      out.push(
        `<div class="jv-table"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest
          .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<p class="jv-h">${inline(h[1])}</p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

function render() {
  const log = $("jvLog");
  if (!jv.messages.length && !jv.busy) {
    log.innerHTML = `<div class="jv-empty"><b>Ask me how things are going.</b><br>I read your campaigns, spend and earnings, angles, accounts, WH warmups and the tracker. I can't change anything.</div>`;
  } else {
    log.innerHTML =
      jv.messages
        .map((m) =>
          m.role === "user"
            ? `<div class="jv-msg jv-user">${esc(m.content)}</div>`
            : `<div class="jv-msg jv-bot${m.error ? " jv-err" : ""}">${m.error ? esc(m.content) : md(m.content)}</div>`,
        )
        .join("") + (jv.busy ? `<div class="jv-msg jv-bot jv-typing">Checking the numbers…</div>` : "");
  }
  log.scrollTop = log.scrollHeight;
  $("jvSendBtn").disabled = jv.busy;
}

async function ask(question) {
  const q = String(question || "").trim();
  if (!q || jv.busy) return;
  if (!jv.password && jv.askPassword) {
    jv.password = await jv.askPassword({ title: "Jarvis", hint: "Enter the dashboard password (each question uses Claude API credit)." });
  }
  if (!jv.password) return;
  jv.messages.push({ role: "user", content: q });
  jv.busy = true;
  render();
  try {
    const history = jv.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: jv.password, messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) jv.password = null;
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    jv.messages.push({ role: "assistant", content: data.reply || "(no answer)" });
  } catch (err) {
    // Drop the unanswered question from the history Claude sees next time.
    jv.messages.push({ role: "assistant", content: err.message, error: true });
  } finally {
    jv.busy = false;
    save();
    render();
  }
}

function open() {
  $("jarvisModal").classList.add("open");
  render();
  setTimeout(() => $("jvInput").focus(), 50);
}
function close() {
  $("jarvisModal").classList.remove("open");
}

export function initJarvis({ onOpen, askPassword } = {}) {
  jv.askPassword = askPassword || null;
  load();
  $("toolsJarvisBtn").addEventListener("click", () => {
    if (onOpen) onOpen();
    open();
  });
  $("closeJarvisModal").addEventListener("click", close);
  $("jarvisModal").addEventListener("click", (e) => {
    if (e.target.id === "jarvisModal") close();
  });
  $("jvClearBtn").addEventListener("click", () => {
    if (jv.busy) return;
    jv.messages = [];
    save();
    render();
  });
  $("jvChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-jv-ask]");
    if (b) ask(b.dataset.jvAsk);
  });
  const input = $("jvInput");
  $("jvForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = "";
    input.style.height = "";
    ask(q);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("jvForm").requestSubmit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "";
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  });
}
