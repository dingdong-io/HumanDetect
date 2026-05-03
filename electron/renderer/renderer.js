const { ipcRenderer } = require("electron");

const refreshBtn = document.getElementById("refreshBtn");
const monitorToggleBtn = document.getElementById("monitorToggleBtn");
const settingsBtn = document.getElementById("settingsBtn");
const helpBtn = document.getElementById("helpBtn");
const viewHistoryBtn = document.getElementById("viewHistoryBtn");
const openDataBtn = document.getElementById("openDataBtn");
const clearLogsBtn = document.getElementById("clearLogsBtn");
const windowSelect = document.getElementById("windowSelect");
const logs = document.getElementById("logs");
const alertBox = document.getElementById("alertBox");
const titleHintEl = document.getElementById("titleHint");
const statusStrip = document.getElementById("statusStrip");
const currentWindow = document.getElementById("currentWindow");
const visitorCountEl = document.getElementById("visitorCount");
const currentConf = document.getElementById("currentConf");
const statusText = document.getElementById("statusText");
const clickerToggleBtn = document.getElementById("clickerToggleBtn");

/** 访客横幅自动隐藏的定时器（点击可提前关闭并打开历史） */
let visitorAlertHideTimer = null;

let running = false;
let clickerRunning = false;
let monitorStripShown = false;

function showMonitorStripOnce() {
  if (monitorStripShown || !statusStrip) return;
  monitorStripShown = true;
  statusStrip.classList.add("visible");
}

function logLine(msg, cls = "") {
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.textContent = `[${ts}] ${msg}`;
  if (cls) line.className = cls;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight;
}

function setStatus(msg, ok = true) {
  statusText.textContent = msg;
  statusText.className = ok ? "ok" : "bad";
}

function setRunningUI(isRunning) {
  running = isRunning;
  if (!monitorToggleBtn) return;
  monitorToggleBtn.textContent = isRunning ? "停止监听" : "开始监听";
  monitorToggleBtn.classList.remove("primary", "warn");
  monitorToggleBtn.classList.add(isRunning ? "warn" : "primary");
}

function setClickerUI(status) {
  const active = status === "running";
  clickerRunning = active;
  if (!clickerToggleBtn) return;
  clickerToggleBtn.textContent = active ? "停止连点器" : "启动连点器";
  clickerToggleBtn.classList.remove("primary", "warn");
  clickerToggleBtn.classList.add(active ? "warn" : "primary");
}

function applyUiConfig(cfg) {
  titleHintEl.textContent = cfg?.titleHint || "";
}

async function refreshWindows() {
  let uiCfg = null;
  try {
    uiCfg = await ipcRenderer.invoke("get-ui-config");
    applyUiConfig(uiCfg);
  } catch (_) {}

  windowSelect.innerHTML = `<option value="">请选择窗口</option>`;
  try {
    const list = await ipcRenderer.invoke("list-windows");
    if (!Array.isArray(list) || list.length === 0) {
      logLine("未发现可用窗口", "bad");
      return;
    }
    list.forEach((w) => {
      const title = (w.title || "").trim();
      if (!title) return;
      const op = document.createElement("option");
      op.value = title;
      op.textContent = title;
      windowSelect.appendChild(op);
    });
    const savedTitle = String(uiCfg?.windowTitleContains || "").trim();
    if (savedTitle && [...windowSelect.options].some((o) => o.value === savedTitle)) {
      windowSelect.value = savedTitle;
    }
    logLine(`窗口列表刷新完成，共 ${windowSelect.options.length - 1} 项`, "ok");
  } catch (e) {
    logLine(`刷新窗口失败: ${String(e?.message || e)}`, "bad");
  }
}

function startMonitor() {
  const selected = windowSelect.value;
  if (!selected) {
    logLine("请先选择一个窗口", "bad");
    return;
  }
  ipcRenderer.send("start-monitor", { substr: selected });
  setRunningUI(true);
  currentWindow.textContent = selected;
  setStatus("监听中", true);
  logLine(`开始监听：${selected}`, "ok");
}

function stopMonitor() {
  ipcRenderer.send("stop-monitor");
  setRunningUI(false);
  setStatus("已停止", true);
  logLine("已停止监听");
}

function onMonitorToggleClick() {
  if (running) stopMonitor();
  else startMonitor();
}

function onClickerToggleClick() {
  if (clickerRunning) ipcRenderer.send("clicker-stop");
  else ipcRenderer.send("clicker-start");
}

ipcRenderer.on("monitor-status", (_event, payload) => {
  if (!payload) return;
  if (!payload.ok) {
    setStatus("检测异常", false);
    let detailText = "";
    if (payload.details) {
      try {
        detailText = ` | details=${JSON.stringify(payload.details)}`;
      } catch (_) {
        detailText = " | details=[unserializable]";
      }
    }
    logLine(`监控异常: ${payload.message || "unknown"}${detailText}`, "bad");
    return;
  }
  showMonitorStripOnce();
  const conf = payload.confidence == null ? "-" : `${(payload.confidence * 100).toFixed(1)}%`;
  currentConf.textContent = conf;
  currentWindow.textContent = payload.windowTitle || currentWindow.textContent;
  if (payload.visitorCount != null) visitorCountEl.textContent = String(payload.visitorCount);
  if (running) setStatus("监听中", true);
});

ipcRenderer.on("monitor-stopped", (_event, payload) => {
  setRunningUI(false);
  setStatus("已停止", true);
  const reason = payload?.reason || "unknown";
  logLine(`监听已自动停止（${reason}）`, "bad");
});

ipcRenderer.on("person-alert", (_event, payload) => {
  const msg = payload?.message || "检测到人形";
  if (visitorAlertHideTimer) {
    clearTimeout(visitorAlertHideTimer);
    visitorAlertHideTimer = null;
  }
  alertBox.textContent = `⚠ ${msg}`;
  alertBox.classList.add("show");
  alertBox.style.cursor = "pointer";
  alertBox.title = "点击查看访客历史";
  logLine(msg, "bad");
  alertBox.onclick = () => {
    if (visitorAlertHideTimer) {
      clearTimeout(visitorAlertHideTimer);
      visitorAlertHideTimer = null;
    }
    alertBox.classList.remove("show");
    alertBox.onclick = null;
    alertBox.style.cursor = "";
    alertBox.title = "";
    ipcRenderer.send("open-history-viewer");
  };
  visitorAlertHideTimer = setTimeout(() => {
    visitorAlertHideTimer = null;
    alertBox.classList.remove("show");
    alertBox.onclick = null;
    alertBox.style.cursor = "";
    alertBox.title = "";
  }, 3000);
});

ipcRenderer.on("snapshot-saved", (_event, payload) => {
  const p = payload?.path || "";
  if (p) logLine(`已存图：${p}`, "ok");
});

ipcRenderer.on("email-sent", (_event, payload) => {
  if (payload?.ok) logLine("邮件已发送", "ok");
  else logLine(`邮件发送失败: ${payload?.message || "unknown"}`, "bad");
});

ipcRenderer.on("clicker-status", (_event, payload) => {
  setClickerUI(payload?.status || "stopped");
  const msg = payload?.message || "";
  if (msg) logLine(msg, payload?.status === "running" ? "ok" : "");
});

ipcRenderer.on("clicker-log", (_event, payload) => {
  const line = payload?.line || "";
  if (!line) return;
  logLine(`[clicker] ${line}`, payload?.level === "error" ? "bad" : "");
});

ipcRenderer.on("config-updated", async () => {
  try {
    const cfg = await ipcRenderer.invoke("get-ui-config");
    applyUiConfig(cfg);
    logLine("配置已更新", "ok");
  } catch (_) {}
});

refreshBtn.addEventListener("click", refreshWindows);
monitorToggleBtn?.addEventListener("click", onMonitorToggleClick);
settingsBtn.addEventListener("click", () => ipcRenderer.send("open-settings"));
helpBtn.addEventListener("click", () => ipcRenderer.send("open-help-readme"));
viewHistoryBtn.addEventListener("click", () => ipcRenderer.send("open-history-viewer"));
openDataBtn.addEventListener("click", async () => {
  try {
    const ret = await ipcRenderer.invoke("open-data-dir");
    if (ret?.ok) logLine(`已打开目录：${ret.path}`, "ok");
    else logLine(`打开目录失败: ${ret?.message || "unknown"}`, "bad");
  } catch (e) {
    logLine(`打开目录失败: ${String(e?.message || e)}`, "bad");
  }
});
clearLogsBtn.addEventListener("click", () => {
  logs.innerHTML = "";
});
clickerToggleBtn?.addEventListener("click", onClickerToggleClick);

window.addEventListener("beforeunload", () => {
  ipcRenderer.send("stop-monitor");
});

setRunningUI(false);
setClickerUI("stopped");
ipcRenderer
  .invoke("get-ui-config")
  .then((cfg) => {
    applyUiConfig(cfg);
    logLine(
      `当前配置：截屏分析间隔=${cfg?.pollIntervalSec ?? "-"}s，可信度阈值=${cfg?.personConfThresholdPct ?? "-"}%，系统提醒间隔=${cfg?.alertCooldownSec ?? "-"}s，邮件间隔=${cfg?.emailCooldownSec ?? "-"}s`
    );
  })
  .finally(async () => {
    refreshWindows();
    try {
      const s = await ipcRenderer.invoke("clicker-get-status");
      setClickerUI(s?.running ? "running" : "stopped");
    } catch (_) {}
  });
