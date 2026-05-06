#!/usr/bin/env node
/**
 * 多屏协同窗口画面监控：周期截屏 → YOLO 人形检测 → 控制台警报 + 邮件。
 * 读屏/解析 UI 可参考 Microsoft OmniParser（GUI 元素），与人形检测是不同能力，见 --help。
 */

import { execFile, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const cfgPath = path.join(__dirname, "config.json");
  const ex = path.join(__dirname, "config.example.json");
  if (!existsSync(cfgPath)) {
    if (existsSync(ex)) {
      console.error("未找到 imgListen/config.json，请复制 config.example.json 为 config.json 并填写邮件等项。");
    }
    return null;
  }
  return JSON.parse(readFileSync(cfgPath, "utf8"));
}

/** 与 Electron 主进程一致：兼容 0–1 小数与 1–100 整数阈值 */
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

const workerScript = path.join(__dirname, "python", "worker.py");

function runPython(args) {
  const { cmd, prefix } = pythonSpec();
  return new Promise((resolve, reject) => {
    execFile(cmd, [...prefix, workerScript, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stderr && stderr.trim()) {
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

async function listWindowsJson() {
  const out = await runPython(["list"]);
  return JSON.parse(out);
}

function printHelp() {
  console.log(`
用法:
  node index.mjs              按 config.json 监控（默认标题包含「多屏协同」的窗口）
  node index.mjs --list       列出可见窗口标题后退出
  node index.mjs --select     交互选择窗口（按序号），再开始监控
  node index.mjs --help

环境:
  PYTHON_EXE   指定 Python 可执行文件（否则 Windows 用 py -3，其它用 python3）

依赖（Python）:
  pip install -r python/requirements.txt

说明:
  · 人形检测使用 Ultralytics YOLOv8n（COCO 的 person 类），默认读取 python/yolov8n.pt。
  · Microsoft OmniParser 用于将屏幕解析为 UI 控件/图标，不用于人体检测。
    若要在本机对同一截图做 OmniParser 解析，请克隆官方仓库并配置权重，自行在
    OmniParser 环境中对 last_frame.png 跑 gradio_demo 或 util 中的流程。
  · 可选：在 config.json 中设置 omniParser.enabled 与 extraScript，由 Node 周期性
    调用你的脚本（接收截图路径），用于自行调用 OmniParser。
`);
}

function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function pickWindowInteractive(rows) {
  console.log("\n可选窗口（输入序号）:\n");
  rows.forEach((w, i) => {
    console.log(`  [${i}] ${w.title}`);
  });
  const ans = await askLine(`\n请选择 0–${rows.length - 1}: `);
  const idx = parseInt(ans, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= rows.length) {
    console.error("无效序号");
    process.exit(1);
  }
  return rows[idx];
}

let lastEmailAt = 0;

async function sendEmail(cfg, subject, text) {
  const e = cfg.email;
  if (!e?.enabled) {
    return;
  }
  const transporter = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.secure !== false,
    auth: e.user ? { user: e.user, pass: e.pass } : undefined,
  });
  await transporter.sendMail({
    from: e.from,
    to: e.to,
    subject,
    text,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  if (argv.includes("--list")) {
    const rows = await listWindowsJson();
    for (const w of rows) {
      console.log(w.title);
    }
    return;
  }

  const cfg = loadConfig();
  if (!cfg) {
    process.exit(1);
  }

  const titleSubstr = cfg.windowTitleContains ?? "多屏协同";
  const pollMs = Number(cfg.pollIntervalMs) || 2000;
  const conf = personConfAsYOLOFloat(cfg);
  const cooldown = Number(cfg.emailCooldownMs) ?? 120_000;
  const lastPng = path.join(__dirname, cfg.lastFramePng || "last_frame.png");
  const dir = path.dirname(lastPng);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (_) {}

  let chosenSubstr = titleSubstr;

  if (argv.includes("--select")) {
    const rows = await listWindowsJson();
    const picked = await pickWindowInteractive(rows);
    chosenSubstr = picked.title;
  } else {
    const rows = await listWindowsJson();
    const hits = rows.filter((w) => (w.title || "").includes(titleSubstr));
    if (hits.length === 0) {
      console.error(`未找到标题包含「${titleSubstr}」的窗口。请使用 --select 手动选择，或修改 config.json 中的 windowTitleContains。`);
      process.exit(1);
    }
    if (hits.length > 1) {
      console.warn(`找到 ${hits.length} 个匹配「${titleSubstr}」的窗口，将使用面积最大者。可用 --select 精确选择。`);
    }
  }

  let frame = 0;
  const omni = cfg.omniParser;
  const omniEvery = omni?.everyNFrames && omni.enabled ? Number(omni.everyNFrames) : 0;
  const omniScript = omni?.extraScript ? path.resolve(__dirname, omni.extraScript) : "";

  console.log("正在启动 Python 检测服务（首次会加载 YOLO，可能需数十秒）…");
  const pyChild = startPythonServer();
  const transport = createPythonServerTransport(pyChild);

  const cleanup = () => {
    try {
      transport.close();
      pyChild.stdin.end();
      pyChild.kill();
    } catch (_) {}
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  pyChild.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Python 进程异常退出 code=${code}`);
    }
  });

  try {
    await serverRpc(pyChild, transport.readNextLine, { cmd: "list" });
  } catch (e) {
    console.error("无法与 Python 服务通信:", e.message || e);
    cleanup();
    process.exit(1);
  }

  console.log(`开始监控，窗口匹配: 「${chosenSubstr}」，轮询 ${pollMs} ms，人形置信阈值 ${conf}`);

  for (;;) {
    frame += 1;
    let pack;
    try {
      pack = await serverRpc(pyChild, transport.readNextLine, { cmd: "tick", substr: chosenSubstr, out: lastPng, conf });
    } catch (e) {
      console.error("tick 失败:", e.message || e);
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const cap = pack.capture;
    const det = pack.detect;
    if (!cap?.ok) {
      console.warn("未匹配到窗口:", cap);
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (!det?.ok) {
      console.warn("检测失败:", det);
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    if (omniEvery > 0 && frame % omniEvery === 0 && omniScript && existsSync(omniScript)) {
      const { cmd, prefix } = pythonSpec();
      execFile(cmd, [...prefix, omniScript, lastPng], { encoding: "utf8" }, (err, stdout) => {
        if (err) console.warn("[omni extra]", err.message);
        else if (stdout) console.log("[omni extra]", stdout.trim());
      });
    }

    if (det.person) {
      const pct = det.confidence != null ? `${(det.confidence * 100).toFixed(1)}%` : "?";
      const msg = `[警报] 多屏协同画面中出现人形，置信度 ${pct} | 窗口: ${cap.title}`;
      console.error("\x1b[31m%s\x1b[0m", msg);
      const now = Date.now();
      if (cfg.email?.enabled && now - lastEmailAt >= cooldown) {
        lastEmailAt = now;
        try {
          await sendEmail(cfg, "多屏协同：检测到人形", msg + `\n\n截图文件: ${lastPng}`);
          console.log("已发送邮件通知。");
        } catch (mailErr) {
          console.error("邮件发送失败:", mailErr.message || mailErr);
        }
      } else if (cfg.email?.enabled) {
        console.log("(邮件冷却中，未重复发送)");
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
