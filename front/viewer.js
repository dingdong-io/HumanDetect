const selectEl = document.getElementById("alertSelect");
const dateSelect = document.getElementById("dateSelect");
const refreshBtn = document.getElementById("refreshBtn");
const previewEl = document.getElementById("preview");
const metaEl = document.getElementById("meta");
const imgMetaEl = document.getElementById("imgMeta");
const dayRecordCountEl = document.getElementById("dayRecordCount");
const electronCloseBtn = document.getElementById("electronCloseBtn");

(function initElectronChrome() {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("electron") === "1" && electronCloseBtn) {
      electronCloseBtn.hidden = false;
      electronCloseBtn.addEventListener("click", () => window.close());
    }
  } catch (_) {}
})();

let allRecords = [];
let datesDescending = [];
let dayAlerts = [];

function localYMD(isoOrDate) {
  const d = new Date(isoOrDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

function fmtConfidence(v) {
  if (v == null || Number.isNaN(Number(v))) return "-";
  return `${(Number(v) * 100).toFixed(1)}%`;
}

function readLines(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function normalizeSnapshotPath(rec) {
  const p = rec.snapshotPath || rec.snapshot || "";
  if (!p) return "";
  if (/^[a-zA-Z]:\\/.test(p)) {
    const idx = p.toLowerCase().indexOf("\\front\\data\\");
    if (idx >= 0) return `data/${p.slice(idx + "\\front\\data\\".length).replaceAll("\\", "/")}`;
    const idx2 = p.toLowerCase().indexOf("\\data\\");
    if (idx2 >= 0) return `data/${p.slice(idx2 + "\\data\\".length).replaceAll("\\", "/")}`;
    return "";
  }
  const normalized = String(p).replaceAll("\\", "/");
  if (normalized.startsWith("data/")) return normalized;
  return `data/${normalized}`;
}

function uniqueDatesDescending(rows) {
  const s = new Set();
  for (const r of rows) {
    if (r?.t) s.add(localYMD(r.t));
  }
  return [...s].sort((a, b) => b.localeCompare(a));
}

function defaultDateForViewer(sortedDesc) {
  if (!sortedDesc.length) return "";
  const today = localYMD(new Date());
  if (sortedDesc.includes(today)) return today;
  let d = new Date();
  for (let i = 0; i < 400; i++) {
    d.setDate(d.getDate() - 1);
    const k = localYMD(d);
    if (sortedDesc.includes(k)) return k;
  }
  return sortedDesc[0];
}

function recordsForDay(ymd) {
  return allRecords.filter((r) => r && r.t && localYMD(r.t) === ymd).sort((a, b) => new Date(b.t) - new Date(a.t));
}

function renderDateOptions(selectedYmd) {
  dateSelect.innerHTML = "";
  for (const dt of datesDescending) {
    const op = document.createElement("option");
    op.value = dt;
    op.textContent = dt;
    dateSelect.appendChild(op);
  }
  if (!datesDescending.length) return;
  if (selectedYmd && datesDescending.includes(selectedYmd)) {
    dateSelect.value = selectedYmd;
  } else {
    dateSelect.value = datesDescending[0];
  }
}

function renderAlertOptions() {
  selectEl.innerHTML = "";
  for (let i = 0; i < dayAlerts.length; i += 1) {
    const a = dayAlerts[i];
    const op = document.createElement("option");
    op.value = String(i);
    op.textContent = `${fmtTime(a.t)} - ${fmtConfidence(a.confidence)}`;
    selectEl.appendChild(op);
  }
}

function pick(idx) {
  if (!dayAlerts.length) return;
  const n = Math.max(0, Math.min(dayAlerts.length - 1, Number(idx)));
  selectEl.value = String(n);
  const current = dayAlerts[n];
  const rel = normalizeSnapshotPath(current);
  imgMetaEl.textContent = `${current.t} | 可信度 ${fmtConfidence(current.confidence)}`;
  previewEl.src = rel ? `${encodeURI(rel)}?t=${Date.now()}` : "";
}

function applySelectedDay() {
  const sel = dateSelect.value;
  dayAlerts = sel ? recordsForDay(sel) : [];
  if (dayRecordCountEl) dayRecordCountEl.textContent = sel ? `共 ${dayAlerts.length} 条` : "";
  metaEl.textContent = "";
  renderAlertOptions();
  if (!dayAlerts.length) {
    previewEl.removeAttribute("src");
    imgMetaEl.textContent = "未选中记录";
    return;
  }
  pick(0);
}

function refreshDayView(preserveDate) {
  if (!datesDescending.length) {
    dateSelect.innerHTML = "";
    selectEl.innerHTML = "";
    dayAlerts = [];
    metaEl.textContent = "暂无访客记录";
    if (dayRecordCountEl) dayRecordCountEl.textContent = "";
    previewEl.removeAttribute("src");
    imgMetaEl.textContent = "未选中记录";
    return;
  }
  metaEl.textContent = "";
  const ymd = preserveDate && datesDescending.includes(preserveDate) ? preserveDate : defaultDateForViewer(datesDescending);
  renderDateOptions(ymd);
  applySelectedDay();
}

async function loadAlerts() {
  const prevDate = dateSelect?.value || "";
  try {
    const res = await fetch(`./data/alerts.jsonl?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const rows = readLines(text).map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    });
    allRecords = rows.filter((r) => r && r.t);
    datesDescending = uniqueDatesDescending(allRecords);
    refreshDayView(prevDate && datesDescending.includes(prevDate) ? prevDate : null);
  } catch (err) {
    metaEl.textContent = `加载失败：${String(err?.message || err)}`;
    allRecords = [];
    datesDescending = [];
    dateSelect.innerHTML = "";
    dayAlerts = [];
    selectEl.innerHTML = "";
    if (dayRecordCountEl) dayRecordCountEl.textContent = "";
    previewEl.removeAttribute("src");
  }
}

selectEl.addEventListener("change", (e) => pick(e.target.value));
dateSelect.addEventListener("change", () => {
  applySelectedDay();
});
refreshBtn?.addEventListener("click", () => {
  loadAlerts();
});
loadAlerts();
