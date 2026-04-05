require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const bitmaps = require("./bitmaps");

puppeteer.use(StealthPlugin());

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalizeWhitespace = value => String(value || "").replace(/\s+/g, " ").trim();
const normalizeLower = value => normalizeWhitespace(value).toLowerCase();

const SELECTORS = {
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
  loginErrorExtended: ".alert-danger, .alert-warning, #loginBox .text-danger, #loginBox .text-danger:not(i), .text-danger, .help-block, .error-message",
  calendarLink: 'a[data-url="academics/common/CalendarPreview"]',
  semesterSubId: "#semesterSubId",
  classGroupId: "#classGroupId",
  monthButtons: "#getListForSemester a.btn-primary",
  calendarTable: ".calendar-table:last-of-type",
  calendarTableBody: ".calendar-table:last-of-type tbody"
};

const TIMEOUTS = {
  short: 3000,
  formInput: 6000,
  navWait: 12000,
  loginSignal: 12000,
  postLogin: 2500,
  semesterUi: 15000,
  monthList: 10000,
  calendarWait: 10000,
  captchaReady: 6000
};

const DAY_OF_WEEK_BY_COLUMN = [7, 1, 2, 3, 4, 5, 6];

const logger = {
  section: title => console.log(`\n${title}`),
  info: message => console.log(`  • ${message}`),
  ok: message => console.log(`  ✓ ${message}`),
  warn: message => console.warn(`  ⚠️ ${message}`)
};

async function getConfig() {
  const configData = {
    sem: "Winter",
    year: "2025",
    fallback_first_instructional_day: null,
    fallback_last_instructional_day_theory: null,
    fallback_last_instructional_day_lab: null
  };

  try {
    const config = fs.readFileSync(path.join(__dirname, "curr_sem.txt"), "utf8");
    configData.sem = matchConfig(config, "sem") || configData.sem;
    configData.year = matchConfig(config, "year") || configData.year;
    configData.fallback_first_instructional_day = matchConfig(config, "fallback_first_instructional_day");
    configData.fallback_last_instructional_day_theory = matchConfig(config, "fallback_last_instructional_day_theory");
    configData.fallback_last_instructional_day_lab = matchConfig(config, "fallback_last_instructional_day_lab");
  } catch {
    logger.warn("curr_sem.txt not found. Using defaults.");
  }

  return configData;
}

function matchConfig(config, key) {
  const match = config.match(new RegExp(`${key}\\s*=\\s*(.+)`));
  return match ? match[1].trim() : null;
}

const DAY_ORDER_MAP = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5
};

const LABEL_ALIASES = {
  "instruction day": "Instructional Day",
  "instructional days": "Instructional Day",
  "instructons day": "Instructional Day",
  holidays: "Holiday",
  "no instruction day": "No Instructional Day",
  "non instructional day": "No Instructional Day",
  "no-instructional day": "No Instructional Day",
  "cat-i": "CAT - I",
  "cat- i": "CAT - I",
  "cat -i": "CAT - I",
  "cat i": "CAT - I",
  cat1: "CAT - I",
  "cat – i": "CAT - I",
  "cat-ii": "CAT - II",
  "cat- ii": "CAT - II",
  "cat -ii": "CAT - II",
  "cat ii": "CAT - II",
  cat2: "CAT - II",
  "cat – ii": "CAT - II"
};

const NOTE_ALIASES = {
  "monday order": "Monday Day Order",
  "tuesday order": "Tuesday Day Order",
  "wednesday order": "Wednesday Day Order",
  "thursday order": "Thursday Day Order",
  "friday order": "Friday Day Order",
  "last instructional day for lab.": "Last Instructional Day for Laboratory Classes",
  "last instructional day for lab": "Last Instructional Day for Laboratory Classes",
  "last instructional day for laboratory": "Last Instructional Day for Laboratory Classes",
  "last lab instructional day": "Last Instructional Day for Laboratory Classes",
  "last instructional day for laboratory classes": "Last Instructional Day for Laboratory Classes",
  "last instructional day for theory": "Last Instructional Day for Theory Classes",
  "last theory instructional day": "Last Instructional Day for Theory Classes",
  "last instructional day for theory classes": "Last Instructional Day for Theory Classes",
  "first instruction day": "First Instructional Day",
  "first day of instruction": "First Instructional Day",
  "first day of instructions": "First Instructional Day"
};

const MONTH_ABBR_TO_NUM = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const MONTH_ABBR_TO_FULL = { JAN: "JANUARY", FEB: "FEBRUARY", MAR: "MARCH", APR: "APRIL", MAY: "MAY", JUN: "JUNE", JUL: "JULY", AUG: "AUGUST", SEP: "SEPTEMBER", OCT: "OCTOBER", NOV: "NOVEMBER", DEC: "DECEMBER" };

const VTOP_BASE_URL = "https://vtop.vit.ac.in/vtop";
const LOGIN_URL = `${VTOP_BASE_URL}/login`;
const OPEN_PAGE_URL = `${VTOP_BASE_URL}/open/page`;
const MAX_LOGIN_ATTEMPTS = 15;
const MAX_CAPTCHA_SOLVE_ATTEMPTS = 3;
const CAPTCHA_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FORM_SUBMIT_DELAY_MS = 450;

function parseMonthToken(monthStr) {
  const parts = String(monthStr).split("-");
  if (3 !== parts.length) return null;

  const monthAbbr = parts[1].trim().toUpperCase();
  const year = parts[2].trim();
  const monthNum = MONTH_ABBR_TO_NUM[monthAbbr];

  return monthNum && /^\d{4}$/.test(year) ? { year: year, monthNum: monthNum } : null;
}

function monthTag(monthStr) {
  const parts = String(monthStr).split("-");
  return 3 !== parts.length ? String(monthStr) : `${parts[1].trim().toUpperCase()}-${parts[2].trim()}`;
}

function dateToCalendarDayOfWeek(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const jsDay = new Date(year, month - 1, day).getDay();
  return 0 === jsDay ? 7 : jsDay;
}

function validateMonthEvents(monthEvents, year, monthNum) {
  if (!Array.isArray(monthEvents) || 0 === monthEvents.length) {
    return { ok: false, reason: "no days found" };
  }

  const expectedDays = new Date(Number(year), Number(monthNum), 0).getDate();
  const seenDays = new Set();
  let dayOfWeekMismatchCount = 0;

  for (const event of monthEvents) {
    const [eventYear, eventMonth, eventDay] = event.date.split("-").map(Number);

    if (eventYear !== Number(year) || eventMonth !== Number(monthNum)) {
      return { ok: false, reason: `date ${event.date} is outside target month` };
    }
    if (!Number.isInteger(eventDay) || eventDay < 1 || eventDay > expectedDays) {
      return { ok: false, reason: `invalid date ${event.date}` };
    }
    if (seenDays.has(eventDay)) {
      return { ok: false, reason: `duplicate day ${eventDay}` };
    }

    seenDays.add(eventDay);
    if (event.dayOfWeek !== dateToCalendarDayOfWeek(event.date)) {
      dayOfWeekMismatchCount++;
    }
  }

  if (seenDays.size !== expectedDays) {
    return { ok: false, reason: `expected ${expectedDays} days, got ${seenDays.size}` };
  }

  if (dayOfWeekMismatchCount > 0) {
    return { ok: false, reason: `${dayOfWeekMismatchCount} day-of-week mismatches` };
  }

  return { ok: true, reason: null };
}

function normalizeLabel(raw) {
  const clean = normalizeWhitespace(raw);
  return LABEL_ALIASES[clean.toLowerCase()] || clean;
}

function normalizeNote(raw) {
  const clean = normalizeWhitespace(raw);
  return NOTE_ALIASES[clean.toLowerCase()] || clean;
}

function parseDay(label, noteRaw, dayOfWeek) {
  const normLabel = normalizeLabel(label);
  const normNote = normalizeNote(noteRaw);
  const labelLower = normalizeLower(normLabel);
  const noteLower = normalizeLower(normNote);

  if (!labelLower) {
    return { type: null, dayOrder: 0, note: null };
  }

  if ("instructional day" === labelLower) {
    const dayOrderMatch = noteLower.match(/(monday|tuesday|wednesday|thursday|friday)\s+(?:day\s+)?order/i);
    const dayOrder = dayOrderMatch
      ? DAY_ORDER_MAP[dayOrderMatch[1].toLowerCase()]
      : (dayOfWeek >= 1 && dayOfWeek <= 5 ? dayOfWeek : 0);

    let note = null;
    if (/first\s+instructional\s+day/i.test(normNote)) {
      note = "First Instructional Day";
    } else if (/last.*instructional.*day.*lab(?:oratory)?/i.test(normNote)) {
      note = "Last Lab Instructional Day";
    } else if (/last.*instructional.*day.*theory/i.test(normNote)) {
      note = "Last Theory Instructional Day";
    }

    return { type: "Instructional", dayOrder: dayOrder, note: note };
  }

  if ("holiday" === labelLower || "no instructional day" === labelLower) {
    return { type: "Holiday", dayOrder: 0, note: normNote || null };
  }

  if (/^cat\s*[-–]\s*i$/i.test(labelLower) || "cat1" === labelLower) {
    return { type: "CAT-1", dayOrder: 0, note: null };
  }

  if (/^cat\s*[-–]\s*ii$/i.test(labelLower) || "cat2" === labelLower) {
    return { type: "CAT-2", dayOrder: 0, note: null };
  }

  logger.warn(`Unknown label "${label}" (normalized: "${normLabel}") -> treating as Holiday`);
  return { type: "Holiday", dayOrder: 0, note: normNote || label };
}

function validateRenderedMonthContext(monthStr, monthHeaderText) {
  const parsed = parseMonthToken(monthStr);
  if (!parsed) {
    return { ok: false, reason: `invalid month token ${monthStr}` };
  }

  const rawHeader = normalizeWhitespace(monthHeaderText);
  if (!rawHeader) {
    return { ok: true, reason: null };
  }

  const monthAbbr = monthStr.split("-")[1].trim().toUpperCase();
  const monthFull = MONTH_ABBR_TO_FULL[monthAbbr] || monthAbbr;
  const normalizedHeader = rawHeader.toUpperCase();
  const hasMonth = normalizedHeader.includes(monthAbbr) || normalizedHeader.includes(monthFull);
  const hasYear = normalizedHeader.includes(parsed.year);

  if (hasMonth && hasYear) {
    return { ok: true, reason: null };
  }

  return { ok: false, reason: `header mismatch: "${rawHeader}"` };
}

function isCaptchaError(text) {
  return /captcha|verification\s*code|invalid\s*code|wrong\s*code/i.test(String(text || ""));
}

function isCredentialError(text) {
  return /invalid\s*(credentials|password|username|register)|incorrect\s*(credentials|password|username)|authentication\s*failed/i.test(String(text || ""));
}

function shortError(text, maxLen = 100) {
  const clean = normalizeWhitespace(text);
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 3)}...`;
}

function writeJsonAtomically(outputPath, data) {
  const tmpPath = `${outputPath}.tmp-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, outputPath);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

function getISTTime() {
  const now = new Date((new Date).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}::${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

async function isLoggedIn(page) {
  return page.evaluate(selectors => {
    if (document.querySelector(selectors.loginIndicators)) return true;

    const href = String(window.location.href || "");
    if (href.includes("/vtop/content") || href.includes("processLogin")) return true;

    return !(!!document.querySelector(selectors.loginInputs) || !href.includes("/vtop/") || href.includes("/vtop/login") || href.includes("/open/page"));
  }, { loginIndicators: SELECTORS.loginIndicators, loginInputs: SELECTORS.loginInputs });
}

async function ensureLoginForm(page) {
  for (let hop = 1; hop <= 4; hop++) {
    if (await isLoggedIn(page)) {
      return { ready: true, alreadyLoggedIn: true };
    }

    const [hasUsername, hasPassword] = await Promise.all([
      page.$(SELECTORS.username),
      page.$(SELECTORS.password)
    ]);

    if (hasUsername && hasPassword) {
      return { ready: true, alreadyLoggedIn: false };
    }

    if (await page.$(SELECTORS.stdForm)) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUTS.navWait }).catch(() => null),
          page.evaluate(selector => { document.querySelector(selector)?.submit(); }, SELECTORS.stdForm)
        ]);
      } catch { }
      await sleep(900);
    } else {
      try {
        await page.waitForSelector(`${SELECTORS.primaryButton}, ${SELECTORS.username}, ${SELECTORS.stdForm}`, { timeout: TIMEOUTS.short });
        const primaryButton = await page.$(SELECTORS.primaryButton);
        if (primaryButton) await primaryButton.click();
      } catch { }
      await sleep(800);
    }
  }
  return { ready: false, alreadyLoggedIn: false };
}

async function detectCaptchaMode(page) {
  return page.evaluate(selectors => {
    const imageCaptcha = document.querySelector(selectors.captchaImg);
    const captchaInput = document.querySelector(selectors.captchaInput);
    const hasTextCap = !(!imageCaptcha || !captchaInput);

    if (hasTextCap) return "image";
    return document.querySelector(selectors.googleCaptcha) && !hasTextCap ? "google" : "none";
  }, { captchaImg: SELECTORS.captchaImg, captchaInput: SELECTORS.captchaInput, googleCaptcha: SELECTORS.googleCaptcha });
}

async function refreshCaptchaImage(page) {
  if (!await page.evaluate(async (baseUrl, selectors) => {
    const block = document.querySelector(selectors.captchaBlock);
    if (!block) return false;

    const refreshElement = document.querySelector(`${selectors.captchaBlock} [onclick*="captcha"], ${selectors.captchaBlock} [onclick*="refresh"], ${selectors.captchaBlock} .fa-refresh, ${selectors.captchaBlock} .fa-sync, ${selectors.captchaBlock} .fa-redo`);
    if (refreshElement && "function" == typeof refreshElement.click) {
      refreshElement.click();
      return true;
    }

    try {
      const response = await fetch(`${baseUrl}/get/new/captcha`, {
        method: "GET",
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      });
      if (response.ok) {
        block.innerHTML = await response.text();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, VTOP_BASE_URL, { captchaBlock: SELECTORS.captchaBlock })) {
    return false;
  }

  try {
    await page.waitForFunction(captchaImg => {
      const img = document.querySelector(captchaImg);
      return !!(img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
    }, { timeout: TIMEOUTS.captchaReady }, SELECTORS.captchaImg);
  } catch { }

  return true;
}

async function solveCaptchaWithModel(page, weights, biases) {
  return page.evaluate((w, b, charset, captchaImgSelector) => {
    try {
      const captchaImgEl = document.querySelector(captchaImgSelector);
      if (!captchaImgEl) {
        return { ok: false, reason: "captcha-image-missing", text: "" };
      }
      if (!captchaImgEl.complete || 0 === captchaImgEl.naturalWidth) {
        return { ok: false, reason: "captcha-image-not-ready", text: "" };
      }

      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 40;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        return { ok: false, reason: "canvas-context-unavailable", text: "" };
      }

      ctx.drawImage(captchaImgEl, 0, 0, 200, 40);
      const { data: data } = ctx.getImageData(0, 0, 200, 40);

      const processBlock = block => {
        const avg = block.flat().reduce((acc, n) => acc + n, 0) / (block.length * block[0].length);
        const bits = block.map(row => row.map(val => val > avg ? 1 : 0)).flat();
        const expValues = w[0].map((_, j) => bits.reduce((sum, bit, k) => sum + bit * w[k][j], 0)).map((val, i) => val + b[i]).map(val => Math.exp(val));
        const expSum = expValues.reduce((sum, val) => sum + val, 0);
        const softmax = expValues.map(val => val / expSum);
        return charset[softmax.indexOf(Math.max(...softmax))];
      };

      const text = (d => {
        const sat = new Array(d.length / 4);
        for (let i = 0; i < d.length; i += 4) {
          const min = Math.min(d[i], d[i + 1], d[i + 2]);
          const max = Math.max(d[i], d[i + 1], d[i + 2]);
          sat[i / 4] = 0 === max ? 0 : Math.round(255 * (max - min) / max);
        }
        const arr = Array.from({ length: 40 }, (_, i) => Array.from({ length: 200 }, (_, j) => sat[200 * i + j]));
        return Array.from({ length: 6 }, (_, i) => arr.slice(7 + i % 2 * 5 + 1, 35 - (i + 1) % 2 * 5).map(row => row.slice(25 * (i + 1) + 2, 25 * (i + 2) + 1)));
      })(data).map(processBlock).join("");

      if (text && 6 === text.length) {
        return { ok: true, text: text };
      } else {
        return { ok: false, reason: "invalid-length", text: text || "" };
      }
    } catch (error) {
      return { ok: false, reason: `solver-error: ${error && error.message ? error.message : String(error)}`, text: "" };
    }
  }, weights, biases, CAPTCHA_CHARSET, SELECTORS.captchaImg);
}

async function fillLoginForm(page, regNo, password, solvedCaptcha) {
  await Promise.all([
    page.waitForSelector(SELECTORS.username, { timeout: TIMEOUTS.formInput }),
    page.waitForSelector(SELECTORS.password, { timeout: TIMEOUTS.formInput }),
    page.waitForSelector(SELECTORS.captchaInput, { timeout: TIMEOUTS.formInput })
  ]);

  await page.evaluate((usernameSelector, passwordSelector, captchaSelector, username, pwd, captchaText) => {
    const unameInput = document.querySelector(usernameSelector);
    const passwdInput = document.querySelector(passwordSelector);
    const captchaStrEl = document.querySelector(captchaSelector);

    const fire = (el, ...events) => {
      el && events.forEach(eventName => el.dispatchEvent(new Event(eventName, { bubbles: true })));
    };

    if (unameInput) {
      unameInput.value = username;
      fire(unameInput, "input", "change", "keyup");
    }
    if (passwdInput) {
      passwdInput.value = pwd;
      fire(passwdInput, "input", "change");
    }
    if (captchaText && captchaStrEl) {
      captchaStrEl.value = captchaText;
      fire(captchaStrEl, "input", "change", "keyup");
    }
  }, SELECTORS.username, SELECTORS.password, SELECTORS.captchaInput, regNo, password, solvedCaptcha);
}

async function submitLogin(page) {
  await page.evaluate((submitDelayMs, selectors) => new Promise(resolve => {
    setTimeout(() => {
      const form = document.querySelector(selectors.loginForm);
      const submitButton = Array.from(document.querySelectorAll('button[type="button"],button[type="submit"],input[type="submit"]')).find(btn => /submit|login|sign.?in/.test(String(btn.innerText || btn.value || "").toLowerCase()));

      if (submitButton) {
        submitButton.click();
        resolve("button-click");
      } else if ("function" == typeof callBuiltValidation) {
        callBuiltValidation();
        resolve("callBuiltValidation");
      } else if ("function" == typeof callGoogleValidation) {
        callGoogleValidation();
        resolve("callGoogleValidation");
      } else if (form) {
        form.submit();
        resolve("form-submit");
      } else {
        resolve("no-submit-handler");
      }
    }, submitDelayMs);
  }), FORM_SUBMIT_DELAY_MS, { loginForm: SELECTORS.loginForm });

  await page.keyboard.press("Enter").catch(() => null);

  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: TIMEOUTS.navWait }),
      page.waitForFunction(selectors => {
        if (document.querySelector(selectors.loginIndicators)) return true;
        if (document.querySelector(selectors.loginError)) return true;
        const href = String(window.location.href || "");
        return !(!href.includes("/vtop/content") && !href.includes("processLogin"));
      }, { timeout: TIMEOUTS.loginSignal }, { loginIndicators: SELECTORS.loginIndicators, loginError: SELECTORS.loginError })
    ]);
  } catch { }

  if (await isLoggedIn(page)) {
    return { state: "logged-in", errorText: "" };
  }

  const errorText = await getLoginErrorText(page);
  if (errorText) {
    return { state: "error", errorText: errorText };
  }

  return { state: "no-signal", errorText: "" };
}

async function getLoginErrorText(page) {
  return page.evaluate(errorSelector => {
    const extracted = Array.from(document.querySelectorAll(errorSelector))
      .map(el => String(el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(txt => txt && txt.length > 2);

    if (extracted.length > 0) return Array.from(new Set(extracted)).join(" | ");

    const match = String(document.body && document.body.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .match(/(invalid\s+captcha[^.]*\.?|incorrect\s+captcha[^.]*\.?|wrong\s+captcha[^.]*\.?|invalid\s+credentials[^.]*\.?|incorrect\s+password[^.]*\.?|authentication\s+failed[^.]*\.?)/i);

    return match ? match[1] : "";
  }, SELECTORS.loginErrorExtended);
}

async function runLoginAttempt(page, regNo, password, attempt) {
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });

  const loginFormState = await ensureLoginForm(page);
  if (loginFormState.alreadyLoggedIn) {
    return { loggedIn: true, message: "already authenticated" };
  }
  if (!loginFormState.ready) {
    await sleep(700 + 200 * attempt);
    return { loggedIn: false, message: "login form not ready" };
  }

  const captchaMode = await detectCaptchaMode(page);
  if ("google" === captchaMode) {
    await page.goto(OPEN_PAGE_URL, { waitUntil: "networkidle2" }).catch(() => null);
    await sleep(900 + 220 * attempt);
    return { loggedIn: false, message: "google captcha shown, rerouted to open page" };
  }
  if ("image" !== captchaMode) {
    await sleep(900 + 200 * attempt);
    return { loggedIn: false, message: `captcha mode is ${captchaMode}, waiting for image captcha` };
  }

  let submittedInAttempt = false;
  let lastReason = "login not confirmed";

  for (let solveAttempt = 1; solveAttempt <= 3; solveAttempt++) {
    if (solveAttempt > 1) {
      if (!await refreshCaptchaImage(page)) {
        lastReason = "captcha refresh failed before retry";
      }
    }

    const solved = await solveCaptchaWithModel(page, bitmaps.weights, bitmaps.biases);
    if (!solved.ok) {
      lastReason = `captcha solve failed (${solved.reason})`;
      await refreshCaptchaImage(page);
      await sleep(450);
      continue;
    }

    await fillLoginForm(page, regNo, password, solved.text);
    submittedInAttempt = true;

    const submitResult = await submitLogin(page);
    if ("logged-in" === submitResult.state || await isLoggedIn(page)) {
      return { loggedIn: true, message: `logged in (captcha solve ${solveAttempt}/3)` };
    }

    const loginErrorText = submitResult.errorText || await getLoginErrorText(page);
    if (isCredentialError(loginErrorText)) {
      throw new Error(`Credentials rejected by VTOP: ${loginErrorText}`);
    }

    if (isCaptchaError(loginErrorText)) {
      lastReason = `captcha rejected (${solveAttempt}/3)`;
    } else if (loginErrorText) {
      lastReason = shortError(loginErrorText);
    } else if ("no-signal" === submitResult.state) {
      lastReason = "no post-submit signal";
    } else {
      lastReason = `submit state: ${submitResult.state}`;
    }

    await sleep(850);
  }

  if (!submittedInAttempt) {
    lastReason = "no form submission occurred";
  }

  await sleep(750 + 220 * attempt);
  return { loggedIn: false, message: lastReason };
}

async function extractMonthSnapshot(page, monthStr) {
  return page.evaluate((mStr, monthMap, dayOfWeekByColumn, selectors) => {
    const tableContainer = document.querySelector(selectors.calendarTable);
    const table = tableContainer ? tableContainer.querySelector("tbody") : null;

    if (!table) return { events: [], monthHeaderText: "" };

    const parts = mStr.split("-");
    const monthName = parts[1].trim().toUpperCase();
    const year = parts[2].trim();
    const monthNum = monthMap[monthName];

    const compact = text => String(text || "").replace(/\s+/g, " ").trim();

    const monthHeaderText = [
      tableContainer.querySelector("thead"),
      tableContainer.previousElementSibling,
      document.querySelector(".modal-title"),
      document.querySelector(".panel-heading")
    ].filter(Boolean).map(el => compact(el.innerText)).filter(Boolean).join(" | ");

    const events = [];
    table.querySelectorAll("td").forEach((col, idx) => {
      const allSpans = Array.from(col.querySelectorAll("span"));
      if (!allSpans.length) return;

      const dateText = compact(allSpans[0].innerText);
      if (!/^\d+$/.test(dateText)) return;

      const dayNum = dateText.padStart(2, "0");
      const date = `${year}-${monthNum}-${dayNum}`;
      const dayOfWeek = dayOfWeekByColumn[idx % 7];

      const labelSpan = allSpans.slice(1).find(s => "" !== compact(s.innerText));
      const label = labelSpan ? compact(labelSpan.innerText) : "";

      let noteRaw = "";
      if (labelSpan) {
        let sibling = labelSpan.nextElementSibling;
        while (sibling && "SPAN" !== sibling.tagName) {
          sibling = sibling.nextElementSibling;
        }
        if (sibling) {
          noteRaw = compact(sibling.innerText.replace(/^\s*\(|\)\s*$/g, ""));
        }
      }
      events.push({ date: date, dayOfWeek: dayOfWeek, label: label, noteRaw: noteRaw });
    });

    return { events: events, monthHeaderText: monthHeaderText };
  }, monthStr, MONTH_ABBR_TO_NUM, DAY_OF_WEEK_BY_COLUMN, { calendarTable: SELECTORS.calendarTable });
}

async function scrapeMonthWithRetries(page, monthStr) {
  const parsedMonth = parseMonthToken(monthStr);
  if (!parsedMonth) throw new Error(`Unexpected month token from portal: ${monthStr}`);

  let monthEvents = [];

  for (let scrapeAttempt = 1; scrapeAttempt <= 4; scrapeAttempt++) {
    try {
      await page.evaluate(m => "function" == typeof processViewCalendar && processViewCalendar(m), monthStr);
      await page.waitForFunction(calendarTableBodySelector => {
        const table = document.querySelector(calendarTableBodySelector);
        if (!table) return false;
        return Array.from(table.querySelectorAll("td")).filter(cell => {
          const firstSpan = cell.querySelector("span");
          return firstSpan && /^\d+$/.test(firstSpan.innerText.trim());
        }).length >= 28;
      }, { timeout: TIMEOUTS.calendarWait }, SELECTORS.calendarTableBody);

      await sleep(1200 + 400 * scrapeAttempt);
      const monthSnapshot = await extractMonthSnapshot(page, monthStr);
      monthEvents = monthSnapshot.events;

      if (!validateRenderedMonthContext(monthStr, monthSnapshot.monthHeaderText).ok) {
        await sleep(500);
        continue;
      }

      if (validateMonthEvents(monthEvents, parsedMonth.year, parsedMonth.monthNum).ok) {
        return { events: monthEvents, attempts: scrapeAttempt };
      }
    } catch { }
    await sleep(500);
  }

  throw new Error(`Could not scrape a valid calendar snapshot for ${monthStr}; keeping previous output unchanged.`);
}

function classifyCalendar(rawData, fallbackFirstInstrDay, fallbackLastTheoryDay, fallbackLastLabDay) {
  rawData.sort((a, b) => new Date(a.date) - new Date(b.date));

  const classified = rawData.map(d => {
    const { type: type, dayOrder: dayOrder, note: note } = parseDay(d.label, d.noteRaw, d.dayOfWeek);
    return { date: d.date, dayOfWeek: d.dayOfWeek, type: type, dayOrder: dayOrder, note: note };
  });

  const instructionalDates = classified.filter(d => "Instructional" === d.type).map(d => d.date).sort();
  const lastInstrDate = instructionalDates[instructionalDates.length - 1] || null;
  const firstInstrDate = instructionalDates[0] || fallbackFirstInstrDay || null;

  if (firstInstrDate && lastInstrDate && firstInstrDate > lastInstrDate) {
    throw new Error(`Instructional boundaries are invalid: first=${firstInstrDate}, last=${lastInstrDate}`);
  }

  const finalData = classified.map(d => {
    if (null !== d.type) return d;
    if (lastInstrDate && d.date > lastInstrDate) {
      return { ...d, type: "FAT", dayOrder: 0, note: null };
    }
    return { ...d, type: "Holiday", dayOrder: 0, note: null };
  });

  const invalidInstructional = finalData.filter(d => "Instructional" === d.type && (d.dayOrder < 1 || d.dayOrder > 5));
  if (invalidInstructional.length > 0) {
    throw new Error(`Invalid instructional day order found on ${invalidInstructional[0].date}`);
  }

  let lastTheoryDate = null;
  let lastLabDate = null;
  let totalInstructional = 0;

  for (const d of finalData) {
    if ("Instructional" === d.type) {
      totalInstructional++;
      if ("Last Theory Instructional Day" === d.note) lastTheoryDate = d.date;
      if ("Last Lab Instructional Day" === d.note) lastLabDate = d.date;
    }
  }

  if (0 === totalInstructional) {
    throw new Error("No instructional days found after classification; aborting output update.");
  }

  if (!lastTheoryDate) lastTheoryDate = fallbackLastTheoryDay || null;
  if (!lastLabDate) lastLabDate = fallbackLastLabDay || null;

  return {
    finalData: finalData,
    firstInstrDate: firstInstrDate,
    lastInstrDate: lastInstrDate,
    lastTheoryDate: lastTheoryDate,
    lastLabDate: lastLabDate,
    totalInstructional: totalInstructional
  };
}

function buildOutput(targetSemester, targetYear, finalData, metadata) {
  return {
    metadata: {
      semester: targetSemester,
      year: targetYear,
      generatedAt: getISTTime(),
      totalInstructionalDays: metadata.totalInstructional,
      firstInstructionalDay: metadata.firstInstrDate,
      lastTheoryInstructionalDay: metadata.lastTheoryDate,
      lastLabInstructionalDay: metadata.lastLabDate
    },
    data: finalData.reduce((acc, day) => {
      const month = day.date.substring(0, 7);
      (acc[month] = acc[month] || []).push(day);
      return acc;
    }, {})
  };
}

async function runScraper() {
  const {
    sem: targetSemester,
    year: targetYear,
    fallback_first_instructional_day: fallback_first_instructional_day,
    fallback_last_instructional_day_theory: fallback_last_instructional_day_theory,
    fallback_last_instructional_day_lab: fallback_last_instructional_day_lab
  } = await getConfig();

  const regNo = String(process.env.VTOP_REGNO || "").trim();
  const password = String(process.env.VTOP_PASSWORD || "").trim();

  if (!regNo || !password) {
    throw new Error("Missing VTOP_REGNO or VTOP_PASSWORD in environment.");
  }

  logger.section(`🎯 Target: ${targetSemester} Semester ${targetYear}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  page.on("dialog", async dialog => dialog.accept());

  try {
    logger.section("🔐 Login");
    let loggedIn = false;

    for (let attempt = 1; attempt <= 15 && !loggedIn; attempt++) {
      const result = await runLoginAttempt(page, regNo, password, attempt);
      const prefix = `[${attempt}/15]`;

      if (result.loggedIn) {
        logger.ok(`${prefix} ${result.message}`);
        loggedIn = true;
        break;
      }
      logger.warn(`${prefix} ${result.message}`);
    }

    if (!loggedIn) throw new Error("Failed to login.");

    await sleep(TIMEOUTS.postLogin);

    await page.evaluate(() => {
      document.querySelector(".bootbox-accept, .modal-footer .btn-primary")?.click();
      document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
      document.body.classList.remove("modal-open");
    });

    await page.waitForSelector(SELECTORS.calendarLink, { timeout: TIMEOUTS.semesterUi });
    await page.evaluate(calendarLink => document.querySelector(calendarLink)?.click(), SELECTORS.calendarLink);
    await page.waitForSelector(SELECTORS.semesterSubId, { timeout: TIMEOUTS.semesterUi });

    const semesterValue = await page.evaluate((semesterSelector, sem, year) => {
      const target = `${sem} Semester ${year}`.toLowerCase();
      const option = Array.from(document.querySelectorAll(`${semesterSelector} option`))
        .find(o => o.innerText.toLowerCase().includes(target) && o.innerText.includes("VLR"));
      return option ? option.value : null;
    }, SELECTORS.semesterSubId, targetSemester, targetYear);

    if (!semesterValue) throw new Error("Could not find semester ID");

    await page.select(SELECTORS.semesterSubId, semesterValue);
    await sleep(1500);
    await page.select(SELECTORS.classGroupId, "ALL");
    await sleep(2000);

    await page.waitForSelector(SELECTORS.monthButtons, { timeout: TIMEOUTS.monthList });
    const monthsToFetch = await page.evaluate(monthButtonsSelector =>
      Array.from(document.querySelectorAll(monthButtonsSelector))
        .map(btn => btn.getAttribute("onclick")?.match(/'([^']+)'/)?.[1])
        .filter(Boolean)
      , SELECTORS.monthButtons);

    logger.section(`📅 Months (${monthsToFetch.length})`);

    const rawData = [];
    const seenDates = new Set();

    for (const monthStr of monthsToFetch) {
      const { events: monthEvents, attempts: attempts } = await scrapeMonthWithRetries(page, monthStr);

      for (const event of monthEvents) {
        if (seenDates.has(event.date)) {
          throw new Error(`Duplicate date detected across months: ${event.date}`);
        }
        seenDates.add(event.date);
      }

      rawData.push(...monthEvents);
      const retryInfo = attempts > 1 ? ` (retry x${attempts - 1})` : "";
      logger.ok(`[${monthTag(monthStr)}] ${monthEvents.length} days${retryInfo}`);
    }

    const classified = classifyCalendar(rawData, fallback_first_instructional_day, fallback_last_instructional_day_theory, fallback_last_instructional_day_lab);

    logger.section("🧾 Summary");
    logger.info(`Instructional days: ${classified.totalInstructional}`);
    logger.info(`First instructional day: ${classified.firstInstrDate}`);
    logger.info(`Last instructional day: ${classified.lastInstrDate}`);
    logger.info(`Last theory instructional day: ${classified.lastTheoryDate}`);
    logger.info(`Last lab instructional day: ${classified.lastLabDate}`);

    const output = buildOutput(targetSemester, targetYear, classified.finalData, classified);
    const dirPath = path.join(__dirname, "calendars", targetYear);
    fs.mkdirSync(dirPath, { recursive: true });

    writeJsonAtomically(path.join(dirPath, `${targetSemester}.json`), output);
    logger.ok(`Saved calendars/${targetYear}/${targetSemester}.json`);

  } finally {
    await browser.close();
  }
}

runScraper().catch(error => console.error("❌ Fatal:", error));