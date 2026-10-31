/**
 * zhjw.smu.edu.cn 评课客户端 —— 浏览器键鼠模拟版
 *
 * 与纯 HTTP 版的区别：
 *  - 登录全程真实浏览器操作：打开 uis 登录页 → 验证码图片截图 → ONNX 识别
 *    → 鼠标移动轨迹点击输入框 → 逐字符键入账号/密码/验证码 → 点「登录」
 *  - 登录后的查询与提交在浏览器页面上下文内用 fetch 完成：
 *    带着真实 Cookie、真实 TLS 指纹、真实 Referer/Origin —— 比 Node HTTP 真实得多
 *  - 不使用任何自动化特征标记（--disable-blink-features=AutomationControlled）
 *
 * 流程（沿用 rep1ace 的接口语义）：
 *   1. 浏览器打开 uis 登录页，验证码 ONNX 识别，键鼠模拟登录
 *   2. 浏览器内 goto zhjw 首页 / 评课页，确认会话
 *   3. 页面内 fetch xsktpjData 查询待评课程（今天+昨天、未评、已下课）
 *   4. 逐门课页面内 fetch showXsktpjwj.page 解析参数，再 fetch savePj 提交
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON_EXE || "python";
const CAPTCHA_SOLVER = path.join(HERE, "..", "tools", "captcha_solver.py");
const PYTHON_FALLBACKS = [
  "C:\\Users\\31253\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
];

// ---------- 工具函数 ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function expandEnv(p) {
  if (!p) return "";
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
}

const BROWSER_CANDIDATES = [
  "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
  "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
  "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe",
  "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
  "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
  "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
];

function resolveBrowser(config, log) {
  const explicit = config?.browserPath || config?.edgePath;
  if (explicit) {
    const p = expandEnv(explicit);
    if (fs.existsSync(p)) return p;
    log?.("warn", `配置的浏览器路径不存在：${p}，改为自动探测`);
  }
  for (const raw of BROWSER_CANDIDATES) {
    const p = expandEnv(raw);
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error("未找到可用的浏览器（Edge/Chrome）");
}

/** 带人类特征的点击 */
async function humanClick(page, locator, log) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 8000 });
  } catch {}
  await sleep(rand(150, 400));
  const box = await locator.boundingBox();
  if (!box) throw new Error("元素不可见，无法点击");
  const x = box.x + box.width / 2 + rand(-3, 3);
  const y = box.y + box.height / 2 + rand(-3, 3);
  await page.mouse.move(x, y, { steps: rand(8, 18) });
  await sleep(rand(80, 260));
  await page.mouse.down();
  await sleep(rand(45, 130));
  await page.mouse.up();
  await sleep(rand(120, 400));
}

/** 带人类特征的输入：点击聚焦 → 清空 → 逐字符键入 */
async function humanType(page, locator, text) {
  await humanClick(page, locator, null);
  try {
    await locator.fill("");
  } catch {}
  for (const ch of String(text)) {
    await page.keyboard.type(ch);
    await sleep(rand(40, 160));
  }
}

// ---------- 验证码识别 ----------

function runPythonSolverWith(pythonExe, imagePath, log) {
  return new Promise((resolve) => {
    execFile(
      pythonExe,
      [CAPTCHA_SOLVER, imagePath],
      { encoding: "utf8", timeout: 60000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, code: "", error: err.message });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.ok && parsed.code) {
            log?.("info", `验证码识别结果：${parsed.code}`);
            resolve({ ok: true, code: parsed.code });
          } else {
            log?.("warn", `验证码识别失败：${parsed.error || "未知错误"}`);
            resolve({ ok: false, code: "" });
          }
        } catch {
          log?.("warn", `验证码识别输出解析失败：${stdout}`);
          resolve({ ok: false, code: "" });
        }
      }
    );
  });
}

async function solveCaptchaImage(imagePath, log) {
  let lastErr = null;
  for (const py of [PYTHON, ...PYTHON_FALLBACKS]) {
    try {
      return await runPythonSolverWith(py, imagePath, log);
    } catch (err) {
      lastErr = err;
      log?.("warn", `Python 路径 ${py} 不可用：${err.message}`);
    }
  }
  log?.("warn", `所有 Python 路径均不可用，最后错误：${lastErr?.message}`);
  return { ok: false, code: "" };
}

// ---------- 课程时间解析 ----------

function parseJksj(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  for (const pattern of [
    /^(\d{4})-(\d{2})-(\d{2})(\d{2}):(\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/,
  ]) {
    const m = s.match(pattern);
    if (m) {
      const t = new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6] || 0)
      ).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

// ---------- 浏览器版 zhjw 客户端 ----------

export class ZhjwBrowserClient {
  constructor({ account, password, log, config }) {
    this.account = account;
    this.password = password;
    this.log = log || (() => {});
    this.config = config || {};
    this.ctx = null;
    this.page = null;
    this.browserPath = "";
  }

  /** 解析浏览器模式：插件版用 config.mode，独立版用 config.zhjwMode */
  get useBrowserMode() {
    const mode = this.config.mode !== undefined ? this.config.mode : this.config.zhjwMode;
    return String(mode || "browser") === "browser";
  }

  async run({ maxAttempts = 3, dryRun = false } = {}) {
    this.log("info", `=== zhjw 渠道（浏览器键鼠模拟，模式：${this.useBrowserMode ? "browser" : "http"}）开始 ===`);

    try {
      await this.launch();

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.log("info", `第 ${attempt}/${maxAttempts} 次尝试`);
        try {
          await this.login();
          const courses = await this.fetchPendingCourses();
          if (courses.length === 0) {
            this.log("info", "没有待评价的课程");
            return { ok: true, evaluated: 0, pending: 0, message: "没有待评价的课程" };
          }

          this.log("info", `共 ${courses.length} 门待评价课程`);
          let evaluated = 0;
          for (const c of courses) {
            if (dryRun) {
              this.log("info", `[试运行] 将评课：${c.teaxm} ${c.kcdm}`);
              evaluated++;
              continue;
            }
            const ok = await this.evaluateCourse(c);
            if (ok) {
              evaluated++;
              this.log("info", `✅ 已评课：${c.teaxm} ${c.kcdm}`);
            } else {
              this.log("warn", `❌ 评课失败：${c.teaxm} ${c.kcdm}`);
            }
            // 课程之间随机停顿，避免连续快速提交
            await sleep(rand(8000, 20000));
          }

          return {
            ok: true,
            evaluated,
            pending: courses.length - evaluated,
            message: `评课完成：成功 ${evaluated} 门，共处理 ${courses.length} 门`,
          };
        } catch (err) {
          this.log("warn", `第 ${attempt} 次尝试失败：${err.message}`);
          if (attempt < maxAttempts) {
            // 失败后刷新页面重新登录
            try {
              await this.page.goto("about:blank").catch(() => {});
            } catch {}
            await sleep(15 * 1000);
          }
        }
      }
      return { ok: false, evaluated: 0, pending: 0, message: `已达最大尝试次数 ${maxAttempts}` };
    } finally {
      await this.close();
    }
  }

  async launch() {
    const { chromium } = await import("playwright-core");
    this.browserPath = resolveBrowser(this.config, this.log);
    const profileDir = path.join(os.tmpdir(), "smueval-zhjw-browser-profile");

    this.log("info", `启动浏览器：${this.browserPath}`);

    this.ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath: this.browserPath,
      headless: this.config.headless === true,
      viewport: null,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: ["--disable-blink-features=AutomationControlled"],
    });

    this.page = this.ctx.pages()[0] || (await this.ctx.newPage());
    this.page.setDefaultTimeout(30000);
  }

  async close() {
    try {
      if (this.ctx) await this.ctx.close();
    } catch {}
    this.ctx = null;
    this.page = null;
  }

  /** 截图并识别当前验证码；识别失败抛错 */
  async captureAndSolveCaptcha() {
    const captchaPath = path.join(os.tmpdir(), `smueval-zhjw-cap-${Date.now()}.png`);
    const img = this.page.locator("#image").first();
    await img.waitFor({ state: "visible", timeout: 15000 });
    await img.screenshot({ path: captchaPath });
    const solved = await solveCaptchaImage(captchaPath, this.log);
    fs.unlink(captchaPath, () => {});
    if (!solved.ok || !solved.code) throw new Error("验证码识别失败");
    return solved;
  }

  /** 刷新验证码：优先点验证码图片「换一张」；图片没变则整页重载登录页 */
  async refreshCaptcha(loginUrl) {
    const img = this.page.locator("#image").first();
    try {
      if (await img.count()) {
        const beforeSrc = await img.getAttribute("src").catch(() => "");
        await humanClick(this.page, img, null);
        await sleep(rand(700, 1300));
        const afterSrc = await img.getAttribute("src").catch(() => "");
        if (afterSrc && afterSrc !== beforeSrc) {
          this.log?.("info", "已点击验证码图片刷新");
          return true;
        }
      }
    } catch {}
    // 点图不刷新（或元素异常）→ 整页重载，验证码和输入框都会重置
    try {
      this.log?.("info", "点击刷新无效，重新加载登录页");
      await this.page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(rand(1500, 2800));
      return true;
    } catch {
      return false;
    }
  }

  /** 等待登录结果：离开登录页即成功；出现验证码/密码错误提示即失败 */
  async waitLoginOutcome(beforeUrl, seconds = 25) {
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      const url = this.page.url();
      if (url !== beforeUrl && !url.includes("login.jsp")) {
        return { ok: true };
      }
      const errText = await this.page
        .evaluate(() => {
          const el = document.querySelector(".alert, .error, .error-message, #loginError");
          return el ? el.textContent.trim().slice(0, 100) : "";
        })
        .catch(() => "");
      if (errText && /验证码|密码|错误|失败/.test(errText)) {
        return { ok: false, error: errText };
      }
    }
    return { ok: false, error: "登录后未跳转（可能是验证码或密码错误）" };
  }

  /** 浏览器键鼠模拟登录（验证码失败自动刷新重输，最多 3 次） */
  async login() {
    const LOGIN_URL =
      "https://uis.smu.edu.cn/login.jsp?redirect=https%3A%2F%2Fzhjw.smu.edu.cn%2Fnew%2FssoLogin";
    const MAX_CAPTCHA_TRIES = 3;

    this.log("info", "打开统一身份认证登录页…");
    await this.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(rand(2500, 4500));

    let loggedIn = false;
    let lastErr = "";

    for (let capTry = 1; capTry <= MAX_CAPTCHA_TRIES && !loggedIn; capTry++) {
      try {
        // 第 2 次起：先刷新验证码、清空验证码输入框（humanType 会先清空）
        if (capTry > 1) {
          this.log("info", `上次验证码/登录失败，刷新验证码后重试（${capTry}/${MAX_CAPTCHA_TRIES}）`);
          await this.refreshCaptcha(LOGIN_URL);
          // 重载后可能已不在登录页（极少见），拉回来
          if (!this.page.url().includes("login.jsp")) {
            await this.page
              .goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
              .catch(() => {});
            await sleep(rand(1500, 2500));
          }
        }

        // 1. 截图 + 识别验证码
        const solved = await this.captureAndSolveCaptcha();

        // 2. 键鼠模拟填写（账号 → 密码 → 验证码；账号密码每次都重填最稳）
        this.log("info", "键鼠模拟填写登录表单…");
        await humanType(this.page, this.page.locator("#loginName"), this.account);
        await sleep(rand(300, 800));
        await humanType(this.page, this.page.locator("#password"), this.password);
        await sleep(rand(300, 800));
        await humanType(this.page, this.page.locator("#randcodekey"), solved.code);
        await sleep(rand(500, 1200));

        // 3. 点击登录
        this.log("info", "点击「登录」…");
        const before = this.page.url();
        await humanClick(this.page, this.page.locator("#AccountLogin").first(), this.log);

        // 4. 等待结果
        const outcome = await this.waitLoginOutcome(before, 25);
        if (outcome.ok) {
          loggedIn = true;
          break;
        }
        lastErr = outcome.error || "登录未跳转";
        this.log("warn", `第 ${capTry} 次登录失败：${lastErr}`);
      } catch (err) {
        lastErr = err.message;
        this.log("warn", `第 ${capTry} 次尝试失败：${err.message}`);
      }
    }
    if (!loggedIn) {
      throw new Error(`登录失败：${lastErr || "已达最大验证码重试次数"}`);
    }
    this.log("info", "统一身份认证登录成功（浏览器已跳转）");

    // 5. 确保进入 zhjw
    const url = this.page.url();
    if (!url.includes("zhjw.smu.edu.cn")) {
      this.log("info", "跳转到教务系统…");
      await this.page.goto("https://zhjw.smu.edu.cn/new/student/ktpj", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await sleep(rand(2500, 4000));
    }
    this.log("info", "已进入教务系统评课页");

    // 6. 验证会话有效：页面内调用一个轻量接口
    const ok = await this.page
      .evaluate(async () => {
        try {
          const res = await fetch("/new/student/ktpj/xsktpjData", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: "page=1&rows=1",
            credentials: "include",
          });
          const text = await res.text();
          return res.ok && text.includes("rows");
        } catch {
          return false;
        }
      })
      .catch(() => false);
    if (!ok) {
      throw new Error("登录后访问评课接口失败（会话可能无效）");
    }
    this.log("info", "评课接口会话校验通过");
  }

  /** 浏览器页面内查询待评课程 */
  async fetchPendingCourses(lookbackDays = 1) {
    const dates = [];
    for (let offset = 0; offset <= lookbackDays; offset++) {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      dates.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      );
    }

    let allRows = [];
    for (const jsrq of dates) {
      let pageNo = 1;
      for (;;) {
        const data = await this.page
          .evaluate(
            async (payload) => {
              const res = await fetch("/new/student/ktpj/xsktpjData", {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                  "X-Requested-With": "XMLHttpRequest",
                },
                body: new URLSearchParams(payload).toString(),
                credentials: "include",
              });
              return await res.json();
            },
            { jsrq, page: String(pageNo), rows: "60", sort: "jsrq, jcdm2", order: "desc" }
          )
          .catch(() => null);

        if (!data || !Array.isArray(data.rows)) break;
        allRows = allRows.concat(data.rows.map((r) => ({ ...r, __jsrq: jsrq })));

        const total = Number(data.total);
        if (!data.rows.length || (Number.isFinite(total) && allRows.length >= total)) break;
        if (!Number.isFinite(total) && data.rows.length < 60) break;
        pageNo += 1;
        if (pageNo > 20) break;
      }
    }

    // 过滤：未评（pjdm 为空）+ 已下课（jksj 已过）+ 去重
    const now = Date.now();
    const seen = new Set();
    const unique = [];
    for (const r of allRows) {
      if (r.pjdm !== "" && r.pjdm !== null && r.pjdm !== undefined) continue;
      const key = `${r.teadm}|${r.dgksdm}|${r.wjdm || r.ktpj}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const endAt = parseJksj(r.jksj);
      if (endAt !== null && endAt > now) continue;
      unique.push({
        teadm: r.teadm || "",
        dgksdm: r.dgksdm || "",
        ktpj: r.wjdm || r.ktpj || "",
        wjdm: r.wjdm || "",
        xnxqdm: r.xnxqdm || "",
        pjlxdm: r.pjlxdm || "6",
        kcrwdm: r.kcrwdm || "",
        kcptdm: r.kcptdm || "",
        kcdm: r.kcdm || "",
        jxhjdm: r.jxhjdm || "",
        teaxm: r.teaxm || "",
        kcmc: r.kcmc || "",
        jksj: r.jksj || "",
      });
    }
    return unique;
  }

  /** 浏览器页面内：打开评课页 → 解析参数 → 构造评分 → 提交 */
  async evaluateCourse(course) {
    const evalUrl =
      `/new/student/ktpj/showXsktpjwj.page?pjlxdm=${encodeURIComponent(course.pjlxdm || "6")}` +
      `&teadm=${encodeURIComponent(course.teadm)}` +
      `&dgksdm=${encodeURIComponent(course.dgksdm)}` +
      `&wjdm=${encodeURIComponent(course.ktpj || course.wjdm)}`;

    // 1. 页面内 fetch 评课页 HTML
    const html = await this.page
      .evaluate(async (url) => {
        const res = await fetch(url, { credentials: "include" });
        return await res.text();
      }, evalUrl)
      .catch(() => "");
    if (!html) {
      this.log("warn", "评课页面加载失败");
      return false;
    }

    // 2. 提取 entss.post 参数
    const scriptMatch = html.match(/entss\.post[\s\S]{0,2000}/);
    if (!scriptMatch) {
      this.log("warn", "评课页面未找到提交参数");
      return false;
    }
    const fieldRegex = /(\w+):'([^']+)'/g;
    const data = {};
    let m;
    while ((m = fieldRegex.exec(scriptMatch[0]))) {
      data[m[1]] = m[2];
    }
    if (!data.teadm || !data.wjdm) {
      this.log("warn", "评课页面缺少必要参数（teadm/wjdm）");
      return false;
    }

    // 3. 解析题目
    const questions = this.parseQuestions(html);
    if (questions.length === 0) {
      this.log("warn", "评课页面未找到题目");
      return false;
    }

    // 4. 生成 80-90 分评分方案
    const ratingQuestions = questions.filter((q) => q.hasRating);
    const ratingCount = ratingQuestions.length;
    const ratingPlans = [];
    const scores = [25, 20, 15];
    const dtjgs = ["★★★★★", "★★★★", "★★★"];
    const optionVals = [-1, -2, -3];

    for (let five = 0; five <= ratingCount; five++) {
      for (let four = 0; four <= ratingCount - five; four++) {
        const three = ratingCount - five - four;
        const total = 25 * five + 20 * four + 15 * three;
        if (total >= 80 && total <= 90) ratingPlans.push({ five, four, three, total });
      }
    }
    if (ratingPlans.length === 0) {
      this.log("warn", `无法生成 80-90 分的评分方案（${ratingCount} 题）`);
      return false;
    }

    const plan = ratingPlans[Math.floor(Math.random() * ratingPlans.length)];
    const ratings = [];
    for (let i = 0; i < plan.five; i++) ratings.push(0);
    for (let i = 0; i < plan.four; i++) ratings.push(1);
    for (let i = 0; i < plan.three; i++) ratings.push(2);
    for (let i = ratings.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ratings[i], ratings[j]] = [ratings[j], ratings[i]];
    }

    // 5. 构造 data_list
    const dataList = [];
    let ratingIdx = 0;
    let scoreTotal = 0;
    for (const q of questions) {
      const answer = { txdm: q.txdm, zbdm: q.zbdm, zbmc: q.zbmc };
      if (q.hasRating) {
        const val = ratings[ratingIdx++];
        answer.zbxmdm = q.options?.[optionVals[val]]?.zbxmdm || "";
        answer.fz = scores[val];
        answer.dtjg = dtjgs[val];
        scoreTotal += scores[val];
      } else if (q.hasRadio && q.txdm !== 3) {
        const radios = q.radios || [];
        answer.zbxmdm = radios[radios.length - 1]?.value || "";
        answer.fz = 0;
        answer.dtjg = "否";
      } else {
        continue;
      }
      dataList.push(answer);
    }
    if (dataList.length === 0) {
      this.log("warn", "没有可提交的题目");
      return false;
    }

    // 6. 页面内 fetch 提交
    const submitData = {
      xnxqdm: data.xnxqdm || course.xnxqdm || "",
      pjlxdm: data.pjlxdm || course.pjlxdm || "6",
      teadm: course.teadm,
      teabh: course.teadm,
      teaxm: data.teaxm || course.teaxm || "",
      wjdm: data.wjdm || course.wjdm || "",
      kcrwdm: data.kcrwdm || course.kcrwdm || "",
      kcptdm: data.kcptdm || course.kcptdm || "",
      kcdm: data.kcdm || course.kcdm || "",
      dgksdm: course.dgksdm,
      jxhjdm: data.jxhjdm || course.jxhjdm || "",
      wtpf: scoreTotal,
      pfsm: "",
      dt: JSON.stringify(dataList, null, 2),
    };

    const result = await this.page
      .evaluate(
        async (payload) => {
          const res = await fetch("/new/student/ktpj/savePj", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: new URLSearchParams(payload).toString(),
            credentials: "include",
          });
          return { status: res.status, text: (await res.text()).slice(0, 200) };
        },
        { ...submitData, dt: JSON.stringify(dataList, null, 2) }
      )
      .catch(() => ({ status: 0, text: "" }));

    if (result.status === 200) {
      this.log("info", `提交成功（${course.teaxm} ${course.kcdm}），总分 ${scoreTotal}`);
      return true;
    }
    this.log("warn", `提交失败 HTTP ${result.status}：${result.text}`);
    return false;
  }

  parseQuestions(html) {
    const questions = [];
    const qRegex = /<div[^>]*class="[^"]*question[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let qm;
    while ((qm = qRegex.exec(html))) {
      const qHtml = qm[1];
      const txdmMatch = qHtml.match(/data-txdm="(\d+)"/);
      const zbdmMatch = qHtml.match(/data-zbdm="([^"]*)"/);
      const titleMatch = qHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      const txdm = txdmMatch ? parseInt(txdmMatch[1], 10) : 0;
      const zbdm = zbdmMatch ? zbdmMatch[1] : "";
      const zbmc = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
      const hasRating = qHtml.includes('class="raty"');

      let options = {};
      if (hasRating) {
        const wtxmMatch = qHtml.match(/data-wtxm="([^"]*)"/);
        if (wtxmMatch) {
          try {
            const arr = JSON.parse(wtxmMatch[1]);
            for (const o of arr) options[o.value || o.zbxmdm] = o;
          } catch {}
        }
      }

      const hasRadio = qHtml.includes('type="radio"');
      let radios = [];
      if (hasRadio) {
        const radioRegex = /<input[^>]*type="radio"[^>]*value="([^"]*)"[^>]*>/gi;
        let rm;
        while ((rm = radioRegex.exec(qHtml))) radios.push({ value: rm[1] });
      }

      questions.push({ txdm, zbdm, zbmc, hasRating, hasRadio, options, radios });
    }
    return questions;
  }
}
