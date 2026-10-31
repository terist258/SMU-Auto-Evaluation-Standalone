/**
 * zhjw.smu.edu.cn 评课客户端（Node.js 原生实现，无第三方浏览器依赖）
 *
 * 参考 rep1ace/SMU-Auto-Evaluation 的登录 + 评课流程：
 *   1. GET  https://uis.smu.edu.cn/imageServlet.do        # 获取验证码图片
 *   2. POST https://uis.smu.edu.cn/login/login.do          # 账号密码 + 验证码登录，返回 ticket
 *   3. GET  https://zhjw.smu.edu.cn/new/ssoLogin?ticker=.. # 跳转到教务系统，获取会话 Cookie
 *   4. POST https://zhjw.smu.edu.cn/new/student/ktpj/xsktpjData  # 查询待评课程
 *   5. GET  https://zhjw.smu.edu.cn/new/student/ktpj/showXsktpjwj.page  # 解析评课参数
 *   6. POST https://zhjw.smu.edu.cn/new/student/ktpj/savePj      # 提交评分
 *
 * 验证码识别：调用 Python 子进程 tools/captcha_solver.py（ONNX 推理）
 */

import https from "node:https";
import http from "node:http";
import crypto from "node:crypto";
import querystring from "node:querystring";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON_EXE || "python";
const CAPTCHA_SOLVER = path.join(HERE, "..", "tools", "captcha_solver.py");
const PYTHON_FALLBACKS = [
  "C:\\Users\\31253\\AppData\\Local\\Programs\\Python\\Python313\\python.exe",
];

// ---------- 会话 Cookie 管理（无第三方库，手动维护） ----------

class CookieJar {
  constructor() {
    this.cookies = new Map(); // name -> value
  }

  setFromSetCookie(header) {
    if (!header) return;
    const parts = String(header).split("; ");
    if (parts.length === 0) return;
    const kv = parts[0].split("=", 2);
    if (kv.length === 2) {
      this.cookies.set(kv[0].trim(), kv[1].trim());
    }
  }

  getCookieString() {
    return [...this.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

// ---------- HTTP 请求 ----------

function request(options, body) {
  return new Promise((resolve, reject) => {
    const isHttps = options.protocol === "https:";
    const lib = isHttps ? https : http;
    const reqOptions = {
      hostname: options.hostname,
      port: options.port || (isHttps ? 443 : 80),
      path: options.path,
      method: options.method || "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Connection": "keep-alive",
        // 把已收集的会话 Cookie 带上，保证验证码/登录在同一会话内关联
        ...(options.cookieJar && options.cookieJar.getCookieString()
          ? { Cookie: options.cookieJar.getCookieString() }
          : {}),
        ...(options.headers || {}),
      },
      ...(isHttps ? { rejectUnauthorized: false } : {}),
    };

    if (body) {
      const b = typeof body === "string" ? body : JSON.stringify(body);
      reqOptions.headers["Content-Length"] = Buffer.byteLength(b);
      if (!reqOptions.headers["Content-Type"]) {
        reqOptions.headers["Content-Type"] = "application/json";
      }
    }

    const req = lib.request(reqOptions, (res) => {
      if (res.headers["set-cookie"]) {
        for (const sc of res.headers["set-cookie"]) {
          options.cookieJar.setFromSetCookie(sc);
        }
      }

      if (options.binary) {
        // 二进制响应（验证码图片）：用 Buffer 累加，避免 UTF-8 解码损坏
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        return;
      }

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("请求超时"));
    });

    if (body) {
      const b = typeof body === "string" ? body : JSON.stringify(body);
      req.write(b);
    }
    req.end();
  });
}

function get(url, cookieJar, extraHeaders = {}, binary = false) {
  const u = new URL(url);
  return request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      cookieJar,
      binary,
      headers: { ...extraHeaders },
    },
    null
  );
}

function post(url, cookieJar, formData, extraHeaders = {}) {
  const u = new URL(url);
  const body = querystring.stringify(formData || {});
  return request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      cookieJar,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...extraHeaders,
      },
    },
    body
  );
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

// ---------- MD5 ----------

function md5(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

/** 解析教务系统的课程结束时间（如 "2027-01-0809:55:00"），失败返回 null */
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
      const [, y, mo, d, h, mi, sec] = m;
      const t = new Date(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(sec || 0)
      ).getTime();
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

// ---------- zhjw 客户端 ----------

export class ZhjwClient {
  constructor({ account, password, log }) {
    this.account = account;
    this.password = password;
    this.log = log || (() => {});
    this.jar = new CookieJar();
  }

  /** 完整流程：登录 → 跳转 → 查询待评课程 → 提交所有 */
  async run({ maxAttempts = 3, dryRun = false } = {}) {
    this.log("info", "=== zhjw 渠道开始 ===");

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
          await this.sleep(15 * 1000);
        }
      }
    }
    return { ok: false, evaluated: 0, pending: 0, message: `已达最大尝试次数 ${maxAttempts}` };
  }

  /** 登录 uis.smu.edu.cn，获得 ticket，跳转 zhjw */
  async login() {
    // 1. 获取验证码图片（binary 模式，避免 PNG 被 UTF-8 解码损坏）
    const captchaResp = await get(
      "https://uis.smu.edu.cn/imageServlet.do",
      this.jar,
      {
        Referer: "https://uis.smu.edu.cn/login.jsp?outLine=0",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-origin",
      },
      true
    );
    if (captchaResp.statusCode !== 200) {
      throw new Error(`获取验证码失败 HTTP ${captchaResp.statusCode}`);
    }

    // 保存验证码图片（body 已是 Buffer）
    const captchaPath = path.join(os.tmpdir(), `smueval-zhjw-captcha-${Date.now()}.png`);
    fs.writeFileSync(captchaPath, Buffer.isBuffer(captchaResp.body) ? captchaResp.body : Buffer.from(captchaResp.body, "binary"));

    // 2. 用 ONNX 识别验证码
    const solved = await solveCaptchaImage(captchaPath, this.log);
    fs.unlink(captchaPath, () => {});
    if (!solved.ok || !solved.code) {
      throw new Error("验证码识别失败");
    }

    // 3. POST 登录
    const passwordMd5 = md5(this.password);
    const loginResp = await post(
      "https://uis.smu.edu.cn/login/login.do",
      this.jar,
      {
        loginName: this.account,
        password: passwordMd5,
        randcodekey: solved.code,
        locationBrowser: "谷歌浏览器[Chrome]",
        appid: "3550176",
        redirect: "https://zhjw.smu.edu.cn/new/ssoLogin",
        strength: 3,
      },
      {
        Origin: "https://uis.smu.edu.cn",
        Referer:
          "https://uis.smu.edu.cn/login.jsp?redirect=https%3A%2F%2Fzhjw.smu.edu.cn%2Fnew%2FssoLogin",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      }
    );

    let result;
    try {
      result = JSON.parse(loginResp.body);
    } catch {
      throw new Error(`登录响应非 JSON：${loginResp.body.slice(0, 200)}`);
    }

    if (result.success === false || !result.ticket) {
      throw new Error(`登录失败：${result.msg || result.message || "未知错误"}`);
    }
    this.log("info", "统一身份认证登录成功");

    // 4. 跳转到 zhjw（携带 ticket，获得教务系统 Cookie）
    await get(
      `https://zhjw.smu.edu.cn/new/ssoLogin?ticket=${encodeURIComponent(result.ticket)}`,
      this.jar,
      {
        Referer: "https://uis.smu.edu.cn/login.jsp?redirect=https%3A%2F%2Fzhjw.smu.edu.cn%2Fnew%2FssoLogin",
        "Upgrade-Insecure-Requests": "1",
      }
    );
    this.log("info", "已跳转至教务系统，会话 Cookie 已获取");
  }

  /** 查询待评价课程（按今天+昨天日期过滤 + 分页拉全 + 只保留未评 pjdm 为空 + 已上完的课） */
  async fetchPendingCourses(lookbackDays = 1) {
    const courses = [];
    // 生成今天、昨天等日期（rep1ace 用 jsrq 参数按日查询）
    const dates = [];
    for (let offset = 0; offset <= lookbackDays; offset++) {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }

    for (const jsrq of dates) {
      let page = 1;
      for (;;) {
        const resp = await post(
          "https://zhjw.smu.edu.cn/new/student/ktpj/xsktpjData",
          this.jar,
          {
            jsrq,
            page: String(page),
            rows: "60",
            sort: "jsrq, jcdm2",
            order: "desc",
          },
          {
            Origin: "https://zhjw.smu.edu.cn",
            Referer: "https://zhjw.smu.edu.cn/new/student/ktpj",
            "X-Requested-With": "XMLHttpRequest",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "Accept": "application/json, text/javascript, */*; q=0.01",
          }
        );

        let data;
        try {
          data = JSON.parse(resp.body);
        } catch {
          this.log("warn", `查询响应非 JSON：${resp.body.slice(0, 300)}`);
          break;
        }

        const rows = data?.rows || data?.data || [];
        if (!Array.isArray(rows)) break;
        if (data?.success === false || String(data?.state || "").toLowerCase().startsWith("error")) {
          this.log("warn", `查询返回失败状态：${resp.body.slice(0, 300)}`);
          break;
        }

        for (const r of rows) {
          // 只保留未评价的（pjdm 为空）
          if (r.pjdm !== "" && r.pjdm !== null && r.pjdm !== undefined) continue;
          courses.push({
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
            jksj: r.jksj || "",   // 课程结束时间（YYYY-MM-DDHH:mm:ss）
            jsrq: r.jsrq || "",
          });
        }

        const total = Number(data?.total);
        if (!rows.length || (Number.isFinite(total) && courses.length >= total)) break;
        if (total === undefined || total === null || Number.isNaN(total)) {
          if (rows.length < 60) break;
        }
        page += 1;
        if (page > 20) break;
      }
    }

    // 去重（按 teadm+dgksdm+wjdm 唯一键），并过滤「还没上完的课」（jksj 未来）
    const now = Date.now();
    const seen = new Set();
    const unique = [];
    for (const c of courses) {
      const key = `${c.teadm}|${c.dgksdm}|${c.wjdm || c.ktpj}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 课程未结束（jksj 在将���）→ 跳过，不提前评
      const endAt = parseJksj(c.jksj);
      if (endAt !== null && endAt > now) continue;
      unique.push(c);
    }
    return unique;
  }

  /** 单门课程评课：解析页面 → 构造参数 → 提交 */
  async evaluateCourse(course) {
    // 1. 打开评课页面，解析参数
    const evalUrl =
      `https://zhjw.smu.edu.cn/new/student/ktpj/showXsktpjwj.page` +
      `?pjlxdm=${encodeURIComponent(course.pjlxdm || "6")}` +
      `&teadm=${encodeURIComponent(course.teadm)}` +
      `&dgksdm=${encodeURIComponent(course.dgksdm)}` +
      `&wjdm=${encodeURIComponent(course.ktpj || course.wjdm)}`;

    const pageResp = await get(evalUrl, this.jar, {
      Referer: "https://zhjw.smu.edu.cn/new/student/ktpj",
      "Upgrade-Insecure-Requests": "1",
    });
    if (pageResp.statusCode !== 200) {
      this.log("warn", `评课页面加载失败 HTTP ${pageResp.statusCode}`);
      return false;
    }

    const html = pageResp.body;

    // 2. 从 script 中提取 entss.post 参数（参考 rep1ace）
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

    // 3. 解析题目（div.question）
    const questions = this.parseQuestions(html);
    if (questions.length === 0) {
      this.log("warn", "评课页面未找到题目");
      return false;
    }

    // 4. 生成评分方案（80-90 分，参考 rep1ace）
    const ratingQuestions = questions.filter((q) => q.hasRating);
    const choiceQuestions = questions.filter((q) => q.hasRadio && q.txdm !== 3);

    const ratingCount = ratingQuestions.length;
    const ratingPlans = [];
    const scores = [25, 20, 15];
    const dtjgs = ["★★★★★", "★★★★", "★★★"];
    const optionVals = [-1, -2, -3];

    for (let five = 0; five <= ratingCount; five++) {
      for (let four = 0; four <= ratingCount - five; four++) {
        const three = ratingCount - five - four;
        const total = 25 * five + 20 * four + 15 * three;
        if (total >= 80 && total <= 90) {
          ratingPlans.push({ five, four, three, total });
        }
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

    // 5. 构造 data_list（提交的题目答案）
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

    // 6. 构造提交数据（参考 rep1ace savePj）
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

    // 7. POST 提交
    const submitResp = await post(
      "https://zhjw.smu.edu.cn/new/student/ktpj/savePj",
      this.jar,
      submitData,
      {
        Accept: "application/json, text/javascript, */*; q=0.01",
        Origin: "https://zhjw.smu.edu.cn",
        Referer: evalUrl,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "0",
      }
    );

    if (submitResp.statusCode === 200) {
      return true;
    }
    this.log("warn", `提交失败 HTTP ${submitResp.statusCode}`);
    return false;
  }

  /** 解析 HTML 中的题目 */
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
            for (const o of arr) {
              options[o.value || o.zbxmdm] = o;
            }
          } catch {}
        }
      }

      const hasRadio = qHtml.includes('type="radio"');
      let radios = [];
      if (hasRadio) {
        const radioRegex = /<input[^>]*type="radio"[^>]*value="([^"]*)"[^>]*>/gi;
        let rm;
        while ((rm = radioRegex.exec(qHtml))) {
          radios.push({ value: rm[1] });
        }
      }

      questions.push({
        txdm,
        zbdm,
        zbmc,
        hasRating,
        hasRadio,
        options,
        radios,
      });
    }

    return questions;
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
