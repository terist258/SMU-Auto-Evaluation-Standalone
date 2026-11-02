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
// Python 兜底路径：从用户目录动态推导，不硬编码任何本机路径
const PYTHON_FALLBACKS = (() => {
  const list = [];
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python"));
  roots.push(path.join(os.homedir(), "AppData", "Local", "Programs", "Python"));
  for (const root of roots) {
    for (const ver of ["Python313", "Python312", "Python311", "Python310"]) {
      list.push(path.join(root, ver, "python.exe"));
    }
  }
  list.push(path.join(os.homedir(), "miniconda3", "python.exe"));
  list.push(path.join(os.homedir(), "anaconda3", "python.exe"));
  return list;
})();

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
async function humanClick(frameOrPage, locator, log) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 8000 });
  } catch {}
  await sleep(rand(150, 400));
  const box = await locator.boundingBox();
  if (!box) {
    // 元素在 DOM 里但不可见，尝试 Playwright 原生 click
    try {
      await locator.click({ timeout: 3000 });
      await sleep(rand(3000, 5000));
      return;
    } catch {}
    // 再兜底：用 JS 强制触发 click 事件（绕过可见性检查）
    try {
      await locator.evaluate((el) => el.click());
      await sleep(rand(3000, 5000));
      return;
    } catch (evaluateErr) {
      throw new Error(`元素不可见，原生点击和 JS 强制点击均失败：${evaluateErr.message}`);
    }
  }
  const x = box.x + box.width / 2 + rand(-3, 3);
  const y = box.y + box.height / 2 + rand(-3, 3);
  const mouse = frameOrPage.mouse || frameOrPage.page.mouse;
  await mouse.move(x, y, { steps: rand(8, 18) });
  await sleep(rand(80, 260));
  await mouse.down();
  await sleep(rand(45, 130));
  await mouse.up();
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

  /** 是否全程键鼠模拟：登录后不发页面内 fetch，全部靠点击页面控件完成评课 */
  get useKeyboardMouseMode() {
    const mode = this.config.mode !== undefined ? this.config.mode : this.config.zhjwMode;
    return String(mode || "browser") === "keyboard-mouse";
  }

  async run({ maxAttempts = 3, dryRun = false } = {}) {
    if (this.useKeyboardMouseMode) {
      this.log("info", "=== zhjw 渠道（全程键鼠模拟，登录后全部靠点击页面，不发页面内 fetch）开始 ===");
      return this.runKeyboardMouse({ maxAttempts, dryRun });
    }
    this.log("info", `=== zhjw 渠道（浏览器键鼠登录 + 页面内 fetch 评课，模式：${this.useBrowserMode ? "browser" : "http"}）开始 ===`);

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

  /** 全程键鼠模拟：登录后全部靠点击页面控件，不发任何页面内 fetch */
  async runKeyboardMouse({ maxAttempts = 3, dryRun = false } = {}) {
    try {
      await this.launch();

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.log("info", `第 ${attempt}/${maxAttempts} 次尝试`);
        try {
          await this.login();

          // 进入评课列表页（若登录后未自动跳转，手动点进去）
          await this.gotoEvalListPage();

          // 从页面 DOM 读取待评课程（键鼠模拟下不调用接口）
          const courses = await this.readPendingCoursesFromPage();
          if (courses.length === 0) {
            this.log("info", "页面中未发现待评价的课程");
            return { ok: true, evaluated: 0, pending: 0, message: "没有待评价的课程" };
          }

          this.log("info", `页面中发现 ${courses.length} 门待评价课程`);
          let evaluated = 0;
          for (const c of courses) {
            if (dryRun) {
              this.log("info", `[试运行] 将评课：${c.kcmc || c.teaxm} ${c.kcdm || ""}`);
              evaluated++;
              continue;
            }
            const ok = await this.evaluateCourseByKeyboardMouse(c);
            if (ok) {
              evaluated++;
              this.log("info", `✅ 已评课：${c.kcmc || c.teaxm} ${c.kcdm || ""}`);
            } else {
              this.log("warn", `❌ 评课失败：${c.kcmc || c.teaxm} ${c.kcdm || ""}`);
            }
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

  /** 登录后进入评课列表页：优先等待页面自带的评课入口，若无则点常见菜单 */
  async gotoEvalListPage() {
    const url = this.page.url();
    if (url.includes("/new/student/ktpj")) {
      this.log("info", "已在评课列表页");
      this.listUrl = this.page.url();
      return;
    }
    // 尝试点常见的教务菜单入口（需根据实际页面选择器微调）
    const candidateSelectors = [
      'text=随堂评价',
      'text=评教评价',
      'text=学生评教',
      'text=评价',
      'a[href*="ktpj"]',
    ];
    let clicked = false;
    for (const sel of candidateSelectors) {
      try {
        const loc = this.page.locator(sel).first();
        if (await loc.count() > 0 && (await loc.isVisible())) {
          await humanClick(this.page, loc, this.log);
          await sleep(rand(2500, 4000));
          clicked = true;
          break;
        }
      } catch {}
    }
    if (!clicked) {
      // 兜底：直接 goto 评课页
      this.log("info", "未找到页面评课入口，直接打开评课列表页");
      await this.page.goto("https://zhjw.smu.edu.cn/new/student/ktpj", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await sleep(rand(2500, 4000));
    }
    this.listUrl = this.page.url();
  }

  /** 从页面 DOM 读取待评课程列表（键鼠模拟下不调用接口）。
   *  kind="ktpj" 随堂评课；kind="course" 期末评课程（按钮文案放宽到「评教」）。
   *  ⚠️ 选择器按正方新版常见结构：表格行 / van-cell 列表，均需真机微调。 */
  async readPendingCoursesFromPage(kind = "ktpj") {
    const courses = [];
    const buttonWords = kind === "course" ? /评教|评价|未评/ : /评价|未评/;
    try {
      const scanContainer = async (loc) => {
        const n = await loc.count().catch(() => 0);
        if (n === 0) return null;
        const filtered = loc.filter({ hasText: buttonWords });
        const cnt = await filtered.count().catch(() => 0);
        return cnt > 0 ? filtered : null;
      };
      // 先搜主页面
      let rows = null;
      for (const sel of ["tr", ".van-cell", ".list-item", ".course-item", ".pj-list-item"]) {
        rows = await scanContainer(this.page.locator(sel));
        if (rows) break;
      }
      // 主页面没找到，再搜所有 iframe
      if (!rows) {
        try {
          const frames = this.page.frames();
          for (const frame of frames) {
            if (frame === this.page.mainFrame()) continue;
            for (const sel of ["tr", ".van-cell", ".list-item", ".course-item", ".pj-list-item"]) {
              rows = await scanContainer(frame.locator(sel));
              if (rows) break;
            }
            if (rows) break;
          }
        } catch {}
      }
      if (!rows) {
        rows = this.page.locator("tr").filter({ hasText: buttonWords });
      }
      const count = await rows.count();
      this.log("info", `列表中发现 ${count} 行含「${kind === "course" ? "评教/评价" : "评价"}」的条目`);

      for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        const text = ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 300) continue;
        const btn = row.getByText(buttonWords).first();
        if ((await btn.count().catch(() => 0)) === 0) continue;
        courses.push({
          kcmc: text.slice(0, 80),
          teaxm: "",
          kcdm: "",
          __text: text,
          __evalButton: btn,
          __rowIndex: i,
        });
      }
    } catch (err) {
      this.log("warn", `从页面读取课程列表失败：${err.message}`);
    }
    return courses;
  }

  /** 进入期末评课程（学生评教）页面：
   *  1) 优先在当前登录后的页面里找「评教/课程评价」菜单并点击（键鼠模拟真实切换）
   *  2) 兜底：直接 goto 候选地址（用户确认的 kcpj 放最前，config.zhjwCourseUrl 最高优先）
   *  每步都打印当前 URL、标题、body 片段，方便定位失败原因。 */
  /** 进入期末评课程（学生评教）页面：两级导航
   *  第1级：欢迎页 → 点顶部标签「评价信息」（页面实际就是这个文案）；
   *  第2级：评价信息页 → 左侧/面板里点「期末评课程 / 课程评价」子项；
   *  兜底：直接 goto 候选地址（xspj 放最前，上次能进去；config.zhjwCourseUrl 最高优先）。
   *  每步都打印当前 URL、标题、可见链接文案，方便定位失败原因。 */
  async gotoCourseEvalPage() {
    const configured = String(this.config.zhjwCourseUrl || "").trim();
    const candidates = [];
    if (configured) candidates.push(configured);
    candidates.push(
      "https://zhjw.smu.edu.cn/new/student/xspj",
      "https://zhjw.smu.edu.cn/new/student/kcpj", // 用户亲口确认的期末评教页地址（2026-11-01）
      "https://zhjw.smu.edu.cn/new/student/xspjtb",
      "https://zhjw.smu.edu.cn/new/student/pj"
    );

    const diag = async () => {
      const u = this.page.url();
      const t = await this.page.title().catch(() => "(无标题)");
      const infos = [`主页面: ${u} | 标题: ${t}`];
      try {
        const frames = this.page.frames();
        for (const frame of frames) {
          if (frame === this.page.mainFrame()) continue;
          try {
            const fu = frame.url();
            const ft = await frame.title().catch(() => "(无标题)");
            const ftext = ((await frame.innerText("body").catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 120);
            infos.push(`iframe[${fu}] | 标题: ${ft} | 片段: ${ftext}`);
          } catch {}
        }
      } catch {}
      return { url: u, title: t, infos };
    };

    /** 判断当前页面是不是真正的评教列表页（主页面或任一 iframe 里） */
    const isCourseEvalPage = async () => {
      const checkText = (text) => /课程名称|任课教师|课程评教|评教列表|待评教|评价课程/.test(text);
      const u = this.page.url();
      if (/kcpj|xspj|xspjtb|^\/new\/student\/(pj|kcpj)/i.test(u)) return true;
      const mainText = ((await this.page.innerText("body").catch(() => "")) || "").replace(/\s+/g, " ");
      if (checkText(mainText)) return true;
      try {
        const frames = this.page.frames();
        for (const frame of frames) {
          if (frame === this.page.mainFrame()) continue;
          try {
            const fu = frame.url();
            if (/kcpj|xspj|xspjtb|^\/new\/student\/(pj|kcpj)/i.test(fu)) return true;
            const ftext = ((await frame.innerText("body").catch(() => "")) || "").replace(/\s+/g, " ");
            if (checkText(ftext)) return true;
          } catch {}
        }
      } catch {}
      return false;
    };

    /** 把页面里所有可见的链接文案打印出来，便于人工确认入口名（含 iframe 内） */
    const listVisibleLinks = async () => {
      try {
        const names = [];
        const scan = async (loc, tag) => {
          try {
            const n = await loc.count().catch(() => 0);
            for (let i = 0; i < n; i++) {
              const txt = ((await loc.nth(i).innerText().catch(() => "")) || "").trim();
              if (txt) names.push(`${tag}:${txt}`);
            }
          } catch {}
        };
        // 主文档：所有链接/按钮
        const mainLinks = this.page.locator('a, button, [role="link"], [role="button"]');
        await scan(mainLinks, "主文档");
        // iframe 内
        const frames = this.page.frames();
        for (const frame of frames) {
          if (frame === this.page.mainFrame()) continue;
          try {
            const links = frame.locator('a, button, [role="link"], [role="button"]');
            await scan(links, "[iframe]");
          } catch {}
        }
        // 专门再搜所有含「评价」「评教」字样的元素（不管标签）
        try {
          const evalEls = this.page.locator(':has-text("评价"), :has-text("评教")');
          const en = await evalEls.count().catch(() => 0);
          for (let i = 0; i < en; i++) {
            const txt = ((await evalEls.nth(i).innerText().catch(() => "")) || "").trim();
            if (txt && /评价|评教/.test(txt)) names.push(`含评: ${txt}`);
          }
        } catch {}
        this.log("info", `页面可见链接/按钮文案：${names.join(" | ")}`);
      } catch {}
    };

    /** 在主文档或 iframe 中查找可见文案为 name 的元素，返回 { frame, locator } 或 null */
    const findElementByText = async (name) => {
      // 先找主文档
      try {
        const loc = this.page.locator(`text=${name}`).first();
        if ((await loc.count()) > 0) {
          return { frame: null, locator: loc };
        }
      } catch {}
      // 再找所有 iframe
      try {
        const frames = this.page.frames();
        for (const frame of frames) {
          if (frame === this.page.mainFrame()) continue;
          const loc = frame.locator(`text=${name}`).first();
          if ((await loc.count()) > 0) {
            return { frame, locator: loc };
          }
        }
      } catch {}
      return null;
    };

    // 0) 当前页面可能已经在评教页
    const cur = await diag();
    this.log("info", `当前页面：${cur.url} | 标题：${cur.title}`);
    if (await isCourseEvalPage()) {
      this.listUrl = cur.url;
      this.log("info", `当前页已是课程评价页：${cur.url}`);
      return;
    }

    // 1) 第1级：在当前页面找「评价信息」入口并点击（含 iframe）
    this.log("info", "第1级：在当前页面寻找「评价信息」入口并点击");
    await listVisibleLinks();
    let enteredInfoPage = false;
    for (const name of ["评价信息", "学生评教", "课程评价", "评教", "期末评教", "教学评价", "期末评课程"]) {
      try {
        const found = await findElementByText(name);
        if (!found) continue;
        const { frame, locator } = found;
        const frameLabel = frame ? "(iframe)" : "(主文档)";
        this.log("info", `找到入口「${name}」${frameLabel}，尝试点击`);
        await humanClick(frame || this.page, locator, this.log);
        await sleep(rand(3000, 5000));
        const after = await diag();
        this.log("info", `点击后：${after.url} | 标题：${after.title}`);
        await listVisibleLinks();
        if (await isCourseEvalPage()) {
          this.listUrl = after.url;
          this.log("info", `已进入课程评价页：${after.url}`);
          return;
        }
        enteredInfoPage = true;
        break; // 点进「评价信息」页后，继续找第2级
      } catch (err) {
        this.log("warn", `点击入口「${name}」失败：${err.message}`);
      }
    }

    // 2) 第2级：在评价信息页里找子项「期末评课程 / 课程评价 / 随堂评价」（含 iframe）
    if (enteredInfoPage) {
      this.log("info", "第2级：在评价信息页寻找子项「期末评课程 / 课程评价 / 随堂评价」并点击");
      for (const name of ["期末评课程", "课程评价", "期末评教", "学生评教", "随堂评价", "结课评价", "评教"]) {
        try {
          const found = await findElementByText(name);
          if (!found) continue;
          const { frame, locator } = found;
          const frameLabel = frame ? "(iframe)" : "(主文档)";
          this.log("info", `找到子项「${name}」${frameLabel}，尝试点击`);
          await humanClick(frame || this.page, locator, this.log);
          await sleep(rand(3000, 5000));
          const after = await diag();
          this.log("info", `点击后：${after.url} | 标题：${after.title}`);
          if (await isCourseEvalPage()) {
            this.listUrl = after.url;
            this.log("info", `已通过子项「${name}」进入课程评价页：${after.url}`);
            return;
          }
        } catch (err) {
          this.log("warn", `点击子项「${name}」失败：${err.message}`);
        }
      }
    }

    // 3) 兜底：直接 goto 候选地址
    for (const url of candidates) {
      try {
        this.log("info", `尝试直接打开课程评价页：${url}`);
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(rand(2500, 4000));
        const after = await diag();
        if (await isCourseEvalPage()) {
          this.listUrl = after.url;
          this.log("info", `已打开课程评价页：${after.url}`);
          return;
        }
        this.log("warn", `直接打开 ${url} 未进入评教页（当前：${after.url}），继续下一个候选`);
      } catch (err) {
        this.log("warn", `打开失败：${err.message}`);
      }
    }

    throw new Error(
      "找不到期末评课程入口：已尝试点「评价信息」+ 子项「期末评课程/课程评价」+ 直接打开候选地址，均未进入评教页。请在浏览器里手动打开评教页，复制地址栏完整网址填入配置「课程评价页地址」后重试。"
    );
  }

  /** 期末评课程（zhjw 渠道）：进入评教页 → 逐门点开 → 打星/选项/建议 → 提交。 */
  async runCourse({ dryRun = false } = {}) {
    const details = [];
    let evaluated = 0;
    try {
      await this.launch();
      await this.login();
      await this.gotoCourseEvalPage();

      const courses = await this.readPendingCoursesFromPage("course");
      if (courses.length === 0) {
        this.log("info", "页面中未发现待评价的课程（可能未开放或已评完）");
        return { ok: true, evaluated: 0, pending: 0, message: "没有可评价的课程", details };
      }

      const maxPerRun = Math.max(1, Number(this.config.courseMaxPerRun) || 20);
      this.log("info", `页面中发现 ${courses.length} 门待评价课程（本次上限 ${maxPerRun} 门）`);

      for (const c of courses) {
        if (evaluated >= maxPerRun) break;
        if (dryRun) {
          this.log("info", `[试运行] 将评价课程：${c.kcmc}`);
          details.push({ name: c.kcmc, status: "dry-run" });
          evaluated++;
          continue;
        }
        const ok = await this.evaluateCourseUi(c, { allFiveStars: this.config.courseAllFiveStars !== false });
        details.push({ name: c.kcmc, status: ok ? "ok" : "error" });
        if (ok) {
          evaluated++;
          this.log("info", `✅ 已评价：${c.kcmc}`);
        } else {
          this.log("warn", `❌ 评价失败：${c.kcmc}`);
        }
        await sleep(rand(8000, 20000));
      }

      return {
        ok: evaluated > 0 || details.length === 0,
        evaluated,
        pending: details.length - evaluated,
        message: details.length === 0
          ? "没有可评价的课程"
          : `评课程完成：成功 ${evaluated} 门，共处理 ${details.length} 门`,
        details,
      };
    } catch (err) {
      this.log("error", `评课程异常：${err.message}`);
      return {
        ok: false,
        evaluated,
        pending: details.length,
        message: `评课程异常：${err.message}`,
        details,
      };
    } finally {
      await this.close();
    }
  }

  /** 随堂评课：评单门课（UI 点击）。2 四星 + 2 五星 = 90 分。 */
  async evaluateCourseByKeyboardMouse(course) {
    return this.evaluateCourseUi(course, { allFiveStars: false });
  }

  /** 通用：用 UI 点击方式评价单门课程。
   *  allFiveStars=true 时全部五星（期末评课程，满分）；false 时按 fourStarCount 掺四星（随堂评课）。 */
  async evaluateCourseUi(course, opts = {}) {
    const btn = course.__evalButton;
    if (!btn || (await btn.count().catch(() => 0)) === 0) {
      this.log("warn", "未找到该课程的「评价」按钮，跳过");
      return false;
    }
    await humanClick(this.page, btn, this.log);
    await sleep(rand(3000, 5000));

    const questions = await this.readQuestionsFromPage();
    if (questions.length === 0) {
      this.log("warn", "评课页面未发现题目（选择器可能不匹配）");
      await this.goBackToList();
      return false;
    }
    const nRating = questions.filter((q) => q.hasRating).length;
    const nRadio = questions.filter((q) => q.hasRadio).length;
    const nText = questions.filter((q) => q.hasText).length;
    this.log("info", `页面中发现 ${questions.length} 道题（星级 ${nRating}、单选 ${nRadio}、文本 ${nText}）`);

    // 星级方案
    const ratings = [];
    const ratingCount = nRating;
    const fourStarCount = Math.min(Number(this.config.fourStarCount || 2), ratingCount);
    for (let i = 0; i < ratingCount; i++) {
      ratings.push(opts.allFiveStars ? 5 : i < fourStarCount ? 4 : 5);
    }
    if (!opts.allFiveStars && this.config.varyFourStar !== false && ratingCount > 0) {
      for (let i = ratings.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ratings[i], ratings[j]] = [ratings[j], ratings[i]];
      }
    }

    let ratingIdx = 0;
    for (const q of questions) {
      if (q.hasRating) {
        await this.clickRating(q, ratings[ratingIdx++]);
      } else if (q.hasRadio) {
        await this.clickRadioPrefer(q, ["否", "无职务", "按要求完成了学习", "课程学时30%以内"]);
      } else if (q.hasText) {
        if (Math.random() < Number(this.config.suggestionEmptyRate || 0)) {
          this.log("info", "建议栏留空");
        } else {
          const txt = await this.pickSuggestionText();
          await this.fillSuggestionText(q, txt);
        }
      }
      await sleep(rand(1200, 3500)); // 读题间隔，模拟真人
    }

    const ok = await this.submitForm();
    await this.goBackToList();
    return ok;
  }

  /** 点提交 → 处理确认弹窗 → 读提示。返回是否成功。 */
  async submitForm() {
    const submitSel = this.page
      .locator('button:has-text("提交"), input[type=submit], button[type=submit], .van-tabbar-item:has-text("提交")')
      .first();
    if ((await submitSel.count().catch(() => 0)) === 0) {
      this.log("warn", "未找到提交按钮");
      return false;
    }
    await humanClick(this.page, submitSel, this.log);
    await sleep(rand(1800, 3200));

    const confirmSel = this.page
      .locator('button:has-text("确定"), button:has-text("确认"), .van-dialog__confirm, .dialog-btn-confirm, .layui-layer-btn0')
      .first();
    if ((await confirmSel.count().catch(() => 0)) > 0 && (await confirmSel.isVisible().catch(() => false))) {
      await humanClick(this.page, confirmSel, this.log);
      await sleep(rand(2000, 3500));
    }

    const toast = await this.page
      .evaluate(() => {
        const el = document.querySelector(
          ".van-toast__text, .van-notify__text, .layui-layer-content, .toast, .el-message"
        );
        return el ? (el.innerText || "").trim() : "";
      })
      .catch(() => "");
    if (toast) this.log("info", `提示：${toast}`);
    const ok = !toast || /成功/.test(toast);
    this.log(ok ? "info" : "warn", ok ? "提交成功" : `提交结果未知（${toast}）`);
    return ok;
  }

  /** 从页面 DOM 读取题目（键鼠模拟用）。
   *  依次尝试常见题目容器；命中即用，并标注每题是否含星级/单选/文本框。
   *  ⚠️ 选择器需根据实际页面微调。 */
  async readQuestionsFromPage() {
    const questions = [];
    try {
      const containers = ['.question', '.pj-item', '.tk-item', '[data-txdm]', '.pjtm', '.subject-item'];
      let qEls = null;
      let usedSel = "";
      for (const sel of containers) {
        const loc = this.page.locator(sel);
        if ((await loc.count().catch(() => 0)) > 0) {
          qEls = loc;
          usedSel = sel;
          break;
        }
      }
      if (!qEls) {
        this.log("warn", "未匹配到题目容器（.question / [data-txdm] / .pj-item 等均未命中）");
        return questions;
      }
      const count = await qEls.count();
      this.log("info", `题目容器命中「${usedSel}」，共 ${count} 个`);
      for (let i = 0; i < count; i++) {
        const el = qEls.nth(i);
        const txdmRaw = await el.getAttribute("data-txdm").catch(() => "");
        const txdm = txdmRaw ? parseInt(txdmRaw, 10) : 0;
        const zbmc = ((await el
          .locator("h3, .question-title, .title, .subject-title")
          .first()
          .innerText()
          .catch(() => "")) || "").trim();
        const hasRating = (await el.locator(".raty, [data-wtxm], .star, .van-rate").count().catch(() => 0)) > 0;
        const hasRadio = (await el.locator("input[type=radio], .van-radio").count().catch(() => 0)) > 0;
        const hasText = (await el.locator("textarea, input[type=text]").count().catch(() => 0)) > 0;
        questions.push({ txdm, zbmc, hasRating, hasRadio, hasText, el });
      }
    } catch (err) {
      this.log("warn", `读取页面题目失败：${err.message}`);
    }
    return questions;
  }

  /** 点击第 star 颗星（4 或 5）。依次尝试常见星级控件写法。 */
  async clickRating(q, star) {
    const el = q.el;
    const candidates = [
      `[data-value="${star}"]`,
      `.star-${star}`,
      `[aria-label="${star}星"]`,
      `.van-rate__item:nth-child(${star})`,
    ];
    for (const sel of candidates) {
      const loc = el.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
        await humanClick(this.page, loc, this.log);
        return true;
      }
    }
    // 兜底：按顺序点第 star 个可点击项
    const items = el.locator(".raty img, .star, [role=radio], .van-rate__item");
    const n = await items.count().catch(() => 0);
    if (n >= star) {
      await humanClick(this.page, items.nth(star - 1), this.log);
      return true;
    }
    this.log("warn", `星级控件未找到（想点 ${star} 星，命中 ${n} 个可点项）`);
    return false;
  }

  /** 优先点含指定文案的单选项；都不匹配则点最后一个（通常是「否」）。 */
  async clickRadioPrefer(q, preferred = []) {
    const el = q.el;
    for (const word of preferred) {
      const loc = el.getByText(word, { exact: false }).first();
      if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
        await humanClick(this.page, loc, this.log);
        return true;
      }
    }
    const radios = el.locator("input[type=radio], .van-radio");
    const n = await radios.count().catch(() => 0);
    if (n > 0) {
      await humanClick(this.page, radios.nth(n - 1), this.log);
      return true;
    }
    this.log("warn", "单选题未找到可点选项");
    return false;
  }

  /** 从建议池抽一条文本（兼容字符串/数组） */
  async pickSuggestionText() {
    const poolRaw = this.config.suggestionPool || "";
    const pool = Array.isArray(poolRaw)
      ? poolRaw
      : typeof poolRaw === "string"
        ? poolRaw.split("\n").map((s) => s.trim()).filter(Boolean)
        : [];
    if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];
    return this.config.suggestion || "课程内容充实，教学认真负责，受益匪浅。";
  }

  /** 填建议文本。⚠️ 选择器需根据实际页面微调。 */
  async fillSuggestionText(q, text) {
    const el = q.el;
    const textarea = el.locator('textarea').first();
    if ((await textarea.count()) > 0) {
      await humanType(this.page, textarea, text);
      return;
    }
    const input = el.locator('input[type=text]').first();
    if ((await input.count()) > 0) {
      await humanType(this.page, input, text);
    }
  }

  /** 返回列表页（随堂评课回 ktpj，期末评课程回进入时的课程评价页）。 */
  async goBackToList() {
    const target = this.listUrl || "https://zhjw.smu.edu.cn/new/student/ktpj";
    try {
      await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(rand(1200, 2200));
      // 回退后如果不在列表页，再 goto 兜底
      if (!this.page.url().includes(target.replace(/^https?:\/\/[^/]+/, ""))) {
        await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      }
    } catch {
      await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    }
    await sleep(rand(2000, 3500));
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
