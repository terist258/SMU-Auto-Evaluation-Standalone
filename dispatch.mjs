/**
 * 计划任务统一入口：每次运行时读取当前配置的「评课途径」(channel)，
 * 分派到对应的评课脚本。这样在配置面板里改了渠道，**不用重新注册计划任务**，
 * 下一次定时触发就按新渠道跑。
 *
 *   channel = wjiaowu → run-once.mjs --jitter（微信 Token 随堂评价）
 *   channel = zhjw    → run-zhjw.mjs --jitter（账号密码 + 验证码）
 *   channel = auto    → 先跑 wjiaowu，退出码非 0（失败）再跑 zhjw
 *
 * 用法：node dispatch.mjs [--jitter]
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readConfig } from "./lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
// 除了 channel 判断用不到，其余参数（--jitter / --dry-run / --http …）原样透传给子脚本
const extraArgs = process.argv.slice(2);

function run(script) {
  return new Promise((resolve) => {
    console.log(`[dispatch] 子脚本启动：${script}`);
    const startedAt = Date.now();
    const child = spawn(NODE, [path.join(HERE, script), ...extraArgs], {
      cwd: HERE,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (err) => {
      console.log(`[dispatch] 子脚本 ${script} 启动失败：${err && err.message ? err.message : err}`);
      resolve(1);
    });
    child.on("exit", (code) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[dispatch] 子脚本结束：${script}，退出码 ${code}，耗时 ${elapsed} 秒`);
      resolve(code === null ? 1 : code);
    });
  });
}

const channel = String(readConfig().channel || "wjiaowu");
console.log(`[dispatch] 评课途径 channel=${channel}，开始分派`);

let code;
if (channel === "zhjw") {
  code = await run("run-zhjw.mjs");
} else if (channel === "auto") {
  code = await run("run-once.mjs");
  if (code !== 0) {
    console.log("[dispatch] wjiaowu 渠道未成功，自动尝试 zhjw 渠道");
    code = await run("run-zhjw.mjs");
  }
} else {
  code = await run("run-once.mjs");
}

process.exit(code);
