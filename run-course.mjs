/**
 * 独立版：期末「评课程」（整学期一次，手动触发）。
 *
 * 用法：
 *   node run-course.mjs              # 正式提交所有未评价的课
 *   node run-course.mjs --dry-run    # 只点不提交（核对分数）
 */
import fs from "node:fs";
import path from "node:path";
import { LAST_COURSE_FILE, RUN_LOG, readConfig, ensureDataDir } from "./lib/config.mjs";

const args = new Set(process.argv.slice(2));
const forceDryRun = args.has("--dry-run");

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    ensureDataDir();
    fs.appendFileSync(RUN_LOG, line + "\n", "utf8");
  } catch {}
}

const config = readConfig();
const cfg = { ...config };
if (forceDryRun) cfg.skipSubmit = true;

log("info", `开始评课程（${cfg.skipSubmit ? "试运行，不提交" : "正式提交"}）`);

const { runCourseRun } = await import("./browser.js");
const raw = await runCourseRun(cfg, log);

const result = {
  ok: !!raw.ok,
  dryRun: !!cfg.skipSubmit,
  evaluated: raw.evaluated || 0,
  pending: raw.pending || 0,
  message: raw.message || "",
  details: raw.details || [],
  finishedAt: new Date().toISOString(),
};
try {
  ensureDataDir();
  fs.writeFileSync(LAST_COURSE_FILE, JSON.stringify(result, null, 2), "utf8");
} catch {}
log(result.ok ? "info" : "error", `${result.ok ? "✅" : "❌"} ${result.message}`);
process.exit(result.ok ? 0 : 1);
