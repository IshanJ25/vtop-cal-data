require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const bitmaps = require("./bitmaps");

puppeteer.use(StealthPlugin());

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const compact = v => String(v ?? "").replace(/\s+/g, " ").trim();
const lower = v => compact(v).toLowerCase();

function writeJsonAtomically(filePath, data) {
  const tmp = `${filePath}.tmp-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function getISTTime() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return [
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
  ].join("::");
}

// ─── Config ───────────────────────────────────────────────────────────────────

async function getConfig() {
  const defaults = {
    sem: "Winter", year: "2025",
    fallback_first_instructional_day: null,
    fallback_last_instructional_day_theory: null,
    fallback_last_instructional_day_lab: null
  };
  try {
    const raw = fs.readFileSync(path.join(__dirname, "curr_sem.txt"), "utf8");
    const get = key => { const m = raw.match(new RegExp(`${key}\\s*=\\s*(.+)`)); return m ? m[1].trim() : null; };
    return { ...defaults, ...Object.fromEntries(Object.keys(defaults).map(k => [k, get(k) ?? defaults[k]])) };
  } catch {
    log.warn("curr_sem.txt not found. Using defaults.");
    return defaults;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VTOP_BASE = "https://vtop.vit.ac.in/vtop";
const LOGIN_URL = `${VTOP_BASE}/login`;
const OPEN_URL = `${VTOP_BASE}/open/page`;
const MAX_LOGIN = 15;
const MAX_CAPTCHA = 3;
const CAPTCHA_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUBMIT_DELAY_MS = 450;

const T = {
  short: 3_000,
  formInput: 6_000,
  nav: 12_000,
  loginSignal: 12_000,
  postLogin: 2_500,
  semUi: 15_000,
  monthList: 10_000,
  calendar: 10_000,
  captcha: 6_000
};

const SEL = {
  loginIndicators: '#vtop-header, #authorizedIDX, a[data-url="academics/common/CalendarPreview"], #semesterSubId, #classGroupId, #getListForSemester',
  loginInputs: "#username, #password, #captchaStr",
  username: "#username",
  password: "#password",
  captchaInput: "#captchaStr",
  loginForm: "#vtopLoginForm",
  stdForm: "#stdForm",
  primaryButton: ".btn-primary",
  captchaBlock: "#captchaBlock",
  captchaImg: "#captchaBlock img",
  googleCaptcha: "#recaptcha.g-recaptcha, div.g-recaptcha",
  loginError: ".alert-danger, .alert-warning, #loginBox .text-danger, .text-danger",
  loginErrorExt: ".alert-danger, .alert-warning, #loginBox .text-danger, .text-danger, .help-block, .error-message",
  calendarLink: 'a[data-url="academics/common/CalendarPreview"]',
  feedbackLink: 'a[href*="endfeedback"]',
  semesterSubId: "#semesterSubId",
  classGroupId: "#classGroupId",
  monthButtons: "#getListForSemester a.btn-primary",
  calendarTable: ".calendar-table:last-of-type",
  calendarBody: ".calendar-table:last-of-type tbody"
};

// Col index → ISO day-of-week (Mon=1 … Sun=7)
const COL_TO_DOW = [7, 1, 2, 3, 4, 5, 6];

const MONTH_TO_NUM = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const MONTH_TO_FULL = { JAN: "JANUARY", FEB: "FEBRUARY", MAR: "MARCH", APR: "APRIL", MAY: "MAY", JUN: "JUNE", JUL: "JULY", AUG: "AUGUST", SEP: "SEPTEMBER", OCT: "OCTOBER", NOV: "NOVEMBER", DEC: "DECEMBER" };

const LABEL_ALIASES = {
  "instruction day": "Instructional Day", "instructional days": "Instructional Day", "instructons day": "Instructional Day",
  "holidays": "Holiday", "no instruction day": "No Instructional Day", "non instructional day": "No Instructional Day",
  "no-instructional day": "No Instructional Day",
  "cat-i": "CAT - I", "cat- i": "CAT - I", "cat -i": "CAT - I", "cat i": "CAT - I", "cat1": "CAT - I", "cat – i": "CAT - I",
  "cat-ii": "CAT - II", "cat- ii": "CAT - II", "cat -ii": "CAT - II", "cat ii": "CAT - II", "cat2": "CAT - II", "cat – ii": "CAT - II"
};

const NOTE_ALIASES = {
  "monday order": "Monday Day Order", "tuesday order": "Tuesday Day Order", "wednesday order": "Wednesday Day Order",
  "thursday order": "Thursday Day Order", "friday order": "Friday Day Order",
  "last instructional day for lab.": "Last Instructional Day for Laboratory Classes",
  "last instructional day for lab": "Last Instructional Day for Laboratory Classes",
  "last instructional day for laboratory": "Last Instructional Day for Laboratory Classes",
  "last lab instructional day": "Last Instructional Day for Laboratory Classes",
  "last instructional day for laboratory classes": "Last Instructional Day for Laboratory Classes",
  "last instructional day for theory": "Last Instructional Day for Theory Classes",
  "last theory instructional day": "Last Instructional Day for Theory Classes",
  "last instructional day for theory classes": "Last Instructional Day for Theory Classes",
  "first instruction day": "First Instructional Day", "first day of instruction": "First Instructional Day",
  "first day of instructions": "First Instructional Day"
};

const DAY_ORDER_MAP = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };

// ─── Logging ──────────────────────────────────────────────────────────────────

const log = {
  section: t => console.log(`\n${t}`),
  info: m => console.log(`  • ${m}`),
  ok: m => console.log(`  ✓ ${m}`),
  warn: m => console.warn(`  ⚠️ ${m}`)
};

// ─── Calendar parsing ─────────────────────────────────────────────────────────

function normalizeLabel(raw) {
  const s = compact(raw);
  return LABEL_ALIASES[s.toLowerCase()] ?? s;
}

function normalizeNote(raw) {
  const s = compact(raw);
  return NOTE_ALIASES[s.toLowerCase()] ?? s;
}

function parseDay(label, noteRaw, dow) {
  const normLabel = normalizeLabel(label);
  const normNote = normalizeNote(noteRaw);
  const ll = lower(normLabel);
  const nl = lower(normNote);

  if (!ll) return { type: null, dayOrder: 0, note: null };

  if (ll === "instructional day") {
    const match = nl.match(/(monday|tuesday|wednesday|thursday|friday)\s+(?:day\s+)?order/i);
    const dayOrder = match ? DAY_ORDER_MAP[match[1].toLowerCase()] : (dow >= 1 && dow <= 5 ? dow : 0);
    const note =
      /first\s+instructional\s+day/i.test(normNote) ? "First Instructional Day" :
        /last.*instructional.*day.*lab(?:oratory)?/i.test(normNote) ? "Last Lab Instructional Day" :
          /last.*instructional.*day.*theory/i.test(normNote) ? "Last Theory Instructional Day" : null;
    return { type: "Instructional", dayOrder, note };
  }

  if (ll === "holiday" || ll === "no instructional day")
    return { type: "Holiday", dayOrder: 0, note: normNote || null };

  if (/^cat\s*[-–]\s*i$/i.test(ll) || ll === "cat1")
    return { type: "CAT-1", dayOrder: 0, note: null };

  if (/^cat\s*[-–]\s*ii$/i.test(ll) || ll === "cat2")
    return { type: "CAT-2", dayOrder: 0, note: null };

  log.warn(`Unknown label "${label}" → treating as Holiday`);
  return { type: "Holiday", dayOrder: 0, note: normNote || label };
}

function parseMonthToken(monthStr) {
  const [, abbr, year] = String(monthStr).split("-").map(s => s.trim());
  const monthNum = MONTH_TO_NUM[abbr?.toUpperCase()];
  return monthNum && /^\d{4}$/.test(year) ? { year, monthNum } : null;
}

function monthTag(monthStr) {
  const [, abbr, year] = String(monthStr).split("-").map(s => s.trim());
  return `${abbr?.toUpperCase()}-${year}`;
}

function dowFromDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const js = new Date(y, m - 1, d).getDay();
  return js === 0 ? 7 : js;
}

function validateMonthEvents(events, year, monthNum) {
  if (!events?.length) return { ok: false, reason: "no days found" };

  const expectedDays = new Date(Number(year), Number(monthNum), 0).getDate();
  const seen = new Set();
  let dowMismatches = 0;

  for (const e of events) {
    const [ey, em, ed] = e.date.split("-").map(Number);
    if (ey !== Number(year) || em !== Number(monthNum))
      return { ok: false, reason: `date ${e.date} outside target month` };
    if (!Number.isInteger(ed) || ed < 1 || ed > expectedDays)
      return { ok: false, reason: `invalid date ${e.date}` };
    if (seen.has(ed))
      return { ok: false, reason: `duplicate day ${ed}` };
    seen.add(ed);
    if (e.dayOfWeek !== dowFromDate(e.date)) dowMismatches++;
  }

  if (seen.size !== expectedDays) return { ok: false, reason: `expected ${expectedDays} days, got ${seen.size}` };
  if (dowMismatches > 0) return { ok: false, reason: `${dowMismatches} day-of-week mismatches` };
  return { ok: true };
}

function validateMonthHeader(monthStr, headerText) {
  const parsed = parseMonthToken(monthStr);
  if (!parsed) return { ok: false, reason: `invalid token ${monthStr}` };
  if (!headerText) return { ok: true };

  const h = headerText.toUpperCase();
  const abbr = monthStr.split("-")[1].trim().toUpperCase();
  return (h.includes(abbr) || h.includes(MONTH_TO_FULL[abbr])) && h.includes(parsed.year)
    ? { ok: true }
    : { ok: false, reason: `header mismatch: "${headerText}"` };
}

function classifyCalendar(rawData, fallbackFirst, fallbackLastTheory, fallbackLastLab) {
  rawData.sort((a, b) => new Date(a.date) - new Date(b.date));

  const classified = rawData.map(d => ({ ...d, ...parseDay(d.label, d.noteRaw, d.dayOfWeek) }));

  const instrDates = classified.filter(d => d.type === "Instructional").map(d => d.date).sort();
  const firstInstrDate = instrDates[0] || fallbackFirst || null;
  const lastInstrDate = instrDates.at(-1) || null;

  if (firstInstrDate && lastInstrDate && firstInstrDate > lastInstrDate)
    throw new Error(`Instructional boundaries invalid: first=${firstInstrDate}, last=${lastInstrDate}`);

  const finalData = classified.map(d => {
    if (d.type !== null) return d;
    return { ...d, type: lastInstrDate && d.date > lastInstrDate ? "FAT" : "Holiday", dayOrder: 0, note: null };
  });

  const badInstr = finalData.find(d => d.type === "Instructional" && (d.dayOrder < 1 || d.dayOrder > 5));
  if (badInstr) throw new Error(`Invalid day order on ${badInstr.date}`);

  let totalInstructional = 0, lastTheoryDate = null, lastLabDate = null;

  for (const d of finalData) {
    if (d.type !== "Instructional") continue;
    totalInstructional++;
    if (d.note === "Last Theory Instructional Day") lastTheoryDate = d.date;
    if (d.note === "Last Lab Instructional Day") lastLabDate = d.date;
  }

  if (totalInstructional === 0)
    throw new Error("No instructional days found; aborting.");

  return {
    finalData,
    firstInstrDate,
    lastInstrDate,
    lastTheoryDate: lastTheoryDate ?? fallbackLastTheory ?? null,
    lastLabDate: lastLabDate ?? fallbackLastLab ?? null,
    totalInstructional
  };
}

function buildOutput(semester, year, finalData, meta) {
  return {
    metadata: {
      semester, year,
      generatedAt: getISTTime(),
      totalInstructionalDays: meta.totalInstructional,
      firstInstructionalDay: meta.firstInstrDate,
      lastTheoryInstructionalDay: meta.lastTheoryDate,
      lastLabInstructionalDay: meta.lastLabDate
    },
    data: finalData.reduce((acc, d) => {
      const month = d.date.slice(0, 7);
      (acc[month] ??= []).push(d);
      return acc;
    }, {})
  };
}

// ─── Login helpers ────────────────────────────────────────────────────────────

async function isLoggedIn(page) {
  return page.evaluate(s => {
    if (document.querySelector(s.loginIndicators)) return true;
    const href = location.href;
    if (href.includes("/vtop/content") || href.includes("processLogin")) return true;
    return !document.querySelector(s.loginInputs) && href.includes("/vtop/") && !href.includes("/vtop/login") && !href.includes("/open/page");
  }, { loginIndicators: SEL.loginIndicators, loginInputs: SEL.loginInputs });
}

async function ensureLoginForm(page) {
  for (let i = 1; i <= 4; i++) {
    if (await isLoggedIn(page)) return { ready: true, alreadyLoggedIn: true };

    const [hasUser, hasPass] = await Promise.all([page.$(SEL.username), page.$(SEL.password)]);
    if (hasUser && hasPass) return { ready: true, alreadyLoggedIn: false };

    if (await page.$(SEL.stdForm)) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: T.nav }).catch(() => null),
        page.evaluate(s => document.querySelector(s)?.submit(), SEL.stdForm)
      ]);
      await sleep(900);
    } else {
      try {
        await page.waitForSelector(`${SEL.primaryButton}, ${SEL.username}, ${SEL.stdForm}`, { timeout: T.short });
        (await page.$(SEL.primaryButton))?.click();
      } catch { }
      await sleep(800);
    }
  }
  return { ready: false, alreadyLoggedIn: false };
}

async function detectCaptchaMode(page) {
  return page.evaluate(s => {
    const hasImage = !!(document.querySelector(s.captchaImg) && document.querySelector(s.captchaInput));
    if (hasImage) return "image";
    return document.querySelector(s.googleCaptcha) ? "google" : "none";
  }, { captchaImg: SEL.captchaImg, captchaInput: SEL.captchaInput, googleCaptcha: SEL.googleCaptcha });
}

async function refreshCaptchaImage(page) {
  const refreshed = await page.evaluate(async (base, s) => {
    const block = document.querySelector(s.captchaBlock);
    if (!block) return false;

    const btn = document.querySelector(`${s.captchaBlock} [onclick*="captcha"], ${s.captchaBlock} [onclick*="refresh"], ${s.captchaBlock} .fa-refresh, ${s.captchaBlock} .fa-sync, ${s.captchaBlock} .fa-redo`);
    if (btn) { btn.click(); return true; }

    try {
      const res = await fetch(`${base}/get/new/captcha`, { method: "GET", credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (res.ok) { block.innerHTML = await res.text(); return true; }
    } catch { }
    return false;
  }, VTOP_BASE, { captchaBlock: SEL.captchaBlock });

  if (!refreshed) return false;

  await page.waitForFunction(s => {
    const img = document.querySelector(s);
    return !!(img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
  }, { timeout: T.captcha }, SEL.captchaImg).catch(() => null);

  return true;
}

async function solveCaptcha(page, weights, biases) {
  return page.evaluate((w, b, charset, imgSel) => {
    try {
      const img = document.querySelector(imgSel);
      if (!img?.complete || !img.naturalWidth) return { ok: false, reason: "image-not-ready" };

      const canvas = Object.assign(document.createElement("canvas"), { width: 200, height: 40 });
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, reason: "no-canvas-ctx" };

      ctx.drawImage(img, 0, 0, 200, 40);
      const { data } = ctx.getImageData(0, 0, 200, 40);

      const sat = new Array(data.length / 4);
      for (let i = 0; i < data.length; i += 4) {
        const mx = Math.max(data[i], data[i + 1], data[i + 2]);
        const mn = Math.min(data[i], data[i + 1], data[i + 2]);
        sat[i / 4] = mx === 0 ? 0 : Math.round(255 * (mx - mn) / mx);
      }

      const rows = Array.from({ length: 40 }, (_, r) => Array.from({ length: 200 }, (_, c) => sat[200 * r + c]));

      const classifyBlock = block => {
        const flat = block.flat();
        const avg = flat.reduce((s, n) => s + n, 0) / flat.length;
        const bits = flat.map(v => v > avg ? 1 : 0);
        const logits = w[0].map((_, j) => bits.reduce((s, bit, k) => s + bit * w[k][j], 0) + b[j]);
        const exps = logits.map(Math.exp);
        const sum = exps.reduce((a, v) => a + v, 0);
        return charset[exps.map(v => v / sum).indexOf(Math.max(...exps.map(v => v / sum)))];
      };

      const text = Array.from({ length: 6 }, (_, i) =>
        rows.slice(7 + i % 2 * 5 + 1, 35 - (i + 1) % 2 * 5).map(r => r.slice(25 * (i + 1) + 2, 25 * (i + 2) + 1))
      ).map(classifyBlock).join("");

      return text.length === 6 ? { ok: true, text } : { ok: false, reason: "bad-length" };
    } catch (e) {
      return { ok: false, reason: `solver: ${e?.message ?? e}` };
    }
  }, weights, biases, CAPTCHA_CHARSET, SEL.captchaImg);
}

async function fillAndSubmit(page, regNo, password, captchaText) {
  await Promise.all([SEL.username, SEL.password, SEL.captchaInput].map(s => page.waitForSelector(s, { timeout: T.formInput })));

  await page.evaluate((s, u, p, c) => {
    const fire = (el, ...evts) => evts.forEach(e => el?.dispatchEvent(new Event(e, { bubbles: true })));
    const set = (sel, val, ...evts) => { const el = document.querySelector(sel); if (el) { el.value = val; fire(el, ...evts); } };
    set(s.username, u, "input", "change", "keyup");
    set(s.password, p, "input", "change");
    set(s.captchaInput, c, "input", "change", "keyup");
  }, { username: SEL.username, password: SEL.password, captchaInput: SEL.captchaInput }, regNo, password, captchaText);

  await page.evaluate((delay, s) => new Promise(resolve => setTimeout(() => {
    const btn = [...document.querySelectorAll('button[type="button"],button[type="submit"],input[type="submit"]')]
      .find(b => /submit|login|sign.?in/i.test(b.innerText || b.value || ""));
    if (btn) { btn.click(); resolve("button"); }
    else if (typeof callBuiltValidation === "function") { callBuiltValidation(); resolve("built"); }
    else if (typeof callGoogleValidation === "function") { callGoogleValidation(); resolve("google"); }
    else { document.querySelector(s.loginForm)?.submit(); resolve("form"); }
  }, delay)), SUBMIT_DELAY_MS, { loginForm: SEL.loginForm });

  await page.keyboard.press("Enter").catch(() => null);

  await Promise.race([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: T.nav }),
    page.waitForFunction(s => {
      if (document.querySelector(s.loginIndicators)) return true;
      if (document.querySelector(s.loginError)) return true;
      return location.href.includes("/vtop/content") || location.href.includes("processLogin");
    }, { timeout: T.loginSignal }, { loginIndicators: SEL.loginIndicators, loginError: SEL.loginError })
  ]).catch(() => null);
}

async function getLoginError(page) {
  return page.evaluate(s => {
    const msgs = [...document.querySelectorAll(s)]
      .map(el => el.textContent.replace(/\s+/g, " ").trim())
      .filter(t => t.length > 2);
    if (msgs.length) return [...new Set(msgs)].join(" | ");

    const m = document.body?.innerText?.replace(/\s+/g, " ").match(
      /(invalid\s+captcha[^.]*\.?|incorrect\s+captcha[^.]*\.?|wrong\s+captcha[^.]*\.?|invalid\s+credentials[^.]*\.?|incorrect\s+password[^.]*\.?|authentication\s+failed[^.]*\.?)/i
    );
    return m?.[1] ?? "";
  }, SEL.loginErrorExt);
}

async function runLoginAttempt(page, regNo, password, attempt) {
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
  const { ready, alreadyLoggedIn } = await ensureLoginForm(page);

  if (alreadyLoggedIn) return { loggedIn: true, message: "already authenticated" };
  if (!ready) { await sleep(700 + 200 * attempt); return { loggedIn: false, message: "login form not ready" }; }

  const captchaMode = await detectCaptchaMode(page);
  if (captchaMode === "google") {
    await page.goto(OPEN_URL, { waitUntil: "networkidle2" }).catch(() => null);
    await sleep(900 + 220 * attempt);
    return { loggedIn: false, message: "google captcha, rerouted" };
  }
  if (captchaMode !== "image") {
    await sleep(900 + 200 * attempt);
    return { loggedIn: false, message: `captcha mode: ${captchaMode}` };
  }

  let lastReason = "login not confirmed";

  for (let s = 1; s <= MAX_CAPTCHA; s++) {
    if (s > 1) await refreshCaptchaImage(page);

    const solved = await solveCaptcha(page, bitmaps.weights, bitmaps.biases);
    if (!solved.ok) {
      lastReason = `captcha solve failed (${solved.reason})`;
      await refreshCaptchaImage(page);
      await sleep(450);
      continue;
    }

    await fillAndSubmit(page, regNo, password, solved.text);

    if (await isLoggedIn(page)) return { loggedIn: true, message: `logged in (solve ${s}/${MAX_CAPTCHA})` };

    const errText = await getLoginError(page);
    if (/invalid\s*(credentials|password|username|register)|incorrect\s*(credentials|password|username)|authentication\s*failed/i.test(errText))
      throw new Error(`Credentials rejected: ${errText}`);

    lastReason = errText
      ? compact(errText).slice(0, 100)
      : `solve ${s}/${MAX_CAPTCHA} failed`;

    await sleep(850);
  }

  await sleep(750 + 220 * attempt);
  return { loggedIn: false, message: lastReason };
}

// ─── Calendar scraping ────────────────────────────────────────────────────────

async function extractMonthSnapshot(page, monthStr) {
  return page.evaluate((mStr, monthToNum, colToDow, s) => {
    const table = document.querySelector(s.calendarTable);
    if (!table) return { events: [], monthHeaderText: "" };

    const [, abbr, year] = mStr.split("-").map(p => p.trim());
    const monthNum = monthToNum[abbr.toUpperCase()];
    const c = t => String(t ?? "").replace(/\s+/g, " ").trim();

    const monthHeaderText = [
      table.querySelector("thead"),
      table.previousElementSibling,
      document.querySelector(".modal-title"),
      document.querySelector(".panel-heading")
    ].filter(Boolean).map(el => c(el.innerText)).filter(Boolean).join(" | ");

    const events = [];
    table.querySelectorAll("tbody td").forEach((col, idx) => {
      const spans = [...col.querySelectorAll("span")];
      if (!spans.length) return;
      const dateText = c(spans[0].innerText);
      if (!/^\d+$/.test(dateText)) return;

      const labelSpan = spans.slice(1).find(sp => c(sp.innerText));
      const label = labelSpan ? c(labelSpan.innerText) : "";

      let noteRaw = "";
      if (labelSpan) {
        let sib = labelSpan.nextElementSibling;
        while (sib && sib.tagName !== "SPAN") sib = sib.nextElementSibling;
        if (sib) noteRaw = c(sib.innerText.replace(/^\s*\(|\)\s*$/g, ""));
      }

      events.push({
        date: `${year}-${monthNum}-${dateText.padStart(2, "0")}`,
        dayOfWeek: colToDow[idx % 7],
        label,
        noteRaw
      });
    });

    return { events, monthHeaderText };
  }, monthStr, MONTH_TO_NUM, COL_TO_DOW, { calendarTable: SEL.calendarTable });
}

async function scrapeMonth(page, monthStr) {
  const parsed = parseMonthToken(monthStr);
  if (!parsed) throw new Error(`Invalid month token: ${monthStr}`);

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.evaluate(m => typeof processViewCalendar === "function" && processViewCalendar(m), monthStr);
      await page.waitForFunction(sel => {
        const tbody = document.querySelector(sel);
        return tbody && [...tbody.querySelectorAll("td")].filter(c => /^\d+$/.test(c.querySelector("span")?.innerText?.trim())).length >= 28;
      }, { timeout: T.calendar }, SEL.calendarBody);

      await sleep(1200 + 400 * attempt);
      const snap = await extractMonthSnapshot(page, monthStr);

      if (!validateMonthHeader(monthStr, snap.monthHeaderText).ok) { await sleep(500); continue; }
      if (validateMonthEvents(snap.events, parsed.year, parsed.monthNum).ok)
        return { events: snap.events, attempts: attempt };
    } catch { }
    await sleep(500);
  }

  throw new Error(`Failed to scrape valid snapshot for ${monthStr}.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runScraper() {
  const { sem, year, fallback_first_instructional_day, fallback_last_instructional_day_theory, fallback_last_instructional_day_lab } = await getConfig();

  const regNo = process.env.VTOP_REGNO?.trim();
  const password = process.env.VTOP_PASSWORD?.trim();
  if (!regNo || !password) throw new Error("Missing VTOP_REGNO or VTOP_PASSWORD.");

  log.section(`🎯 Target: ${sem} Semester ${year}`);

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  page.on("dialog", d => d.accept());

  try {
    log.section("🔐 Login");
    let loggedIn = false;

    for (let i = 1; i <= MAX_LOGIN && !loggedIn; i++) {
      const result = await runLoginAttempt(page, regNo, password, i);
      result.loggedIn
        ? (log.ok(`[${i}/${MAX_LOGIN}] ${result.message}`), loggedIn = true)
        : log.warn(`[${i}/${MAX_LOGIN}] ${result.message}`);
    }
    if (!loggedIn) throw new Error("Failed to login after all attempts.");

    await sleep(T.postLogin);

    await page.evaluate(() => {
      document.querySelector(".bootbox-accept, .modal-footer .btn-primary")?.click();
      document.querySelector(".sweet-alert .confirm")?.click();
      document.querySelectorAll(".modal-backdrop, .sweet-overlay").forEach(el => el.remove());
      document.body.classList.remove("modal-open", "stop-scrolling");
    });

    await page.waitForSelector(`${SEL.calendarLink}, ${SEL.feedbackLink}`, { timeout: T.semUi })
      .catch(() => { throw new Error("Could not find calendar or feedback link."); });

    if (await page.$(SEL.feedbackLink)) {
      log.warn("Mandatory feedback form detected — menu is blocked.");
      log.info("Complete feedback at https://web.vit.ac.in/endfeedback, then re-run.");
      return;
    }

    await page.evaluate(s => document.querySelector(s)?.click(), SEL.calendarLink);
    await page.waitForSelector(SEL.semesterSubId, { timeout: T.semUi });

    const semValue = await page.evaluate((sel, s, y) => {
      const target = `${s} Semester ${y}`.toLowerCase();
      return [...document.querySelectorAll(`${sel} option`)]
        .find(o => o.innerText.toLowerCase().includes(target) && o.innerText.includes("VLR"))?.value ?? null;
    }, SEL.semesterSubId, sem, year);

    if (!semValue) throw new Error("Semester ID not found in dropdown.");

    await page.select(SEL.semesterSubId, semValue);
    await sleep(1500);
    await page.select(SEL.classGroupId, "ALL");
    await sleep(2000);

    await page.waitForSelector(SEL.monthButtons, { timeout: T.monthList });
    const months = await page.evaluate(s =>
      [...document.querySelectorAll(s)].map(b => b.getAttribute("onclick")?.match(/'([^']+)'/)?.[1]).filter(Boolean),
      SEL.monthButtons
    );

    log.section(`📅 Months (${months.length})`);
    const rawData = [];
    const seenDates = new Set();

    for (const monthStr of months) {
      const { events, attempts } = await scrapeMonth(page, monthStr);
      for (const e of events) {
        if (seenDates.has(e.date)) throw new Error(`Duplicate date across months: ${e.date}`);
        seenDates.add(e.date);
      }
      rawData.push(...events);
      log.ok(`[${monthTag(monthStr)}] ${events.length} days${attempts > 1 ? ` (retry ×${attempts - 1})` : ""}`);
    }

    const meta = classifyCalendar(rawData, fallback_first_instructional_day, fallback_last_instructional_day_theory, fallback_last_instructional_day_lab);

    log.section("🧾 Summary");
    log.info(`Instructional days: ${meta.totalInstructional}`);
    log.info(`First instructional: ${meta.firstInstrDate}`);
    log.info(`Last instructional:  ${meta.lastInstrDate}`);
    log.info(`Last theory:         ${meta.lastTheoryDate}`);
    log.info(`Last lab:            ${meta.lastLabDate}`);

    const outDir = path.join(__dirname, "calendars", year);
    fs.mkdirSync(outDir, { recursive: true });
    writeJsonAtomically(path.join(outDir, `${sem}.json`), buildOutput(sem, year, meta.finalData, meta));
    log.ok(`Saved calendars/${year}/${sem}.json`);

  } finally {
    await browser.close();
  }
}

runScraper().catch(err => console.error("❌ Fatal:", err));
