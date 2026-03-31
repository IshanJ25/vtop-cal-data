require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const bitmaps = require('./bitmaps');

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getConfig() {
  let sem = 'Winter', year = '2025';
  let fallback_first_instructional_day = null;
  let fallback_last_instructional_day_theory = null;
  let fallback_last_instructional_day_lab = null;
  try {
    const config = fs.readFileSync(path.join(__dirname, 'curr_sem.txt'), 'utf8');
    const semMatch = config.match(/sem\s*=\s*(.+)/);
    const yearMatch = config.match(/year\s*=\s*(.+)/);
    const firstInstrMatch = config.match(/fallback_first_instructional_day\s*=\s*(.+)/);
    const lastTheoryMatch = config.match(/fallback_last_instructional_day_theory\s*=\s*(.+)/);
    const lastLabMatch = config.match(/fallback_last_instructional_day_lab\s*=\s*(.+)/);

    if (semMatch) sem = semMatch[1].trim();
    if (yearMatch) year = yearMatch[1].trim();
    if (firstInstrMatch) fallback_first_instructional_day = firstInstrMatch[1].trim();
    if (lastTheoryMatch) fallback_last_instructional_day_theory = lastTheoryMatch[1].trim();
    if (lastLabMatch) fallback_last_instructional_day_lab = lastLabMatch[1].trim();
  } catch {
    console.warn(`⚠️ curr_sem.txt not found. Using defaults.`);
  }
  return { sem, year, fallback_first_instructional_day, fallback_last_instructional_day_theory, fallback_last_instructional_day_lab };
}

// ============================================================
// DAY ORDER MAP
// ============================================================
const DAY_ORDER_MAP = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5
};

// ============================================================
// LABEL ALIASES
// Maps known website label variants → canonical form.
// ============================================================
const LABEL_ALIASES = {
  'instruction day': 'Instructional Day',
  'instructional days': 'Instructional Day',
  'instructons day': 'Instructional Day',
  'holidays': 'Holiday',
  'no instruction day': 'No Instructional Day',
  'non instructional day': 'No Instructional Day',
  'no-instructional day': 'No Instructional Day',
  'cat-i': 'CAT - I',
  'cat- i': 'CAT - I',
  'cat -i': 'CAT - I',
  'cat i': 'CAT - I',
  'cat1': 'CAT - I',
  'cat – i': 'CAT - I',
  'cat-ii': 'CAT - II',
  'cat- ii': 'CAT - II',
  'cat -ii': 'CAT - II',
  'cat ii': 'CAT - II',
  'cat2': 'CAT - II',
  'cat – ii': 'CAT - II',
};

// ============================================================
// NOTE ALIASES
// Maps known inconsistent note strings → canonical form.
// Sources: confirmed variants observed in the HTML calendar
// data (truncated periods, missing "Day", lowercase, verbose).
// ============================================================
const NOTE_ALIASES = {
  // Day-order notes where the word "Day" is absent (live website bug, e.g. Aug-30)
  'monday order': 'Monday Day Order',
  'tuesday order': 'Tuesday Day Order',
  'wednesday order': 'Wednesday Day Order',
  'thursday order': 'Thursday Day Order',
  'friday order': 'Friday Day Order',

  // Last-instructional-day variants (truncation, abbreviation, reordering)
  'last instructional day for lab.': 'Last Instructional Day for Laboratory Classes',
  'last instructional day for lab': 'Last Instructional Day for Laboratory Classes',
  'last instructional day for laboratory': 'Last Instructional Day for Laboratory Classes',
  'last lab instructional day': 'Last Instructional Day for Laboratory Classes',
  'last instructional day for laboratory classes': 'Last Instructional Day for Laboratory Classes',
  'last instructional day for theory': 'Last Instructional Day for Theory Classes',
  'last theory instructional day': 'Last Instructional Day for Theory Classes',
  'last instructional day for theory classes': 'Last Instructional Day for Theory Classes',

  // First-day variants
  'first instruction day': 'First Instructional Day',
  'first day of instruction': 'First Instructional Day',
  'first day of instructions': 'First Instructional Day',

  // // FAT commencement verbose form
  // 'commencement of fat for lab courses / components': 'Commencement of FAT',
  // 'commencement of fat for lab courses': 'Commencement of FAT',
  // 'commencement of fat for laboratory courses': 'Commencement of FAT',
  // 'start of fat': 'Commencement of FAT',
  // 'fat commencement': 'Commencement of FAT',
};

function normalizeLabel(raw) {
  const key = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  return LABEL_ALIASES[key] || raw.trim();
}

function normalizeNote(raw) {
  const key = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  return NOTE_ALIASES[key] || raw.trim();
}

// ============================================================
// parseDay
// ============================================================
function parseDay(label, noteRaw, dayOfWeek) {
  const normLabel = normalizeLabel(label);
  const normNote = normalizeNote(noteRaw);
  const labelLower = normLabel.toLowerCase().trim();
  const noteLower = normNote.toLowerCase().trim();

  if (!labelLower) return { type: null, dayOrder: 0, note: null };

  // --- INSTRUCTIONAL DAY ---
  if (labelLower === 'instructional day') {
    let dayOrder;

    // Accepts "Monday Day Order" AND "Monday Order" (website omits "Day" on some entries)
    // Matches anywhere in the note string to support composite notes like "Last instructional day for lab, Friday Day Order"
    const dayOrderMatch = noteLower.match(
      /(monday|tuesday|wednesday|thursday|friday)\s+(?:day\s+)?order/i
    );
    if (dayOrderMatch) {
      dayOrder = DAY_ORDER_MAP[dayOrderMatch[1].toLowerCase()];
    } else {
      dayOrder = (dayOfWeek >= 1 && dayOfWeek <= 5) ? dayOfWeek : 0;
    }

    let note = null;
    if (/first\s+instructional\s+day/i.test(normNote)) {
      note = 'First Instructional Day';
    } else if (/last.*instructional.*day.*lab(?:oratory)?/i.test(normNote)) {
      note = 'Last Lab Instructional Day';
    } else if (/last.*instructional.*day.*theory/i.test(normNote)) {
      note = 'Last Theory Instructional Day';
      // } else if (/commencement.*fat/i.test(normNote)) {
      //   note = 'Commencement of FAT';
    }

    return { type: 'Instructional', dayOrder, note };
  }

  // --- HOLIDAY ---
  if (labelLower === 'holiday') {
    return { type: 'Holiday', dayOrder: 0, note: normNote || null };
  }

  // --- NO INSTRUCTIONAL DAY ---
  if (labelLower === 'no instructional day') {
    return { type: 'Holiday', dayOrder: 0, note: normNote || null };
  }

  // --- CAT - I ---
  if (/^cat\s*[-–]\s*i$/i.test(labelLower) || labelLower === 'cat1') {
    return { type: 'CAT-1', dayOrder: 0, note: null };
  }

  // --- CAT - II ---
  if (/^cat\s*[-–]\s*ii$/i.test(labelLower) || labelLower === 'cat2') {
    return { type: 'CAT-2', dayOrder: 0, note: null };
  }

  console.warn(`⚠️ Unknown label: "${label}" (normalised: "${normLabel}") — treating as Holiday`);
  return { type: 'Holiday', dayOrder: 0, note: normNote || label };
}

async function runScraper() {
  const {
    sem: targetSemester,
    year: targetYear,
    fallback_first_instructional_day,
    fallback_last_instructional_day_theory,
    fallback_last_instructional_day_lab
  } = await getConfig();
  console.log(`\n🎯 TARGET: ${targetSemester} Semester ${targetYear}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.on('dialog', async dialog => await dialog.accept());

  let loggedIn = false, attempts = 0;

  while (!loggedIn && attempts < 15) {
    console.log(`--- Login Attempt ${++attempts} ---`);
    await page.goto('https://vtop.vit.ac.in/vtop/login', { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector('.btn-primary', { timeout: 3000 });
      await page.click('.btn-primary');
      await sleep(1500);
    } catch { }

    const captchaImg = await page.$('#captchaBlock img');
    if (!captchaImg) continue;

    const solvedText = await page.evaluate((weights, biases) => {
      const img = document.querySelector('#captchaBlock img');
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 40;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 200, 40);
      const { data } = ctx.getImageData(0, 0, 200, 40);

      const saturate = (d) => {
        let sat = new Array(d.length / 4);
        for (let i = 0; i < d.length; i += 4) {
          let min = Math.min(d[i], d[i + 1], d[i + 2]);
          let max = Math.max(d[i], d[i + 1], d[i + 2]);
          sat[i / 4] = max === 0 ? 0 : Math.round(((max - min) * 255) / max);
        }
        let arr = Array.from({ length: 40 }, (_, i) => Array.from({ length: 200 }, (_, j) => sat[i * 200 + j]));
        return Array.from({ length: 6 }, (_, i) =>
          arr.slice(7 + 5 * (i % 2) + 1, 35 - 5 * ((i + 1) % 2)).map(row => row.slice((i + 1) * 25 + 2, (i + 2) * 25 + 1))
        );
      };

      const processBlock = (block) => {
        let avg = block.flat().reduce((a, b) => a + b, 0) / (block.length * block[0].length);
        let bits = block.map(row => row.map(val => val > avg ? 1 : 0)).flat();
        let mul = weights[0].map((_, j) => bits.reduce((sum, b, k) => sum + b * weights[k][j], 0));
        let added = mul.map((val, i) => val + biases[i]);
        let expSum = added.reduce((sum, val) => sum + Math.exp(val), 0);
        let softmax = added.map(val => Math.exp(val) / expSum);
        return 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[softmax.indexOf(Math.max(...softmax))];
      };
      return saturate(data).map(processBlock).join('');
    }, bitmaps.weights, bitmaps.biases);

    console.log(`ML Matched result: ${solvedText}`);
    await page.type('#username', process.env.VTOP_REGNO);
    await page.type('#password', process.env.VTOP_PASSWORD);
    await page.type('#captchaStr', solvedText);

    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }),
        page.evaluate(() => typeof callBuiltValidation === 'function' && callBuiltValidation())
      ]);
    } catch { }

    if (await page.$('#vtop-header')) loggedIn = true;
  }

  if (!loggedIn) throw new Error("Failed to login.");

  await sleep(3000);
  await page.evaluate(() => {
    document.querySelector('.bootbox-accept, .modal-footer .btn-primary')?.click();
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    document.body.classList.remove('modal-open');
  });

  await page.waitForSelector('a[data-url="academics/common/CalendarPreview"]', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('a[data-url="academics/common/CalendarPreview"]')?.click());
  await page.waitForSelector('#semesterSubId', { timeout: 15000 });

  const semesterValue = await page.evaluate((sem, year) => {
    const target = `${sem} Semester ${year}`.toLowerCase();
    const opt = Array.from(document.querySelectorAll('#semesterSubId option'))
      .find(o => o.innerText.toLowerCase().includes(target) && o.innerText.includes('VLR'));
    return opt ? opt.value : null;
  }, targetSemester, targetYear);

  if (!semesterValue) throw new Error(`Could not find semester ID`);

  await page.select('#semesterSubId', semesterValue);
  await sleep(1500);
  await page.select('#classGroupId', 'ALL');
  await sleep(2000);
  await page.waitForSelector('#getListForSemester a.btn-primary', { timeout: 10000 });

  const monthsToFetch = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#getListForSemester a.btn-primary'))
      .map(btn => btn.getAttribute('onclick').match(/'([^']+)'/)?.[1])
      .filter(Boolean)
  );

  console.log(`Scraping ${monthsToFetch.length} months...`);

  let rawData = [];

  for (const monthStr of monthsToFetch) {
    await page.evaluate((m) => typeof processViewCalendar === 'function' && processViewCalendar(m), monthStr);
    await sleep(3000);

    const monthEvents = await page.evaluate((mStr) => {
      const table = document.querySelector('.calendar-table:last-of-type tbody');
      if (!table) return [];

      const monthMap = {
        JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
        JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
      };
      const parts = mStr.split('-');
      const mName = parts[1];
      const year = parts[2];
      const monthNum = monthMap[mName];

      const colDayOfWeek = [7, 1, 2, 3, 4, 5, 6];

      const events = [];
      table.querySelectorAll('td').forEach((col, idx) => {
        const allSpans = Array.from(col.querySelectorAll('span'));
        if (!allSpans.length) return;

        const dateText = allSpans[0].innerText.trim();
        if (!dateText || !/^\d+$/.test(dateText)) return;

        const dayNum = dateText.padStart(2, '0');
        const date = `${year}-${monthNum}-${dayNum}`;
        const dayOfWeek = colDayOfWeek[idx % 7];

        const labelSpan = allSpans.slice(1).find(s => s.innerText.trim() !== '');
        const label = labelSpan ? labelSpan.innerText.trim() : '';

        let noteRaw = '';
        if (labelSpan) {
          let sibling = labelSpan.nextElementSibling;
          while (sibling && sibling.tagName !== 'SPAN') sibling = sibling.nextElementSibling;
          if (sibling) {
            noteRaw = sibling.innerText.replace(/^\s*\(|\)\s*$/g, '').trim();
          }
        }

        events.push({ date, dayOfWeek, label, noteRaw });
      });

      return events;
    }, monthStr);

    rawData.push(...monthEvents);
    console.log(`  → ${monthStr}: ${monthEvents.length} days scraped`);
  }

  await browser.close();

  // ============================================================
  // CLASSIFY
  // ============================================================
  console.log("Classifying days...");
  rawData.sort((a, b) => new Date(a.date) - new Date(b.date));

  const classified = rawData.map(d => {
    const { type, dayOrder, note } = parseDay(d.label, d.noteRaw, d.dayOfWeek);
    return { date: d.date, dayOfWeek: d.dayOfWeek, type, dayOrder, note };
  });

  // ============================================================
  // FAT BOUNDARY
  // Derived directly from the last Instructional-type day in the
  // classified data — intentionally does NOT depend on note text,
  // so it works even when the website omits or misspells the
  // "Last Instructional Day" note entirely.
  // ============================================================
  const instructionalDates = classified
    .filter(d => d.type === 'Instructional')
    .map(d => d.date)
    .sort();

  const lastInstrDate = instructionalDates[instructionalDates.length - 1] || null;
  const firstInstrDate = instructionalDates[0] || fallback_first_instructional_day || null;

  console.log(`  First Instructional : ${firstInstrDate}`);
  console.log(`  Last Instructional  : ${lastInstrDate}`);

  // ============================================================
  // FILL GAPS — Holiday before/within semester, FAT after it
  // ============================================================
  const finalData = classified.map(d => {
    if (d.type !== null) return d;

    if (lastInstrDate && d.date > lastInstrDate) {
      return { ...d, type: 'FAT', dayOrder: 0, note: null };
    }

    return { ...d, type: 'Holiday', dayOrder: 0, note: null };
  });

  // ============================================================
  // METADATA — scan final data for milestone notes and counts
  // ============================================================
  let lastTheoryDate = null;
  let lastLabDate = null;
  let totalInstructional = 0;

  for (const d of finalData) {
    if (d.type !== 'Instructional') continue;
    totalInstructional++;
    if (d.note === 'Last Theory Instructional Day') lastTheoryDate = d.date;
    if (d.note === 'Last Lab Instructional Day') lastLabDate = d.date;
  }

  if (!lastTheoryDate) lastTheoryDate = fallback_last_instructional_day_theory || null;
  if (!lastLabDate) lastLabDate = fallback_last_instructional_day_lab || null;

  console.log(`  Last Theory         : ${lastTheoryDate}`);
  console.log(`  Last Lab            : ${lastLabDate}`);
  console.log(`  Total Instructional : ${totalInstructional}`);

  // ============================================================
  // OUTPUT
  // ============================================================
  const getISTTime = () => {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}::${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  const output = {
    metadata: {
      semester: targetSemester,
      year: targetYear,
      generatedAt: getISTTime(),
      totalInstructionalDays: totalInstructional,
      firstInstructionalDay: firstInstrDate,
      lastTheoryInstructionalDay: lastTheoryDate,
      lastLabInstructionalDay: lastLabDate,
    },
    data: finalData.reduce((acc, day) => {
      const month = day.date.substring(0, 7);
      (acc[month] = acc[month] || []).push(day);
      return acc;
    }, {})
  };

  const dirPath = path.join(__dirname, 'calendars', targetYear);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, `${targetSemester}.json`),
    JSON.stringify(output, null, 2)
  );
  console.log(`\n✅ Scrape complete: calendars/${targetYear}/${targetSemester}.json`);
}

runScraper().catch(e => console.error("❌ Fatal:", e));