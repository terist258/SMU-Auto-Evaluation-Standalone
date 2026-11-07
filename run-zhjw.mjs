/**
 * 独立版：跑一轮 zhjw.smu.edu.cn 评课（账号密码 + ONNX 验证码）。
 *
 * 用法：
 *   node run-zhjw.mjs              # 正式提交（随堂评课）
 *   node run-zhjw.mjs --dry-run    # 只走流程不提交（核对）
 *   node run-zhjw.mjs --check      # 只打印配置
 *   node run-zhjw.mjs --course     # 期末评课程（走 UI 点击，与随堂评课分开）
 *   node run-zhjw.mjs --jitter     # 先随机等 0~runJitterMinutes 分钟（计划任务用）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, ensureDataDir, RUN_LOG, LAST_COURSE_FILE } from "./lib/config.mjs";
import { ZhjwBrowserClient } from "./lib/zhjw-browser.mjs";
import { ZhjwClient } from "./lib/zhjw-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = new Set(process.argv.slice(2));
const forceDryRun = args.has("--dry-run");
const wantCheck = args.has("--check");
const wantHttpArg = args.has("--http"); // 强制纯 HTTP 模式
const wantKeyboardMouseArg = args.has("--keyboard-mouse"); // 强制全程键鼠模拟
const wantBrowserArg = args.has("--browser"); // 强制浏览器键鼠模拟
const wantCourseArg = args.has("--course"); // 期末评课程（走 UI 点击，不走随堂评课）
const wantJitter = args.has("--jitter"); // 先随机等待

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    ensureDataDir();
    fs.appendFileSync(RUN_LOG, line + "\n", "utf8");
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

async function main() {
  const startedAtAll = Date.now();
  log("info", `=== 开始运行（${new Date().toISOString()}）===`);
  const config = readConfig();

  if (wantCheck) {
    console.log("配置文件：zhjw 渠道");
    console.log(JSON.stringify({
      channel: config.channel,
      zhjwEnabled: config.channel === "zhjw" || config.channel === "auto",
      zhjwAccount: config.zhjwAccount || "(空)",
      zhjwPassword: config.zhjwPassword ? "(已配置)" : "(空)",
      zhjwMaxAttempts: config.zhjwMaxAttempts,
      zhjwRetryDelayMinutes: config.zhjwRetryDelayMinutes,
    }, null, 2));
    return 0;
  }

  // 启用判断：channel 选 zhjw 或 auto 即视为启用（不再依赖独立的 zhjwEnabled 字段）
  const channel = String(config.channel || "wjiaowu");
  if (channel !== "zhjw" && channel !== "auto") {
    log("warn", `channel=${channel}，未启用 zhjw 渠道，请在「评课途径」里选 zhjw 或 auto`);
    return 2;
  }

  if (!config.zhjwAccount || !config.zhjwPassword) {
    log("error", "zhjw 账号或密码未配置，请在设置中填写统一身份认证账号密码");
    return 2;
  }

  if (wantJitter) await sleepJitter(config.runJitterMinutes);

  // 期末评课程：走 ZhjwBrowserClient.runCourse()（全程 UI 点击），与随堂评课分开
  if (wantCourseArg) {
    log("info", `开始 zhjw 期末评课程（账号：${config.zhjwAccount}，试运行：${forceDryRun}）`);
    const client = new ZhjwBrowserClient({
      account: config.zhjwAccount,
      password: config.zhjwPassword,
      log: log,
      config: config,
    });
    try {
      const result = await client.runCourse({ dryRun: forceDryRun });
      log(result.ok ? "info" : "error", `${result.ok ? "✅" : "❌"} ${result.message || ""}`);
      try {
        ensureDataDir();
        fs.writeFileSync(
          LAST_COURSE_FILE,
          JSON.stringify(
            {
              ok: !!result.ok,
              dryRun: !!forceDryRun,
              evaluated: result.evaluated || 0,
              pending: result.pending || 0,
              message: result.message || "",
              details: result.details || [],
              source: "zhjw",
              finishedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          "utf8"
        );
      } catch {}
      return result.ok ? 0 : 1;
    } catch (err) {
      log("error", `zhjw 评课程异常：${err.message}`);
      return 1;
    }
  }

  // 模式优先级：命令行 --http/--keyboard-mouse/--browser > 配置 zhjwMode（独立版）/ mode（插件版） > 默认 browser
  const modeValue = config.zhjwMode || config.mode || "browser";
  const explicitMode = wantHttpArg ? "http" : wantKeyboardMouseArg ? "keyboard-mouse" : wantBrowserArg ? "browser" : "";
  const useHttp = explicitMode ? explicitMode === "http" : String(modeValue) === "http";
  const useKeyboardMouse = explicitMode ? explicitMode === "keyboard-mouse" : String(modeValue) === "keyboard-mouse";
  log("info", `开始 zhjw 评课（账号：${config.zhjwAccount}，试运行：${forceDryRun}，模式：${useHttp ? "纯 HTTP" : useKeyboardMouse ? "全程键鼠模拟" : "浏览器键鼠模拟"}）`);

  // 把解析后的模式显式写进 client 配置，避免 client 内部再读 config.mode 造成模式错乱
  const effectiveMode = useHttp ? "http" : useKeyboardMouse ? "keyboard-mouse" : "browser";
  const clientConfig = { ...config, zhjwMode: effectiveMode };

  const ClientClass = useHttp ? ZhjwClient : ZhjwBrowserClient;
  const client = new ClientClass({
    account: config.zhjwAccount,
    password: config.zhjwPassword,
    log: log,
    config: clientConfig,
  });

  try {
    const result = await client.run({
      maxAttempts: config.zhjwMaxAttempts || 3,
      dryRun: forceDryRun,
    });

    log(result.ok ? "info" : "error", result.message);
    log("info", `=== 运行结束，总耗时 ${((Date.now() - startedAtAll) / 1000).toFixed(1)} 秒 ===`);

    if (!result.ok) {
      return 1;
    }
    return 0;
  } catch (err) {
    log("error", `zhjw 评课异常：${err.message}`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`致命错误：${err.message}`);
    process.exit(1);
  });
