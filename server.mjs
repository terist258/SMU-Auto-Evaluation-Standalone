/**
 * 独立版本地控制台：内置 HTTP 服务（只用 node:http，无第三方 web 框架）。
 *
 * 启动：node server.mjs   → 默认 http://127.0.0.1:17320
 * 页面：ui.html（原生 HTML/JS，无构建）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  CONFIG_FILE,
  LAST_RUN_FILE,
  LAST_COURSE_FILE,
  RUN_LOG,
  DEFAULTS,
  readConfig,
  writeConfig,
  readJson,
  maskToken,
  ensureDataDir,
} from "./lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_EXE = path.join(HERE, "node", "node.exe");
const PORT = Number(process.env.SMUEVAL_PORT) || 17320;
const HOST = "127.0.0.1";

const state = {
  running: "",        // "" | "eval" | "course" | "token"
  lastMessage: "",
  startedAt: "",
};

ensureDataDir();

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function runNodeScript(script, extraArgs, label) {
  return new Promise((resolve) => {
    if (state.running) {
      resolve({ ok: false, error: "已有任务在跑，等它结束" });
      return;
    }
    state.running = label;
    state.startedAt = new Date().toISOString();
    state.lastMessage = "";
    const child = spawn(NODE_EXE, [script, ...extraArgs], {
      cwd: HERE,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (buf) => {
      out += String(buf);
      if (out.length > 20000) out = out.slice(-20000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      state.running = "";
      state.lastMessage = String(err && err.message ? err.message : err);
      resolve({ ok: false, error: state.lastMessage });
    });
    child.on("exit", (code) => {
      state.running = "";
      state.lastMessage = code === 0 ? "完成" : `退出码 ${code}`;
      resolve({ ok: code === 0, code, output: out.slice(-4000) });
    });
  });
}

async function scanTokens() {
  const config = readConfig();
  const { collectWeChatTokens, validateToken } = await import("./browser.js");
  let wx = [];
  try {
    wx = collectWeChatTokens(() => {}) || [];
  } catch {
    wx = [];
  }
  const candidates = [];
  for (const token of wx.slice(0, 8)) {
    const valid = await validateToken(config.apiBase, token);
    candidates.push({ source: "wechat", masked: maskToken(token), token, valid });
    if (valid) break;
  }
  if (config.token) {
    candidates.push({
      source: "config",
      masked: maskToken(config.token),
      token: config.token,
      valid: await validateToken(config.apiBase, config.token),
    });
  }
  const best = candidates.find((c) => c.valid) || null;
  return { wechatCount: wx.length, candidates, best };
}

function schtasks(args) {
  return new Promise((resolve) => {
    execFile("schtasks", args, { windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") })
    );
  });
}

function taskName(hhmm) {
  return `smueval-bot-${String(hhmm).replace(":", "")}`;
}

async function taskStatus() {
  const config = readConfig();
  const times = Array.isArray(config.runTimes) && config.runTimes.length ? config.runTimes : ["20:30"];
  const tasks = [];
  for (const t of times) {
    const name = taskName(t);
    const r = await schtasks(["/Query", "/TN", name]);
    tasks.push({ name, time: t, installed: r.ok });
  }
  return tasks;
}

function writeTaskWrapper() {
  // 统一走 dispatch.mjs：它运行时读当前 channel 再分派，
  // 所以用户改了「评课途径」不需要重新注册计划任务，下次触发自动生效。
  const cmdPath = path.join(DATA_DIR, "standalone-run.cmd");
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    `cd /d "${HERE}"`,
    `"${NODE_EXE}" "${path.join(HERE, "dispatch.mjs")}" --jitter >> "${RUN_LOG}" 2>&1`,
    "",
  ].join("\r\n");
  fs.writeFileSync(cmdPath, body, "utf8");
  return cmdPath;
}

async function installTasks() {
  const config = readConfig();
  const times = Array.isArray(config.runTimes) && config.runTimes.length ? config.runTimes : ["20:30"];
  const cmdPath = writeTaskWrapper();
  const results = [];
  for (const t of times) {
    const name = taskName(t);
    const r = await schtasks([
      "/Create", "/F", "/SC", "DAILY", "/ST", t,
      "/TN", name, "/TR", `"${cmdPath}"`,
    ]);
    results.push({ name, time: t, ok: r.ok, message: r.ok ? "已注册" : r.err.slice(0, 200) });
  }
  return results;
}

async function removeTasks() {
  const config = readConfig();
  const times = Array.isArray(config.runTimes) && config.runTimes.length ? config.runTimes : ["20:30"];
  const results = [];
  for (const t of times) {
    const name = taskName(t);
    const r = await schtasks(["/Delete", "/F", "/TN", name]);
    results.push({ name, ok: r.ok });
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;

  // 只允许本机访问
  if (p === "/" || p === "/index.html") {
    try {
      const html = fs.readFileSync(path.join(HERE, "ui.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end("ui.html 缺失");
    }
    return;
  }

  if (p === "/api/state") {
    const config = readConfig();
    const lastRun = readJson(LAST_RUN_FILE);
    const lastCourse = readJson(LAST_COURSE_FILE);
    return json(res, 200, {
      ok: true,
      config: {
        ...config,
        token: config.token ? "(已配置)" : "",
        // 密码不回明文：只标记是否已配置，前端据此决定输入框显示
        zhjwPasswordConfigured: !!config.zhjwPassword,
        zhjwPassword: "",
      },
      tokenMasked: maskToken(config.token),
      defaults: { ...DEFAULTS, token: "" },
      running: state.running,
      lastMessage: state.lastMessage,
      startedAt: state.startedAt,
      lastRun,
      lastCourse,
      tasks: await taskStatus(),
      dataDir: DATA_DIR,
      configFile: CONFIG_FILE,
    });
  }

  if (p === "/api/config" && req.method === "POST") {
    const body = await readBody(req);
    const next = writeConfig(body.patch || {});
    return json(res, 200, { ok: true, config: { ...next, token: next.token ? "(已配置)" : "" } });
  }

  if (p === "/api/run" && req.method === "POST") {
    const body = await readBody(req);
    const config = readConfig();
    // 根据评课途径自动分派：zhjw 走 run-zhjw.mjs，wjiaowu/auto 走 run-once.mjs
    const isZhjw = String(config.channel || "wjiaowu") === "zhjw";
    const script = isZhjw ? "run-zhjw.mjs" : "run-once.mjs";
    const extra = [];
    if (body.dryRun) extra.push("--dry-run");
    if (isZhjw) {
      // 把当前 zhjw 模式显式传下去，避免脚本内部读 config.mode 造成模式错乱
      const zm = String(config.zhjwMode || "browser");
      if (zm === "keyboard-mouse") extra.push("--keyboard-mouse");
      else if (zm === "http") extra.push("--http");
      else extra.push("--browser");
    }
    const result = await runNodeScript(script, extra, "eval");
    return json(res, 200, { ok: result.ok, data: { ...result, source: isZhjw ? "zhjw" : "wjiaowu" } });
  }

  if (p === "/api/course" && req.method === "POST") {
    const body = await readBody(req);
    const config = readConfig();
    const channel = String(config.channel || "wjiaowu");
    const extra = body.dryRun ? ["--dry-run"] : [];
    // 按当前渠道分派：zhjw 走浏览器 UI 点击版；wjiaowu/auto 走微信 Token 版
    const isZhjw = channel === "zhjw";
    const script = isZhjw ? "run-zhjw.mjs" : "run-course.mjs";
    if (isZhjw) extra.push("--course");
    const result = await runNodeScript(script, extra, "course");
    return json(res, 200, {
      ok: result.ok,
      data: { ...result, source: isZhjw ? "zhjw" : channel === "auto" ? "auto(wjiaowu)" : channel },
    });
  }

  if (p === "/api/zhjw/run" && req.method === "POST") {
    const body = await readBody(req);
    const extra = [];
    if (body.dryRun) extra.push("--dry-run");
    if (body.http === true) extra.push("--http");
    if (body.keyboardMouse === true) extra.push("--keyboard-mouse");
    const result = await runNodeScript("run-zhjw.mjs", extra, "zhjw");
    return json(res, 200, { ok: result.ok, data: result });
  }

  if (p === "/api/zhjw/check" && req.method === "POST") {
    const result = await runNodeScript("run-zhjw.mjs", ["--check"], "zhjw-check");
    return json(res, 200, { ok: result.ok, data: result });
  }

  if (p === "/api/token/scan" && req.method === "POST") {
    try {
      return json(res, 200, { ok: true, data: await scanTokens() });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  if (p === "/api/token/refresh" && req.method === "POST") {
    const r = await runNodeScript("run-once.mjs", ["--refresh-token"], "token");
    const scanned = await scanTokens().catch(() => null);
    return json(res, 200, {
      ok: r.ok,
      data: { output: r.output || "", best: scanned && scanned.best ? scanned.best : null },
    });
  }

  if (p === "/api/task" && req.method === "POST") {
    const body = await readBody(req);
    if (body.action === "install") {
      const results = await installTasks();
      writeConfig({ systemTask: true });
      return json(res, 200, { ok: results.every((r) => r.ok), data: results });
    }
    if (body.action === "remove") {
      const results = await removeTasks();
      writeConfig({ systemTask: false });
      return json(res, 200, { ok: true, data: results });
    }
    return json(res, 400, { ok: false, error: "action 只能是 install / remove" });
  }

  if (p === "/api/quit" && req.method === "POST") {
    if (state.running) {
      return json(res, 409, { ok: false, error: "正在执行 " + state.running + "，等它跑完再退出" });
    }
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }

  if (p === "/api/log") {
    try {
      const text = fs.existsSync(RUN_LOG) ? fs.readFileSync(RUN_LOG, "utf8") : "";
      const lines = text.trim().split(/\r?\n/).slice(-60).join("\n");
      return json(res, 200, { ok: true, log: lines });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message });
    }
  }

  return json(res, 404, { ok: false, error: "未知接口" });
});

server.listen(PORT, HOST, () => {
  console.log(`独立版控制台已启动：http://${HOST}:${PORT}`);
  console.log(`配置：${CONFIG_FILE}`);
});
