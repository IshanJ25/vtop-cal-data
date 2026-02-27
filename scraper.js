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
  try {
    const config = fs.readFileSync(path.join(__dirname, 'curr_sem.txt'), 'utf8');
    const semMatch = config.match(/sem\s*=\s*(.+)/);
    const yearMatch = config.match(/year\s*=\s*(.+)/);
    if (semMatch) sem = semMatch[1].trim();
    if (yearMatch) year = yearMatch[1].trim();
  } catch {
    console.warn(`⚠️ curr_sem.txt not found. Using defaults.`);
  }
  return { sem, year };
}

async function runScraper() {
  const { sem: targetSemester, year: targetYear } = await getConfig();
  console.log(`\n🎯 TARGET: ${targetSemester} Semester ${targetYear}\n`);

  const browser = await puppeteer.launch({
    headless: true,  // TRUE for GitHub Actions
    // headless: false,  // FALSE for local debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.on('dialog', async dialog => await dialog.accept());

  let loggedIn = false, attempts = 0;

  // --- LOGIN ENGINE ---
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

  // --- NAVIGATION ---
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
  await sleep(2000); // Wait for the months list to update after selecting 'ALL'
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
      const monthMap = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
      const [_, mName, year] = mStr.split('-');
      const monthNum = monthMap[mName];
      const isoDayMap = [7, 1, 2, 3, 4, 5, 6]; // Sun=7, Mon=1...

      let events = [];
      table.querySelectorAll('td').forEach((col, idx) => {
        const text = col.innerText.trim();
        if (!text) return;
        const dateMatch = text.match(/^(\d+)/);
        if (!dateMatch) return;

        const dayNum = dateMatch[1];
        const noteText = Array.from(col.querySelectorAll('span'))
          .slice(1).map(s => s.innerText.trim()).filter(t => t).join(' ') || text.replace(/^\d+/, '').trim();

        events.push({
          date: `${year}-${monthNum}-${dayNum.padStart(2, '0')}`,
          dayOfWeek: isoDayMap[idx % 7],
          rawDetails: noteText || null
        });
      });
      return events;
    }, monthStr);
    rawData.push(...monthEvents);
  }
  await browser.close();

  // ==========================================
  // 🚀 CLEANING & RESTRUCTURING ENGINE
  // ==========================================
  console.log("Restructuring into strict schema...");
  rawData.sort((a, b) => new Date(a.date) - new Date(b.date));

  const firstDate = new Date(`${rawData[0].date}T00:00:00Z`);
  const lastDate = new Date(`${rawData[rawData.length - 1].date}T00:00:00Z`);
  const lastInstrDate = new Date(rawData.filter(e => e.rawDetails?.toLowerCase().includes('instructional') && !e.rawDetails?.toLowerCase().includes('no instructional')).pop()?.date + "T00:00:00Z");

  let finalContiguousData = [];
  let prevHolidayNote = null;
  let totalInstructional = 0;
  let curr = new Date(firstDate);

  while (curr <= lastDate) {
    const dStr = curr.toISOString().split('T')[0];
    const jsDay = curr.getUTCDay() || 7;
    const existing = rawData.find(x => x.date === dStr);

    let type = null, note = null, raw = existing?.rawDetails || "";
    let rawLower = raw.toLowerCase();

    // 1. Classification
    if (rawLower.includes('cat - ii') || rawLower.includes('cat 2')) type = 'CAT-2';
    else if (rawLower.includes('cat - i') || rawLower.includes('cat 1')) type = 'CAT-1';
    else if (rawLower.includes('instructional') && !rawLower.includes('no instructional')) {
      type = 'Instructional';
      totalInstructional++;
    } else if (raw) type = 'Holiday';

    // 2. Note Logic
    if (raw.includes('(')) note = raw.substring(raw.indexOf('(') + 1, raw.lastIndexOf(')')).trim();
    else if (!['instructional day', 'holiday', 'no instructional day'].includes(rawLower) && raw) note = raw;

    // 3. Holiday Memory (Prevents empty vacation boxes)
    if (type === 'Holiday' && note && (rawLower.includes('vacation') || rawLower.includes('break') || rawLower.includes('riviera'))) prevHolidayNote = note;
    else if (type === 'Instructional') prevHolidayNote = null;

    // 4. Fill Empty Box Heuristics
    if (!type && !note) {
      if (curr > lastInstrDate) {
        type = null;
        note = 'FAT Exams (Refer to schedule)';
      } else if (prevHolidayNote) {
        type = 'Holiday';
        note = prevHolidayNote;
      } else {
        type = 'Holiday';
        if (jsDay === 7) note = null;
      }
    }

    if (note) note = note.replace(/ Day Order/gi, ' Order').trim();

    finalContiguousData.push({ date: dStr, dayOfWeek: jsDay, type, note });
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  const output = {
    metadata: {
      semester: targetSemester,
      year: targetYear,
      generatedAt: new Date().toISOString(),
      totalInstructionalDays: totalInstructional
    },
    data: finalContiguousData.reduce((acc, day) => {
      const month = day.date.substring(0, 7);
      (acc[month] = acc[month] || []).push(day);
      return acc;
    }, {})
  };

  const dirPath = path.join(__dirname, 'calendars', targetYear);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, `${targetSemester}.json`), JSON.stringify(output, null, 2));
  console.log(`✅ Scrape complete: calendars/${targetYear}/${targetSemester}.json`);
}

runScraper().catch(e => console.error("❌ Fatal:", e));