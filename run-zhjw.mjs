/**
 * 独立版：跑一轮 zhjw.smu.edu.cn 评课（账号密码 + ONNX 验证码）。
 *
 * 用法：
 *   node run-zhjw.mjs              # 正式提交
 *   node run-zhjw.mjs --dry-run    # 只走流程不提交（核对）
 *   node run-zhjw.mjs --check      # 只打印配置
 *   node run-zhjw.mjs --jitter     # 先随机等 0~runJitterMinutes 分钟（计划任务用）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, ensureDataDir, RUN_LOG } from "./lib/config.mjs";
import { ZhjwBrowserClient } from "./lib/zhjw-browser.mjs";
import { ZhjwClient } from "./lib/zhjw-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = new Set(process.argv.slice(2));
const forceDryRun = args.has("--dry-run");
const wantCheck = args.has("--check");
const wantHttpArg = args.has("--http"); // 强制纯 HTTP 模式
const wantBrowserArg = args.has("--browser"); // 强制浏览器键鼠模拟
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

  // 模式优先级：命令行 --http/--browser > 配置 zhjwMode（独立版）/ mode（插件版） > 默认 browser
  const modeValue = config.zhjwMode || config.mode || "browser";
  const useHttp = wantHttpArg ? true : wantBrowserArg ? false : String(modeValue) === "http";
  log("info", `开始 zhjw 评课（账号：${config.zhjwAccount}，试运行：${forceDryRun}，模式：${useHttp ? "纯 HTTP" : "浏览器键鼠模拟"}）`);

  const ClientClass = useHttp ? ZhjwClient : ZhjwBrowserClient;
  const client = new ClientClass({
    account: config.zhjwAccount,
    password: config.zhjwPassword,
    log: log,
    config: config,
  });

  try {
    const result = await client.run({
      maxAttempts: config.zhjwMaxAttempts || 3,
      dryRun: forceDryRun,
    });

    log(result.ok ? "info" : "error", result.message);

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
