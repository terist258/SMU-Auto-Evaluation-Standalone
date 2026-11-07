/**
 * 脱离 DSH 跑一轮随堂评价（给 Windows 计划任务用）。
 *
 * 为什么单独一个脚本：计划任务只认得"命令行"，它启动时没有 DSH Host，也就没有
 * schemastery 之类的依赖。所以这里只 import config.mjs（纯 Node，无第三方依赖）
 * 和 browser.js（只依赖 playwright-core）。
 *
 * 配置读 %LOCALAPPDATA%\smueval-bot\config.json，与配置面板是同一份文件。
 *
 * 用法：
 *   node run-once.mjs              # 立刻跑一轮
 *   node run-once.mjs --jitter     # 先随机等 0~runJitterMinutes 分钟
 *   node run-once.mjs --dry-run    # 只点不提交
 *   node run-once.mjs --check      # 只打印配置
 *   node run-once.mjs --refresh-token   # 只刷新 Token
 *   node run-once.mjs --test-notify     # 测试失败提醒
 *
 * 产物（都在 %LOCALAPPDATA%\smueval-bot\）：
 *   last-run.json  最近一次结果（面板会读它显示回执）
 *   runs.jsonl     历史记录，一行一次
 *   run.log        计划任务模式的输出日志
 */
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE,
  LAST_RUN_FILE,
  HISTORY_FILE,
  RUN_LOG,
  readConfig,
  ensureDataDir,
} from "./lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WECHAT_SCRIPT = path.join(HERE, "tools", "wechat-token.ps1");
const NOTIFY_SCRIPT = path.join(HERE, "tools", "notify.ps1");

const args = new Set(process.argv.slice(2));
const wantCheck = args.has("--check");
const forceDryRun = args.has("--dry-run");
const wantJitter = args.has("--jitter");
const wantRefreshToken = args.has("--refresh-token");
const wantTestNotify = args.has("--test-notify");

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    ensureDataDir();
    fs.appendFileSync(RUN_LOG, line + "\n", "utf8");
  } catch {}
}

/** 弹窗提醒（同步等它关，保证能看见） */
function notify(title, message, level = "error") {
  try {
    if (!fs.existsSync(NOTIFY_SCRIPT)) return;
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", NOTIFY_SCRIPT,
        "-Title", title, "-Message", message, "-Level", level, "-Seconds", "20"],
      { timeout: 60000, windowsHide: true, stdio: "ignore" }
    );
  } catch {}
}

function writeResult(result) {
  ensureDataDir();
  const record = { ...result, source: "standalone", triggeredAt: new Date().toISOString() };
  try {
    fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(record, null, 2), "utf8");
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch {}
}

async function sleepJitter(minutes) {
  const cap = Math.max(0, Math.min(180, Number(minutes) || 0));
  if (cap === 0) return 0;
  const seconds = Math.floor(Math.random() * cap * 60);
  log("info", `先随机等待 ${Math.round(seconds / 60)} 分 ${seconds % 60} 秒（上限 ${cap} 分钟）`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return seconds;
}

function runPowerShellScript(script, extraArgs = [], timeout = 300000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) {
      resolve({ err: new Error("脚本不存在：" + script), stdout: "" });
      return;
    }
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, ...extraArgs],
      { encoding: "utf8", timeout, windowsHide: true },
      (err, stdout) => resolve({ err, stdout: String(stdout || "") })
    );
  });
}

function analyze(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("{") && s.endsWith("}"))
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** 跑微信浮窗脚本换 Token，成功后返回新 token */
async function refreshTokenStandalone(config) {
  log("info", "Token 失效，尝试用微信浮窗自动续期…");
  const { err, stdout } = await runPowerShellScript(WECHAT_SCRIPT);
  const parsed = analyze(stdout);
  if (!parsed || !parsed.ok) {
    const reason = (parsed && parsed.error) || (err && err.message) || "脚本无输出";
    log("warn", `微信续期失败：${reason}`);
    notify("南医大评课助手 · Token 续期失败", reason, "error");
    return "";
  }
  log("info", `微信操作完成：${parsed.matched} @ (${parsed.clickedX},${parsed.clickedY})，关闭窗口 ${parsed.closed || 0} 个`);

  const { collectWeChatTokens, validateToken } = await import("./browser.js");
  const candidates = (collectWeChatTokens(log) || []).slice(0, 12);
  for (const token of candidates) {
    if (await validateToken(config.apiBase, token)) {
      log("info", `扫到可用 Token：${token.slice(0, 6)}…${token.slice(-4)}`);
      return token;
    }
  }
  log("warn", "微信操作完成，但没扫到有效 Token");
  return "";
}

function persistToken(token) {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    raw.token = token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), "utf8");
    log("info", "新 Token 已写回配置");
  } catch (error) {
    log("warn", `写回配置失败：${error.message}`);
  }
}

async function main() {
  const startedAtAll = Date.now();
  log("info", `=== 开始运行（${new Date().toISOString()}）===`);
  const config = readConfig();

  if (wantCheck) {
    console.log("配置文件：" + CONFIG_FILE);
    console.log(JSON.stringify({ ...config, token: config.token ? "(已配置)" : "(空，会自动读取)" }, null, 2));
    return 0;
  }

  if (wantTestNotify) {
    notify("南医大评课助手 · 测试提醒", "这是一条测试通知：评课失败时就会弹这个样子。", "error");
    log("info", "已弹出测试提醒");
    return 0;
  }

  if (wantRefreshToken) {
    const token = await refreshTokenStandalone(config);
    if (!token) return 1;
    persistToken(token);
    return 0;
  }

  if (config.enabled === false) {
    log("info", "配置里 enabled=false，跳过本次评课");
    return 0;
  }
  if (String(config.mode || "browser") !== "browser") {
    log("warn", `mode=${config.mode}，计划任务模式只支持 browser（真实浏览器点击）`);
    return 2;
  }

  if (wantJitter) await sleepJitter(config.runJitterMinutes);

  const cfg = { ...config };
  if (forceDryRun) cfg.skipSubmit = true;

  const startedAt = new Date().toISOString();
  log("info", `开始操作（${cfg.skipSubmit ? "试运行，不提交" : "正式提交"}）`);

  const { runBrowserRun } = await import("./browser.js");
  let raw = await runBrowserRun(cfg, log);

  // 计划任务模式下也要能自愈：Token 失效就自己换新的，然后补跑一次
  if (raw.tokenInvalid && !cfg.skipSubmit) {
    const fresh = await refreshTokenStandalone(cfg);
    if (fresh) {
      cfg.token = fresh;
      persistToken(fresh);
      log("info", "用新 Token 重跑一次…");
      raw = await runBrowserRun(cfg, log);
    }
  }

  const result = {
    ok: !!raw.ok,
    dryRun: !!cfg.skipSubmit,
    evaluated: raw.evaluated || 0,
    pending: raw.pending || 0,
    message: raw.message || "",
    tokenInvalid: !!raw.tokenInvalid,
    details: raw.details || [],
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  writeResult(result);
  log(result.ok ? "info" : "error", `${result.ok ? "✅" : "❌"} ${result.message || "（无说明）"}`);
  log("info", `=== 运行结束，总耗时 ${((Date.now() - startedAtAll) / 1000).toFixed(1)} 秒 ===`);
  if (!result.ok) notify("南医大评课助手 · 评课失败", result.message || "未知原因", "error");
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    log("error", `运行失败：${message}`);
    notify("南医大评课助手 · 运行失败", message, "error");
    try {
      writeResult({
        ok: false,
        dryRun: forceDryRun,
        evaluated: 0,
        pending: 0,
        message,
        tokenInvalid: false,
        details: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
    } catch {}
    process.exit(1);
  });
