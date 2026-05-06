import { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } from "electron";
import { execFile, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const cfgPath = path.join(__dirname, "..", "config.json");
  const ex = path.join(__dirname, "..", "config.example.json");
  if (!existsSync(cfgPath)) {
    if (existsSync(ex)) {
      throw new Error("未找到 imgListen/config.json，请复制 config.example.json 为 config.json 并填写需要的项。");
    }
    throw new Error("未找到 imgListen/config.json。");
  }
  return JSON.parse(readFileSync(cfgPath, "utf8"));
}

function durationMs(cfg, secKey, msKey, defaultMs) {
  const sec = Number(cfg?.[secKey]);
  if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  const ms = Number(cfg?.[msKey]);
  if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
  return defaultMs;
}

/** 邮件冷却：最少 30s；默认配置按 60s（见 durationMs 默认值） */
function emailCooldownMsClamped(cfg) {
  const raw = durationMs(cfg, "emailCooldownSec", "emailCooldownMs", 60_000);
  return Math.max(30_000, raw);
}

/** 系统提醒冷却：最少 10s；默认 40s */
function alertCooldownMsClamped(cfg) {
  const raw = durationMs(cfg, "alertCooldownSec", "alertCooldownMs", 40_000);
  return Math.max(10_000, raw);
}

function clampPollMs(cfg, fallbackMs = 2000) {
  const raw = durationMs(cfg, "pollIntervalSec", "pollIntervalMs", fallbackMs);
  return Math.max(1000, raw);
}

/** 配置为人形阈值：兼容旧版 0–1 小数与新版 1–100 整数 */
function personConfAsYOLOFloat(cfg) {
  const v = Number(cfg?.personConfThreshold);
  if (!Number.isFinite(v) || v <= 0) return 0.35;
  if (v <= 1) return Math.min(0.99, Math.max(0.01, v));
  return Math.min(0.99, Math.max(0.01, v / 100));
}

function pythonSpec() {
  if (process.env.PYTHON_EXE) {
    return { cmd: process.env.PYTHON_EXE, prefix: [] };
  }
  if (process.platform === "win32") {
    return { cmd: "py", prefix: ["-3"] };
  }
  return { cmd: "python3", prefix: [] };
}

const workerScript = path.join(__dirname, "..", "python", "worker.py");
const autoClickerScript = path.join(__dirname, "..", "python", "auto_clicker.py");

function runPython(args) {
  const { cmd, prefix } = pythonSpec();
  return new Promise((resolve, reject) => {
    execFile(cmd, [...prefix, workerScript, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stderr && stderr.trim()) {
        // eslint-disable-next-line no-console
        console.error(stderr.trim());
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function createPythonServerTransport(child) {
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const queue = [];
  const waiters = [];
  rl.on("line", (line) => {
    if (waiters.length) {
      waiters.shift()(line);
    } else {
      queue.push(line);
    }
  });
  const readNextLine = () =>
    new Promise((resolve) => {
      if (queue.length) {
        resolve(queue.shift());
        return;
      }
      waiters.push(resolve);
    });
  return { readNextLine, close: () => rl.close() };
}

function startPythonServer() {
  const { cmd, prefix } = pythonSpec();
  const child = spawn(cmd, [...prefix, workerScript, "server"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => {
    const s = String(chunk).trim();
    if (s) console.error(s);
  });
  return child;
}

async function serverRpc(child, readNextLine, payload) {
  await new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => (err ? reject(err) : resolve()));
  });
  const line = await readNextLine();
  return JSON.parse(line);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 640,
    title: "访客",
    autoHideMenuBar: true,
    webPreferences: {
      // MVP：用 IPC 交互即可，不引入复杂上下文隔离
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "electron", "renderer", "index.html"));
  return win;
}

const state = {
  running: false,
  pyChild: null,
  transport: null,
  timer: null,
  frame: 0,
  chosenSubstr: "",
  cfg: null,
  lastEmailAt: 0,
  debugEnabled: false,
  clickerChild: null,
  frontServer: null,
  visitorSegmentId: null,
  visitorSegmentStartAt: 0,
  visitorSegmentBest: null,
  visitorPrevPerson: false,
  visitorSegmentCount: 0,
  /** 已对目标窗口设置 HWND_TOPMOST（需在 stop 时 lower_target） */
  layeringTopmostApplied: false,
  /** 已对 Electron 窗口 setAlwaysOnTop(true) */
  electronAlwaysOnTopApplied: false,
};

let mainWindow = null;
let settingsWindow = null;
let historyWindow = null;
const FRONT_PORT = 12000;
let alertToneTimer = null;

/** 仅调整 Z 序，不总在最前 */
function bumpOurWindowsToFront() {
  try {
    mainWindow?.moveTop?.();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.moveTop?.();
    if (historyWindow && !historyWindow.isDestroyed()) historyWindow.moveTop?.();
  } catch (_) {}
}

/** 目标已 TOPMOST 后，把本应用窗口设为 always-on-top 并 moveTop，叠在目标之上 */
function applyElectronAlwaysAboveTarget() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.moveTop();
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setAlwaysOnTop(true);
      settingsWindow.moveTop();
    }
    if (historyWindow && !historyWindow.isDestroyed()) {
      historyWindow.setAlwaysOnTop(true);
      historyWindow.moveTop();
    }
    state.electronAlwaysOnTopApplied = true;
  } catch (_) {}
}

function clearElectronAlwaysOnTop() {
  try {
    mainWindow?.setAlwaysOnTop(false);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.setAlwaysOnTop(false);
    if (historyWindow && !historyWindow.isDestroyed()) historyWindow.setAlwaysOnTop(false);
  } catch (_) {}
}

/** Windows：Python SetWindowPos TOPMOST；成功则 Electron always-on-top。失败则仅 moveTop。 */
async function raiseTargetThenBumpOurWindows(pyChild, readNextLine, substr, cfg) {
  let raised = null;
  const wantLayer = cfg.raiseTargetWindowOnMonitor !== false && process.platform === "win32";
  try {
    if (wantLayer) {
      raised = await serverRpc(pyChild, readNextLine, {
        cmd: "raise_target",
        substr,
        topmost: true,
      });
      const r = raised?.raise;
      if (r?.ok === true && !r?.skipped) {
        state.layeringTopmostApplied = true;
      }
    }
  } catch (_) {
    raised = null;
  } finally {
    if (wantLayer) {
      const r = raised?.raise;
      if (r?.ok === true && !r?.skipped) {
        applyElectronAlwaysAboveTarget();
      } else {
        bumpOurWindowsToFront();
      }
    } else {
      bumpOurWindowsToFront();
    }
  }
  return raised;
}

function contentTypeByExt(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json" || ext === ".jsonl") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  return "application/octet-stream";
}

function startFrontStaticServer(port = FRONT_PORT) {
  if (state.frontServer) return;
  const rootDir = path.join(__dirname, "..", "front");
  const server = createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      let reqPath = decodeURIComponent(urlObj.pathname || "/");
      if (reqPath === "/") reqPath = "/index.html";
      const candidate = path.normalize(path.join(rootDir, reqPath));
      if (!candidate.startsWith(rootDir)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
      let filePath = candidate;
      if (!existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const data = await readFile(filePath);
      res.writeHead(200, { "Content-Type": contentTypeByExt(filePath), "Cache-Control": "no-cache" });
      res.end(data);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(e?.message || e));
    }
  });
  server.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(`[front-server] 12000 启动失败: ${String(err?.message || err)}`);
  });
  server.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[front-server] http://0.0.0.0:${port}/`);
  });
  state.frontServer = server;
}

function stopFrontStaticServer() {
  if (!state.frontServer) return;
  try {
    state.frontServer.close();
  } catch (_) {}
  state.frontServer = null;
}

async function listWindowsJson() {
  const out = await runPython(["list"]);
  return JSON.parse(out);
}

function formatSecStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function savePersonSnapshotFromBase64(framePngBase64, cfg, confidence) {
  if (!framePngBase64) return "";
  const baseDir = cfg.personSnapshotDir || "front/data";
  const absBase = path.join(__dirname, "..", baseDir);
  const now = new Date();
  const dateDir = formatSecStamp(now).slice(0, 8);
  const hhmmss = formatSecStamp(now).slice(9);
  const confText = confidence == null ? "na" : String(Math.round(Number(confidence) * 100)).padStart(2, "0");
  const absDir = path.join(absBase, dateDir);
  mkdirSync(absDir, { recursive: true });
  let candidate = path.join(absDir, `${hhmmss}_c${confText}.png`);
  let idx = 1;
  while (existsSync(candidate)) {
    candidate = path.join(absDir, `${hhmmss}_c${confText}_${idx}.png`);
    idx += 1;
  }
  const buf = Buffer.from(framePngBase64, "base64");
  writeFileSync(candidate, buf);
  return candidate;
}

/** 与存图同目录（默认 data），一行一条 JSON */
function alertsJsonlPath(cfg) {
  const baseDir = cfg.personSnapshotDir || "front/data";
  return path.join(__dirname, "..", baseDir, "alerts.jsonl");
}

function dataDirPath(cfg) {
  const baseDir = cfg?.personSnapshotDir || "front/data";
  return path.join(__dirname, "..", baseDir);
}

function snapshotRelativePath(cfg, absSnapshotPath) {
  if (!absSnapshotPath) return null;
  const base = dataDirPath(cfg);
  const rel = path.relative(base, absSnapshotPath);
  if (!rel || rel.startsWith("..")) return null;
  return rel.replaceAll("\\", "/");
}

async function appendAlertRecord(cfg, rec) {
  try {
    const p = alertsJsonlPath(cfg);
    mkdirSync(path.dirname(p), { recursive: true });
    await appendFile(p, `${JSON.stringify(rec)}\n`, "utf8");
  } catch (err) {
    if (cfg?.debugLogEnabled) {
      // eslint-disable-next-line no-console
      console.error("[alerts.jsonl]", err);
    }
  }
}

function mergeOpenVisitorSegment(cfg, segmentId, best) {
  if (!segmentId || !best?.snapshotRel) return false;
  const p = alertsJsonlPath(cfg);
  if (!existsSync(p)) return false;
  const raw = readFileSync(p, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  let merged = false;
  const pct = best.confidence != null ? `${(Number(best.confidence) * 100).toFixed(1)}%` : "?";
  const winTitle = best.windowTitle || "";
  const msg = `检测到人形：可信度 ${pct} | 窗口：${winTitle}`;
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (!merged && o.segmentId === segmentId && o.segmentOpen === true) {
        merged = true;
        out.push(
          JSON.stringify({
            ...o,
            t: best.t || o.t,
            windowTitle: winTitle,
            confidence: best.confidence ?? o.confidence,
            snapshotPath: best.snapshotRel,
            message: msg,
            segmentOpen: false,
          })
        );
        continue;
      }
    } catch (_) {
      /* keep raw line */
    }
    out.push(line);
  }
  if (merged) writeFileSync(p, `${out.join("\n")}\n`, "utf8");
  return merged;
}

function showVisitorDesktopNotify(cfg, body) {
  if (cfg?.desktopNotify === false) return;
  playSystemAlertTone(3000);
  try {
    if (Notification.isSupported()) {
      const text = String(body || "").slice(0, 240);
      const n = new Notification({ title: "访客", body: text });
      n.on("click", () => {
        try {
          n.close();
        } catch (_) {}
        openHistoryViewerInAppWindow();
      });
      n.show();
    }
  } catch (_) {}
}

function playSystemAlertTone(durationMs = 3000) {
  try {
    if (alertToneTimer) {
      clearInterval(alertToneTimer);
      alertToneTimer = null;
    }
    const intervals = [0, 1200, 2400];
    let idx = 0;
    const startedAt = Date.now();
    shell.beep();
    idx = 1;
    alertToneTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (idx < intervals.length && elapsed >= intervals[idx]) {
        try {
          shell.beep();
        } catch (_) {}
        idx += 1;
      }
      if (elapsed >= durationMs || idx >= intervals.length) {
        clearInterval(alertToneTimer);
        alertToneTimer = null;
      }
    }, 120);
  } catch (_) {}
}

function fireVisitorAlertUi(cfg, msg, snapshotPath = "") {
  mainWindow?.webContents?.send("person-alert", {
    message: msg,
    snapshotPath,
  });
  showVisitorDesktopNotify(cfg, msg);
}

function maybeVisitorEmail(cfg, now, alertCooldownMs, confidence, framePngBase64) {
  const emailCooldownMs = emailCooldownMsClamped(cfg);
  if (!cfg.email?.enabled) return;
  if (now - state.lastEmailAt < emailCooldownMs) return;
  state.lastEmailAt = now;
  sendVisitorNotifyEmail(cfg, confidence, framePngBase64 || "")
    .then(() => {
      mainWindow?.webContents?.send("email-sent", { ok: true });
    })
    .catch((e) => {
      mainWindow?.webContents?.send("email-sent", {
        ok: false,
        message: String(e?.message || e),
      });
    });
}

function saveConfigMerged(patch) {
  const cfgPath = path.join(__dirname, "..", "config.json");
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  if (patch.email && typeof patch.email === "object") {
    next.email = { ...(cur.email || {}), ...patch.email };
    if (!String(patch.email.pass || "").trim()) {
      next.email.pass = cur.email?.pass ?? "";
    }
  }
  if (patch.autoClicker && typeof patch.autoClicker === "object") {
    next.autoClicker = { ...(cur.autoClicker || {}), ...patch.autoClicker };
  }
  delete next.preferredWindowTitles;
  delete next.keepLastFrameOnDisk;
  if (next.email && typeof next.email.user === "string") {
    const u = next.email.user.trim();
    if (u) next.email.from = u;
  }
  writeFileSync(cfgPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 580,
    height: 720,
    title: "设置",
    autoHideMenuBar: true,
    parent: mainWindow || undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "..", "electron", "renderer", "settings.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function openHistoryViewerInAppWindow() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.show();
    historyWindow.focus();
    return;
  }
  const frontIndex = path.join(__dirname, "..", "front", "index.html");
  historyWindow = new BrowserWindow({
    width: 900,
    height: 760,
    title: "访客记录",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });
  historyWindow.loadFile(frontIndex, { query: { electron: "1" } });
  historyWindow.on("closed", () => {
    historyWindow = null;
  });
}

function openHistoryViewerWindow() {
  if (state.frontServer) {
    shell.openExternal(`http://127.0.0.1:${FRONT_PORT}/`);
    return;
  }
  openHistoryViewerInAppWindow();
}

function openReadmeInNotepad() {
  const readme = path.join(__dirname, "..", "README.md");
  if (!existsSync(readme)) {
    dialog.showErrorBox("帮助", `未找到 README：\n${readme}`);
    return;
  }
  if (process.platform === "win32") {
    spawn("notepad.exe", [readme], { detached: true, stdio: "ignore" }).unref();
  } else {
    shell.openPath(readme);
  }
}

function mailFromHeader(e) {
  const addr = String(e.user || e.from || "").trim();
  return addr || "noreply@localhost";
}

function smtpTransportOptions(e) {
  const portRaw = Number(e.port);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 465;
  // 465：连接即 TLS（implicit SSL）→ secure true；587/25/2525：明文握手后 STARTTLS → 须 secure false
  const startTlsPorts = new Set([587, 25, 2525]);
  let secure = typeof e.secure === "boolean" ? e.secure : port === 465;
  if (secure && startTlsPorts.has(port)) {
    secure = false;
  }
  return {
    host: e.host,
    port,
    secure,
    requireTLS: startTlsPorts.has(port) && !secure,
    auth: e.user ? { user: e.user, pass: e.pass || "" } : undefined,
  };
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendVisitorNotifyEmail(cfg, confidence, framePngBase64) {
  const e = cfg.email;
  if (!e?.enabled) return;
  const pct =
    confidence != null ? `${(Number(confidence) <= 1 ? Number(confidence) * 100 : Number(confidence)).toFixed(1)}` : "?";
  const timeStr = new Date().toLocaleString("zh-CN", { hour12: false });
  const textBody = `访问出现于${timeStr}，可信度${pct}%。`;
  const attach = e.attachImage !== false;
  const attachments = [];
  let html;
  if (attach && framePngBase64) {
    const cid = "visit@imglisten";
    attachments.push({
      filename: "snapshot.png",
      content: Buffer.from(framePngBase64, "base64"),
      cid,
    });
    html = `<div style="font-family:Segoe UI,Microsoft YaHei,sans-serif;font-size:14px">${escapeHtml(
      textBody
    )}<br/><br/><img src="cid:${cid}" alt="snapshot" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:6px"/></div>`;
  }
  const transporter = nodemailer.createTransport(smtpTransportOptions(e));
  await transporter.sendMail({
    from: mailFromHeader(e),
    to: e.to,
    subject: "来客",
    text: textBody,
    ...(html ? { html } : {}),
    ...(attachments.length ? { attachments } : {}),
  });
}

async function startMonitor(subStr) {
  if (state.running) return;
  state.layeringTopmostApplied = false;
  state.electronAlwaysOnTopApplied = false;
  const cfg = loadConfig();
  state.cfg = cfg;
  state.debugEnabled = !!cfg.debugLogEnabled;

  const pollMs = clampPollMs(cfg, 2000);
  const conf = personConfAsYOLOFloat(cfg);
  const alertCooldownMs = alertCooldownMsClamped(cfg);

  const lastPng = path.join(__dirname, "..", cfg.lastFramePng || "last_frame.png");
  state.chosenSubstr = subStr;
  state.lastEmailAt = 0;
  state.visitorSegmentId = null;
  state.visitorSegmentStartAt = 0;
  state.visitorSegmentBest = null;
  state.visitorPrevPerson = false;
  state.visitorSegmentCount = 0;

  if (state.debugEnabled) {
    console.log("启动 Python 检测服务（首次会加载 YOLO，可能需数十秒）…");
  }
  const pyChild = startPythonServer();
  const transport = createPythonServerTransport(pyChild);
  state.pyChild = pyChild;
  state.transport = transport;
  state.frame = 0;
  state.running = true;

  // 勾选置顶时第一时间置顶目标，再 list 校验管道
  if (cfg.raiseTargetWindowOnMonitor !== false) {
    try {
      const raised = await raiseTargetThenBumpOurWindows(
        pyChild,
        transport.readNextLine,
        state.chosenSubstr,
        cfg
      );
      if (state.debugEnabled) {
        // eslint-disable-next-line no-console
        console.log("[raise_target]", raised?.raise ?? raised);
      }
    } catch (e) {
      if (state.debugEnabled) {
        // eslint-disable-next-line no-console
        console.warn("[raise_target]", String(e?.message || e));
      }
    }
  } else {
    bumpOurWindowsToFront();
  }

  await serverRpc(pyChild, transport.readNextLine, { cmd: "list" });

  state.timer = setInterval(async () => {
    if (!state.running) return;
    state.frame += 1;

    try {
      const pack = await serverRpc(pyChild, transport.readNextLine, {
        cmd: "tick",
        substr: state.chosenSubstr,
        out: lastPng,
        conf,
        includePngBase64: true,
        writeLastFrame: false,
      });

      const cap = pack.capture;
      const det = pack.detect;
      if (state.debugEnabled) {
        console.log("[tick]", {
          substr: state.chosenSubstr,
          capOk: cap?.ok,
          detOk: det?.ok,
          cap,
          det,
        });
      }

      if (!cap?.ok || !det?.ok) {
        const details = {
          cap: cap ?? null,
          det: det ?? null,
          selectedSubstr: state.chosenSubstr,
        };
        if (cap?.ok === false && cap?.error === "no_window_match") {
          mainWindow?.webContents?.send("monitor-status", {
            ok: false,
            message: "目标窗口已关闭或不可见，已自动停止监听",
            details,
          });
          await stopMonitor();
          mainWindow?.webContents?.send("monitor-stopped", { reason: "no_window_match" });
          return;
        }
        mainWindow?.webContents?.send("monitor-status", {
          ok: false,
          message: `capture/detect failed`,
          details,
        });
        return;
      }

      const person = !!det.person;
      mainWindow?.webContents?.send("monitor-status", {
        ok: true,
        person,
        confidence: det.confidence,
        windowTitle: cap.title,
        visitorCount: state.visitorSegmentCount,
      });

      const now = Date.now();
      const framePngBase64 = pack.framePngBase64 || "";

      if (!person) {
        if (state.visitorSegmentId && state.visitorPrevPerson) {
          if (state.visitorSegmentBest?.snapshotRel) {
            mergeOpenVisitorSegment(cfg, state.visitorSegmentId, state.visitorSegmentBest);
          }
          state.visitorSegmentId = null;
          state.visitorSegmentStartAt = 0;
          state.visitorSegmentBest = null;
        }
        state.visitorPrevPerson = false;
      } else {
        state.visitorPrevPerson = true;
        let snapshotPath = "";
        try {
          snapshotPath = savePersonSnapshotFromBase64(framePngBase64, cfg, det?.confidence);
          mainWindow?.webContents?.send("snapshot-saved", { path: snapshotPath });
        } catch (e) {
          mainWindow?.webContents?.send("monitor-status", {
            ok: false,
            message: `snapshot save failed: ${String(e?.message || e)}`,
            details: { selectedSubstr: state.chosenSubstr },
          });
        }

        if (!snapshotPath) {
          /* 无存图则不推进访客分段逻辑 */
        } else {
          const rel = snapshotRelativePath(cfg, snapshotPath);
          const candConf = det.confidence != null ? Number(det.confidence) : -1;
          const bestConf = state.visitorSegmentBest?.confidence != null ? Number(state.visitorSegmentBest.confidence) : -2;
          if (!state.visitorSegmentBest || candConf > bestConf) {
            state.visitorSegmentBest = {
              snapshotRel: rel,
              confidence: det.confidence ?? null,
              windowTitle: cap.title,
              t: new Date().toISOString(),
            };
          }

          const pct = det.confidence != null ? `${(det.confidence * 100).toFixed(1)}%` : "?";
          const msg = `检测到人形：可信度 ${pct} | 窗口：${cap.title}`;

          if (!state.visitorSegmentId) {
            const segmentId = randomUUID();
            state.visitorSegmentId = segmentId;
            state.visitorSegmentStartAt = now;
            state.visitorSegmentCount += 1;
            void appendAlertRecord(cfg, {
              t: new Date().toISOString(),
              windowTitle: cap.title,
              confidence: det.confidence ?? null,
              snapshotPath: rel,
              message: msg,
              segmentId,
              segmentOpen: true,
            });
            fireVisitorAlertUi(cfg, msg, snapshotPath);
            maybeVisitorEmail(cfg, now, alertCooldownMs, det.confidence, framePngBase64);
          } else if (now - state.visitorSegmentStartAt >= alertCooldownMs) {
            mergeOpenVisitorSegment(cfg, state.visitorSegmentId, state.visitorSegmentBest);
            const best = state.visitorSegmentBest;
            const zPct = best?.confidence != null ? `${(best.confidence * 100).toFixed(1)}%` : "?";
            const zTitle = best?.windowTitle || cap.title;
            const zMsg = `检测到人形（本段最佳）：可信度 ${zPct} | 窗口：${zTitle}`;
            fireVisitorAlertUi(cfg, zMsg, "");
            maybeVisitorEmail(cfg, now, alertCooldownMs, det.confidence, framePngBase64);
            state.visitorSegmentId = null;
            state.visitorSegmentStartAt = 0;
            state.visitorSegmentBest = null;
          }
        }
      }
    } catch (e) {
      mainWindow?.webContents?.send("monitor-status", {
        ok: false,
        message: String(e?.message || e),
        details: { selectedSubstr: state.chosenSubstr },
      });
    }
  }, pollMs);
}

async function stopMonitor() {
  if (!state.running) return;
  state.running = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;

  const substr = state.chosenSubstr;
  const pyChild = state.pyChild;
  const transport = state.transport;
  const readNextLine = transport?.readNextLine;

  if (
    state.layeringTopmostApplied &&
    substr &&
    pyChild &&
    typeof readNextLine === "function"
  ) {
    try {
      await serverRpc(pyChild, readNextLine, { cmd: "lower_target", substr });
    } catch (_) {}
    state.layeringTopmostApplied = false;
  }

  if (state.electronAlwaysOnTopApplied) {
    clearElectronAlwaysOnTop();
    state.electronAlwaysOnTopApplied = false;
  }

  try {
    state.transport?.close?.();
  } catch (_) {}
  state.transport = null;

  try {
    if (state.pyChild?.stdin) state.pyChild.stdin.end();
    state.pyChild?.kill?.();
  } catch (_) {}
  state.pyChild = null;

  state.visitorSegmentId = null;
  state.visitorSegmentStartAt = 0;
  state.visitorSegmentBest = null;
  state.visitorPrevPerson = false;
  state.visitorSegmentCount = 0;

  // 监听结束时同步停止连点器（手停/自动停一致）
  await stopAutoClicker();
}

function getClickerConfig(cfg) {
  const c = cfg?.autoClicker || {};
  const stopHotkeyF8 =
    c.stopHotkeyF8 !== undefined
      ? c.stopHotkeyF8 !== false
      : String(c.stopKey || "f8").toLowerCase() !== "none";
  const rawInterval = Number(c.intervalSec) > 0 ? Number(c.intervalSec) : 10;
  return {
    intervalSec: Math.max(10, rawInterval),
    stopKey: stopHotkeyF8 ? "f8" : "none",
    stopOnRightClick: c.stopOnRightClick !== false,
    /** 默认 true：开始监听时一并启动连点器 */
    startWithMonitor: c.startWithMonitor !== false,
  };
}

function sendClickerStatus(status, message = "") {
  mainWindow?.webContents?.send("clicker-status", { status, message });
}

async function startAutoClicker() {
  if (state.clickerChild) {
    sendClickerStatus("running", "连点器已在执行中");
    return;
  }
  const cfg = loadConfig();
  const { intervalSec, stopKey, stopOnRightClick } = getClickerConfig(cfg);
  const { cmd, prefix } = pythonSpec();
  const args = [
    ...prefix,
    autoClickerScript,
    "--interval-sec",
    String(intervalSec),
    "--stop-key",
    stopKey,
    "--stop-on-right-click",
    stopOnRightClick ? "true" : "false",
  ];
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  state.clickerChild = child;
  sendClickerStatus("running", `连点器已启动：间隔 ${intervalSec}s`);

  child.stdout?.on("data", (buf) => {
    const line = String(buf).trim();
    if (!line) return;
    mainWindow?.webContents?.send("clicker-log", { level: "info", line });
  });
  child.stderr?.on("data", (buf) => {
    const line = String(buf).trim();
    if (!line) return;
    mainWindow?.webContents?.send("clicker-log", { level: "error", line });
  });
  child.on("exit", (code, signal) => {
    state.clickerChild = null;
    sendClickerStatus("stopped", `连点器已停止（code=${code ?? "null"} signal=${signal ?? "null"}）`);
  });
}

async function stopAutoClicker() {
  if (!state.clickerChild) {
    sendClickerStatus("stopped", "");
    return;
  }
  try {
    state.clickerChild.kill();
  } catch (_) {}
  state.clickerChild = null;
  sendClickerStatus("killed", "连点器已手动结束");
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (_) {}
  });

  app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.livestream.imglisten");
  }
  Menu.setApplicationMenu(null);
  {
    const bootCfg = loadConfig();
    if (bootCfg.serveFrontOnStartup !== false) {
      startFrontStaticServer();
    }
  }
  mainWindow = createWindow();

  ipcMain.handle("list-windows", async () => {
    return await listWindowsJson();
  });

  ipcMain.handle("get-ui-config", async () => {
    const cfg = loadConfig();
    const pollIntervalMs = clampPollMs(cfg, 2000);
    const alertCooldownMs = alertCooldownMsClamped(cfg);
    const emailCooldownMs = emailCooldownMsClamped(cfg);
    const pct = cfg.personConfThreshold;
    const pctDisplay =
      Number(pct) > 1 ? Math.round(Number(pct)) : Math.round(Number(personConfAsYOLOFloat(cfg)) * 100);
    return {
      pollIntervalSec: Math.round(pollIntervalMs / 100) / 10,
      alertCooldownSec: Math.round(alertCooldownMs / 100) / 10,
      emailCooldownSec: Math.round(emailCooldownMs / 100) / 10,
      titleHint: String(cfg.uiTitleHint || ""),
      personConfThresholdPct: pctDisplay,
      windowTitleContains: String(cfg.windowTitleContains || "").trim(),
    };
  });

  ipcMain.handle("get-full-config", async () => loadConfig());

  ipcMain.handle("save-config", async (_event, patch) => {
    saveConfigMerged(patch || {});
    const cfgAfter = loadConfig();
    if (cfgAfter.serveFrontOnStartup === false) {
      stopFrontStaticServer();
    } else {
      startFrontStaticServer();
    }
    mainWindow?.webContents?.send("config-updated");
    return { ok: true };
  });

  ipcMain.on("start-monitor", async (_event, payload) => {
    const { substr } = payload || {};
    if (!substr) return;
    await startMonitor(substr);
    const cfg = loadConfig();
    if (getClickerConfig(cfg).startWithMonitor) {
      await startAutoClicker();
    }
  });

  ipcMain.on("stop-monitor", async () => {
    await stopMonitor();
  });

  ipcMain.on("open-help-readme", () => {
    openReadmeInNotepad();
  });

  ipcMain.on("open-settings", () => {
    openSettingsWindow();
  });

  ipcMain.on("open-history-viewer", () => {
    openHistoryViewerWindow();
  });

  ipcMain.on("clicker-start", async () => {
    await startAutoClicker();
  });
  ipcMain.on("clicker-stop", async () => {
    await stopAutoClicker();
  });
  ipcMain.handle("clicker-get-status", async () => {
    return { running: !!state.clickerChild };
  });
  ipcMain.handle("open-data-dir", async () => {
    const cfg = loadConfig();
    const p = dataDirPath(cfg);
    mkdirSync(p, { recursive: true });
    const errText = await shell.openPath(p);
    if (errText) return { ok: false, message: errText, path: p };
    return { ok: true, path: p };
  });
  });

  app.on("window-all-closed", () => {
    stopFrontStaticServer();
    stopAutoClicker().catch(() => {});
    stopMonitor().catch(() => {});
    if (process.platform !== "darwin") app.quit();
  });
}
