/**
 * 独立版的配置读写（不依赖 DSH、不依赖 schemastery）。
 * 配置文件放在 %LOCALAPPDATA%\smueval-bot\config.json，
 * 和 DSH 插件用同一份，这样两边切换时 Token / 结果能对上。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "smueval-bot"
);
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const LAST_RUN_FILE = path.join(DATA_DIR, "last-run.json");
export const LAST_COURSE_FILE = path.join(DATA_DIR, "last-course-run.json");
export const HISTORY_FILE = path.join(DATA_DIR, "runs.jsonl");
export const RUN_LOG = path.join(DATA_DIR, "run.log");

// ---------- zhjw 密码加密保护（与插件版 index.js 保持一致）----------
const ENC_PREFIX = "enc:";

function _encKey() {
  const material = `${os.hostname()}|${os.homedir()}`;
  return createHash("sha256").update(material).digest();
}

function encryptPassword(plain) {
  if (!plain) return "";
  const key = _encKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptPassword(enc) {
  if (!enc) return "";
  if (!enc.startsWith(ENC_PREFIX)) {
    // 兼容旧的明文/Base64 存储：直接返回
    return enc;
  }
  try {
    const data = Buffer.from(enc.slice(ENC_PREFIX.length), "base64");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const key = _encKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return "";
  }
}

export const DEFAULTS = {
  enabled: true,
  mode: "browser",
  token: "",
  apiBase: "https://wjiaowu.smu.edu.cn/dev-api",
  runTimes: ["20:30"],
  runJitterMinutes: 30,
  lookbackDays: 1,
  catchUpOnStart: true,
  dryRun: false,
  fourStarCount: 2,
  varyFourStar: false,
  fillSuggestion: true,
  suggestionEmptyRate: 0.15,
  suggestion: "课程内容充实，教学认真负责，受益匪浅。",
  suggestionPool: "",
  lateAnswer: "否",
  dutyAnswer: "无职务",
  requirementAnswer: "按要求完成了学习",
  selfStudyAnswer: "课程学时30%以内",
  maxPerRun: 10,
  courseMaxPerRun: 20,
  zhjwCourseUrl: "",
  courseAllFiveStars: true,
  headless: false,
  useRealViewport: true,
  seedProfile: true,
  readWeChatToken: true,
  showStatusBar: true,
  systemTask: false,

  // ---------- zhjw.smu.edu.cn 渠道（账号密码 + ONNX 验证码） ----------
  channel: "wjiaowu",        // "wjiaowu" | "zhjw" | "auto"
  zhjwAccount: "",           // 统一身份认证账号
  zhjwPassword: "",          // 统一身份认证密码（本地存储，Base64 编码，非加密）
  zhjwEnabled: false,        // 是否启用 zhjw 渠道（由 channel 派生：zhjw/auto 为 true，UI 不再单独暴露）
  zhjwMode: "browser",       // "browser"（浏览器键鼠模拟，推荐）| "http"（纯 HTTP）
  zhjwMaxAttempts: 3,        // 单次运行最大尝试次数（含验证码失败重试）
  zhjwRetryDelayMinutes: 15, // 验证码/登录失败后重试间隔（分钟）
};

export function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  return DATA_DIR;
}

export function readConfig() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    merged.zhjwPassword = decryptPassword(merged.zhjwPassword || "");
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function readConfigRaw() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(patch) {
  ensureDataDir();
  const current = readConfigRaw();
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
    const like = DEFAULTS[key];
    if (Array.isArray(like)) {
      if (Array.isArray(value)) {
        next[key] = value.map((v) => String(v)).filter((v) => v !== "").slice(0, 12);
      }
      continue;
    }
    if (typeof like === "boolean") {
      next[key] = value === true || value === "true";
      continue;
    }
    if (typeof like === "number") {
      const num = Number(value);
      if (Number.isFinite(num)) next[key] = num;
      continue;
    }
    if (typeof value === "string") {
      if (key === "zhjwPassword") {
        const v = value.slice(0, 4096);
        next[key] = v.startsWith(ENC_PREFIX) ? v : (v === "" ? "" : encryptPassword(v));
      } else {
        next[key] = value.slice(0, 4096);
      }
    }
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function maskToken(token) {
  const t = String(token || "");
  if (!t) return "(空)";
  if (t.length <= 10) return t.slice(0, 4) + "…";
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}
