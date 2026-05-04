const { ipcRenderer } = require("electron");

const form = document.getElementById("form");
const cancelBtn = document.getElementById("cancelBtn");

const EMAIL_COOLD_MIN = 30;
const EMAIL_COOLD_DEFAULT = 60;

function personThresholdPctFromCfg(cfg) {
  const v = Number(cfg?.personConfThreshold);
  if (!Number.isFinite(v) || v <= 0) return 35;
  if (v <= 1) return Math.round(v * 100);
  return Math.round(Math.min(100, Math.max(1, v)));
}

/** 避免说明气泡在窄窗口左右被裁切：hover 时用 fixed + 夹紧 left */
function initSettingTooltips() {
  document.querySelectorAll(".info-tip").forEach((tip) => {
    const pop = tip.querySelector(".info-tip-pop");
    const icon = tip.querySelector(".info-tip-icon");
    if (!pop || !icon) return;

    const clear = () => {
      pop.style.cssText = "";
    };

    const place = () => {
      const margin = 10;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const maxW = Math.min(360, vw - 2 * margin);
      /* 取消 CSS 里 absolute+bottom，避免与 fixed+top 冲突；勿用极左坐标测量（易被折叠布局） */
      Object.assign(pop.style, {
        display: "block",
        position: "fixed",
        transform: "none",
        boxSizing: "border-box",
        maxWidth: `${maxW}px`,
        width: `${maxW}px`,
        bottom: "auto",
        right: "auto",
        left: `${margin}px`,
        top: `${margin}px`,
        opacity: "0",
        pointerEvents: "none",
        zIndex: "10000",
      });
      void pop.offsetWidth;
      const ph = Math.max(pop.offsetHeight, pop.scrollHeight, pop.getBoundingClientRect().height);
      const ir = icon.getBoundingClientRect();
      let top = ir.top - ph - 8;
      if (top < margin) top = ir.bottom + 8;
      if (top + ph > vh - margin) top = Math.max(margin, vh - margin - ph);
      let left = ir.left + ir.width / 2 - maxW / 2;
      left = Math.max(margin, Math.min(left, vw - margin - maxW));
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      pop.style.opacity = "1";
      pop.style.pointerEvents = "";
    };

    tip.addEventListener("mouseenter", () => {
      requestAnimationFrame(place);
    });
    tip.addEventListener("focusin", () => requestAnimationFrame(place));
    tip.addEventListener("mouseleave", clear);
    tip.addEventListener("focusout", (e) => {
      if (!tip.contains(e.relatedTarget)) clear();
    });
  });
}

async function fillMonitorTitleSelect(savedTitle) {
  const sel = document.getElementById("windowTitleContainsSelect");
  if (!sel) return;
  const saved = String(savedTitle ?? "").trim();
  sel.innerHTML = `<option value="">（请先点「刷新窗口列表」）</option>`;
  try {
    const list = await ipcRenderer.invoke("list-windows");
    if (!Array.isArray(list)) return;
    sel.innerHTML = `<option value="">请选择窗口</option>`;
    const seen = new Set();
    for (const w of list) {
      const title = String(w?.title || "").trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const op = document.createElement("option");
      op.value = title;
      op.textContent = title;
      sel.appendChild(op);
    }
    if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
  } catch (_) {}
}

function fill(cfg) {
  document.getElementById("uiTitleHint").value = cfg.uiTitleHint ?? "";
  document.getElementById("pollIntervalSec").value = Number(cfg.pollIntervalSec) > 0 ? Number(cfg.pollIntervalSec) : 2;
  document.getElementById("personConfThreshold").value = personThresholdPctFromCfg(cfg);
  const acs = Number(cfg.alertCooldownSec) > 0 ? Number(cfg.alertCooldownSec) : 40;
  document.getElementById("alertCooldownSec").value = Math.max(10, acs);
  document.getElementById("serveFrontOnStartup").checked = cfg.serveFrontOnStartup !== false;
  document.getElementById("raiseTargetWindowOnMonitor").checked = cfg.raiseTargetWindowOnMonitor !== false;

  const em = cfg.email || {};
  document.getElementById("emailEnabled").checked = !!em.enabled;
  document.getElementById("emailHost").value = em.host || "";
  document.getElementById("emailPort").value = em.port || 587;
  document.getElementById("emailSecure").checked = em.secure === true;
  document.getElementById("emailAccount").value = (em.user || em.from || "").trim();
  document.getElementById("emailPass").value = em.pass || "";
  document.getElementById("emailTo").value = em.to || "";
  document.getElementById("emailAttachImage").checked = em.attachImage !== false;

  let ecs = Number(cfg.emailCooldownSec);
  if (!Number.isFinite(ecs) || ecs <= 0) ecs = EMAIL_COOLD_DEFAULT;
  ecs = Math.max(EMAIL_COOLD_MIN, ecs);
  document.getElementById("emailCooldownSec").value = ecs;

  const ac = cfg.autoClicker || {};
  const iv = Number(ac.intervalSec) > 0 ? Number(ac.intervalSec) : 10;
  document.getElementById("clickerIntervalSec").value = Math.max(10, iv);
  const stopHotkeyF8 =
    ac.stopHotkeyF8 !== undefined ? ac.stopHotkeyF8 !== false : String(ac.stopKey || "f8").toLowerCase() !== "none";
  document.getElementById("clickerStopHotkeyF8").checked = stopHotkeyF8;
  document.getElementById("clickerStopOnRightClick").checked = ac.stopOnRightClick !== false;
  document.getElementById("clickerStartWithMonitor").checked = ac.startWithMonitor !== false;
}

ipcRenderer
  .invoke("get-full-config")
  .then(async (cfg) => {
    fill(cfg);
    await fillMonitorTitleSelect(cfg.windowTitleContains);
  })
  .catch(() => {});
initSettingTooltips();

document.getElementById("refreshSettingsTitlesBtn")?.addEventListener("click", async () => {
  try {
    const cfg = await ipcRenderer.invoke("get-full-config");
    const cur = document.getElementById("windowTitleContainsSelect")?.value?.trim() || cfg.windowTitleContains;
    await fillMonitorTitleSelect(cur || cfg.windowTitleContains);
  } catch (_) {}
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const poll = Math.max(1, Number(document.getElementById("pollIntervalSec").value) || 1);
  let pct = Math.round(Number(document.getElementById("personConfThreshold").value));
  if (!Number.isFinite(pct)) pct = 35;
  pct = Math.min(100, Math.max(1, pct));
  const emailAccount = document.getElementById("emailAccount").value.trim();
  let ecs = Math.round(Number(document.getElementById("emailCooldownSec").value));
  if (!Number.isFinite(ecs)) ecs = EMAIL_COOLD_DEFAULT;
  ecs = Math.max(EMAIL_COOLD_MIN, ecs);

  const patch = {
    uiTitleHint: document.getElementById("uiTitleHint").value.trim(),
    pollIntervalSec: poll,
    personConfThreshold: pct,
    alertCooldownSec: Math.max(10, Number(document.getElementById("alertCooldownSec").value) || 40),
    windowTitleContains: document.getElementById("windowTitleContainsSelect")?.value?.trim() ?? "",
    serveFrontOnStartup: document.getElementById("serveFrontOnStartup").checked,
    raiseTargetWindowOnMonitor: document.getElementById("raiseTargetWindowOnMonitor").checked,
    emailCooldownSec: ecs,
    email: {
      enabled: document.getElementById("emailEnabled").checked,
      host: document.getElementById("emailHost").value.trim(),
      port: Number(document.getElementById("emailPort").value) || 587,
      secure: document.getElementById("emailSecure").checked,
      user: emailAccount,
      from: emailAccount,
      pass: document.getElementById("emailPass").value,
      to: document.getElementById("emailTo").value.trim(),
      attachImage: document.getElementById("emailAttachImage").checked,
    },
    autoClicker: {
      intervalSec: Math.max(10, Number(document.getElementById("clickerIntervalSec").value) || 10),
      stopHotkeyF8: document.getElementById("clickerStopHotkeyF8").checked,
      stopKey: document.getElementById("clickerStopHotkeyF8").checked ? "f8" : "none",
      stopOnRightClick: document.getElementById("clickerStopOnRightClick").checked,
      startWithMonitor: document.getElementById("clickerStartWithMonitor").checked,
    },
  };
  await ipcRenderer.invoke("save-config", patch);
  window.close();
});

cancelBtn.addEventListener("click", () => window.close());
