const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { PrismaClient } = require('@prisma/client');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
const prisma = new PrismaClient();

const TF_BASE = 'https://account.tradersfamily.id';
const TF_EMAIL = process.env.TF_EMAIL || '';
const TF_PASSWORD = process.env.TF_PASSWORD || '';

let browser = null;
let page = null;
let isLoggedIn = false;

function num(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return Math.floor(val);
  const res = parseInt(String(val).replace(/[^0-9-]/g, ''));
  return isNaN(res) ? 0 : res;
}

function curr(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0;
}

function parseK(s) {
  const u = String(s).toUpperCase().trim();
  let m = 1;
  if (u.includes('K')) m = 1000;
  if (u.includes('M')) m = 1000000;
  return parseFloat(u.replace(/[^0-9.]/g, '')) * m || 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchBrowser() {
  if (browser) return;
  browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
}

async function loginTF() {
  if (isLoggedIn) return;
  await launchBrowser();

  console.log('[TF] Navigating to login...');
  await page.goto(`${TF_BASE}/login/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('[TF] Waiting for Cloudflare challenge...');
  try {
    await page.waitForFunction(
      () => document.querySelector('input[name="logname"]') !== null,
      { timeout: 60000 }
    );
    console.log('[TF] Login form found');
  } catch {
    throw new Error('Login form not found after CF challenge');
  }

  await page.type('input[name="logname"]', TF_EMAIL, { delay: 50 });
  await page.type('input[name="pass"]', TF_PASSWORD, { delay: 50 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
    page.evaluate(() => document.querySelector('#btn-signin')?.click()),
  ]);

  await sleep(5000);

  const url = page.url();
  if (url.includes('/dashboard') || url === TF_BASE + '/' || url === TF_BASE) {
    console.log('[TF] Login OK');
    isLoggedIn = true;
  } else {
    console.warn('[TF] Login may have failed, URL:', url);
  }
}

async function fetchChannellistFromTF(limit = 36, offset = 0) {
  if (!isLoggedIn) await loginTF();

  const formData = new URLSearchParams({
    limit: limit.toString(), offset: offset.toString(),
    sort: 'total_profit', period: '12',
    max_loss: '0', price: '0.5', sort_order: 'desc', symbol: '',
  }).toString();

  const result = await page.evaluate(async (baseUrl, body) => {
    const res = await fetch(`${baseUrl}/channels/ajax/symbollistNew/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body,
    });
    return await res.text();
  }, TF_BASE, formData);

  if (result.length < 300) return [];

  const blocks = result.split('data-id="');
  blocks.shift();

  const traders = [];
  for (const block of blocks) {
    const idEnd = block.indexOf('"');
    let channelId = block.slice(0, idEnd);

    const cartMatch = block.match(/addToCart\('(\d+)'/);
    if ((!channelId || channelId === '1' || channelId.length < 3) && cartMatch) channelId = cartMatch[1];
    if (!channelId || channelId === '0' || channelId === '1') continue;

    const subsMatch = block.match(/<p class="txt-subs-new-2">(\d+)<\/p>/);
    const rankMatch = block.match(/<b class="text-green"[^>]*>([^<]+)<\/b>/);
    const medalMatch = block.match(/Medal (\d+)/);

    let username = 'Unknown';
    const name1 = block.match(/class="user_name"[^>]*>[\s\S]*?<p[^>]*>([^<]+)<\/p>/);
    if (name1) username = name1[1].trim();
    else {
      const name2 = block.match(/addToCart\([^,]+,\s*'[^']*',\s*`([^`]+)`/);
      if (name2) username = name2[1];
    }

    let priceRp = '0';
    const priceMatch = block.match(/Rp([\d.]+)/);
    if (priceMatch) priceRp = priceMatch[1].replace(/\./g, '');
    else if (block.match(/\bFree\b/)) priceRp = '0';

    let profitRaw = '0';
    const pm1 = block.match(/(\d+\.?\d*K?)\s*<span class="spanDescPips">Pips[\s\S]*?Total Profit/);
    if (pm1) profitRaw = pm1[1];
    else {
      const pm2 = block.match(/color: #00b451[^>]*>\s*(\d+\.?\d*K?\s*)/);
      if (pm2) profitRaw = pm2[1];
    }

    let pips = '0';
    const am = block.match(/Avg\. Monthly Profit[\s\S]*?span class="summary-value"[^>]*>\s*(\d+\.?\d*)\s*Pips/);
    if (am) pips = am[1];

    let postMo = '0';
    const pmMatch = block.match(/Post\/Month[\s\S]*?baseline-flex[^>]*>\s*(\d+)/);
    if (pmMatch) postMo = pmMatch[1];

    traders.push({
      id: channelId, username,
      rank: rankMatch?.[1]?.trim() || 'Unknown',
      medal_level: parseInt(medalMatch?.[1] || '0'),
      subs: subsMatch?.[1] || '0',
      price_rp: priceRp, profit: profitRaw, pips, jml_signal: postMo,
    });
  }

  return traders;
}

async function fetchChannelSummaryFromTF(channelId, period = '1Y') {
  if (!isLoggedIn) await loginTF();
  return page.evaluate(async (baseUrl, id, p) => {
    const res = await fetch(`${baseUrl}/channels/ajax/getChannelSummaryx/${id}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ period: p }).toString(),
    });
    return await res.json();
  }, TF_BASE, channelId, period);
}

async function fetchHistoryFromTF(channelId, start, end, limit = 100) {
  if (!isLoggedIn) await loginTF();
  const allSignals = [];
  let offset = 0;
  const batchLimit = 100;

  while (true) {
    const body = new URLSearchParams({
      active: '0', offset: offset.toString(), limit: batchLimit.toString(),
      'search[close_time_start]': start, 'search[close_time_end]': end,
    }).toString();

    const fetched = await page.evaluate(async (baseUrl, id, b) => {
      const res = await fetch(`${baseUrl}/channels/ajax/historySignal/${id}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: b,
      });
      const json = await res.json();
      if (Array.isArray(json?.message)) return json.message;
      if (Array.isArray(json?.rows)) return json.rows;
      if (Array.isArray(json)) return json;
      return [];
    }, TF_BASE, channelId, body);

    if (fetched.length === 0) break;
    allSignals.push(...fetched);
    offset += fetched.length;
    if (fetched.length < batchLimit) break;
    if (allSignals.length >= limit) break;
    await sleep(100);
  }

  return allSignals.slice(0, limit);
}

async function scrapeAndSaveChannels(limit = 1000) {
  console.log(`[Cron] Scrape channel list (limit: ${limit})...`);
  let collected = 0;
  let currentOffset = 0;

  while (collected < limit) {
    const chunk = Math.min(100, limit - collected);
    const channels = await fetchChannellistFromTF(chunk, currentOffset);
    if (channels.length === 0) break;

    const validItems = channels.filter((c) => c.id && c.id !== '0');
    if (validItems.length === 0) break;

    for (const item of validItems) {
      await prisma.tradersData.upsert({
        where: { channelId: item.id },
        update: {
          username: item.username,
          rank: item.rank,
          subscribers: num(item.subs),
          price: curr(item.price_rp),
          postedSignal: num(item.jml_signal),
          updatedAt: new Date(),
        },
        create: {
          channelId: item.id,
          period: '1Y',
          username: item.username,
          rank: item.rank,
          subscribers: num(item.subs),
          price: curr(item.price_rp),
          postedSignal: num(item.jml_signal),
          extraData: {},
        },
      });

      await prisma.tblAntrian.upsert({
        where: { idChannel: item.id },
        update: { process: 'summary', active: true, updatedAt: new Date() },
        create: { idChannel: item.id, process: 'summary', active: true },
      });
    }

    console.log(`[Cron] Upserted ${validItems.length} channels`);
    collected += validItems.length;
    currentOffset += channels.length;
  }

  console.log(`[Cron] Channel list done. Total: ${collected}`);
  return collected;
}

async function processQueue(batchSize = 5) {
  const jobs = await prisma.tblAntrian.findMany({
    where: { active: true },
    orderBy: [{ process: 'desc' }, { createdAt: 'asc' }],
    take: batchSize,
  });

  if (jobs.length === 0) return 0;

  for (const job of jobs) {
    try {
      const summary = await fetchChannelSummaryFromTF(job.idChannel);
      if (!summary?.summary) {
        await prisma.tblAntrian.update({ where: { id: job.id }, data: { active: false, process: 'error' } });
        continue;
      }

      const s = summary.summary;
      const title = (s.title || 'Unknown').replace(/\s*\(\d+\)$/, '').trim();
      const winCount = num(s.jml_profit);
      const lossCount = num(s.jml_loss);
      const drawCount = num(s.jml_draw);
      const settledSignal = winCount + lossCount + drawCount;

      await prisma.tradersData.update({
        where: { channelId: job.idChannel },
        data: {
          username: title,
          rank: s.rank || '-',
          subscribers: num(s.subs),
          ageMonths: num(s.bulan),
          winCount, lossCount, drawCount,
          postedSignal: num(s.jml_signal),
          settledSignal,
          avgTpPips: curr(s.avg_tp_pips),
          avgSlPips: curr(s.avg_sl_pips),
          consWin: num(s.consecutiveProfitCount),
          consLoss: num(s.consecutiveLossCount),
          avgHoldSec: num(s.avg_holding_sec),
          extraData: s,
          updatedAt: new Date(),
        },
      });

      await prisma.tblAntrian.update({ where: { id: job.id }, data: { active: false } });
      console.log(`[Queue] Processed: ${title}`);
    } catch (error) {
      console.error(`[Queue] Error ${job.idChannel}:`, error.message);
      await prisma.tblAntrian.update({ where: { id: job.id }, data: { active: false, process: 'error' } }).catch(() => {});
    }
  }

  return jobs.length;
}

let isProcessing = false;
setInterval(async () => {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const processed = await processQueue(10);
    if (processed > 0) console.log(`[Worker] Processed ${processed} jobs`);
  } catch (error) {
    console.error('[Worker] Queue error:', error.message);
  } finally {
    isProcessing = false;
  }
}, 30000);

cron.schedule('0 3 * * *', async () => {
  console.log('[Cron] Update-all starting (2000 channels)...');
  try {
    await scrapeAndSaveChannels(2000);
    console.log('[Cron] Update-all done');
  } catch (error) {
    console.error('[Cron] Update-all error:', error.message);
  }
});

cron.schedule('15 3 * * *', async () => {
  console.log('[Cron] Process-all queue starting...');
  try {
    let total = 0;
    while (true) {
      const processed = await processQueue(20);
      if (processed === 0) break;
      total += processed;
      console.log(`[Cron] Processed batch: ${processed} (total: ${total})`);
    }
    console.log(`[Cron] Process-all done. Total: ${total}`);
  } catch (error) {
    console.error('[Cron] Process-all error:', error.message);
  }
});

cron.schedule('0 15 * * *', async () => {
  console.log('[Cron] Update-all starting (2000 channels)...');
  try {
    await scrapeAndSaveChannels(2000);
    console.log('[Cron] Update-all done');
  } catch (error) {
    console.error('[Cron] Update-all error:', error.message);
  }
});

cron.schedule('15 15 * * *', async () => {
  console.log('[Cron] Process-all queue starting...');
  try {
    let total = 0;
    while (true) {
      const processed = await processQueue(20);
      if (processed === 0) break;
      total += processed;
      console.log(`[Cron] Processed batch: ${processed} (total: ${total})`);
    }
    console.log(`[Cron] Process-all done. Total: ${total}`);
  } catch (error) {
    console.error('[Cron] Process-all error:', error.message);
  }
});

cron.schedule('0 8 1 * *', async () => {
  console.log('[Cron] Monthly archive starting...');
  try {
    const now = new Date();
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const periodLabel = `${months[now.getMonth()]}-${now.getFullYear()}`;

    const channels = await prisma.tradersData.findMany();
    for (const ch of channels) {
      await prisma.tradersDataArchive.create({
        data: {
          channelId: ch.channelId, period: ch.period, username: ch.username,
          rank: ch.rank, medal: ch.medal, subscribers: ch.subscribers,
          price: ch.price, ageMonths: ch.ageMonths,
          winCount: ch.winCount, lossCount: ch.lossCount, drawCount: ch.drawCount,
          postedSignal: ch.postedSignal, settledSignal: ch.settledSignal,
          avgTpPips: ch.avgTpPips, avgSlPips: ch.avgSlPips,
          consWin: ch.consWin, consLoss: ch.consLoss,
          extraData: ch.extraData, periodLabel,
        },
      });
    }

    await scrapeAndSaveChannels(2000);
    console.log(`[Cron] Archive done. ${channels.length} channels archived`);
  } catch (error) {
    console.error('[Cron] Archive error:', error.message);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'MHC Studio API', version: '2.0.0', timestamp: new Date().toISOString() });
});

app.get('/api/channellist', async (req, res) => {
  try {
    if (!isLoggedIn) await loginTF();

    const offset = req.query.offset || '0';
    const limit = req.query.limit || '36';

    const formData = new URLSearchParams({
      limit, offset, sort: 'total_profit', period: '12',
      max_loss: '0', price: '0.5', sort_order: 'desc', symbol: '',
    }).toString();

    const result = await page.evaluate(async (baseUrl, body) => {
      const res = await fetch(`${baseUrl}/channels/ajax/symbollistNew/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body,
      });
      return await res.text();
    }, TF_BASE, formData);

    if (result.length < 300) return res.json({ status: 'success', total: 0, data: [] });

    const blocks = result.split('data-id="');
    blocks.shift();

    const traders = [];
    for (const block of blocks) {
      const idEnd = block.indexOf('"');
      let channelId = block.slice(0, idEnd);
      const cartMatch = block.match(/addToCart\('(\d+)'/);
      if ((!channelId || channelId === '1' || channelId.length < 3) && cartMatch) channelId = cartMatch[1];
      if (!channelId || channelId === '0' || channelId === '1') continue;

      const subsMatch = block.match(/<p class="txt-subs-new-2">(\d+)<\/p>/);
      const rankMatch = block.match(/<b class="text-green"[^>]*>([^<]+)<\/b>/);
      const medalMatch = block.match(/Medal (\d+)/);

      let username = 'Unknown';
      const name1 = block.match(/class="user_name"[^>]*>[\s\S]*?<p[^>]*>([^<]+)<\/p>/);
      if (name1) username = name1[1].trim();
      else {
        const name2 = block.match(/addToCart\([^,]+,\s*'[^']*',\s*`([^`]+)`/);
        if (name2) username = name2[1];
      }

      let priceRp = '0';
      const priceMatch = block.match(/Rp([\d.]+)/);
      if (priceMatch) priceRp = priceMatch[1].replace(/\./g, '');
      else if (block.match(/\bFree\b/)) priceRp = '0';

      let profitRaw = '0';
      const pm1 = block.match(/(\d+\.?\d*K?)\s*<span class="spanDescPips">Pips[\s\S]*?Total Profit/);
      if (pm1) profitRaw = pm1[1];
      else {
        const pm2 = block.match(/color: #00b451[^>]*>\s*(\d+\.?\d*K?\s*)/);
        if (pm2) profitRaw = pm2[1];
      }

      let pips = '0';
      const am = block.match(/Avg\. Monthly Profit[\s\S]*?span class="summary-value"[^>]*>\s*(\d+\.?\d*)\s*Pips/);
      if (am) pips = am[1];

      let postMo = '0';
      const pmMatch = block.match(/Post\/Month[\s\S]*?baseline-flex[^>]*>\s*(\d+)/);
      if (pmMatch) postMo = pmMatch[1];

      traders.push({
        id: channelId, username,
        rank: rankMatch?.[1]?.trim() || 'Unknown',
        medal_level: parseInt(medalMatch?.[1] || '0'),
        subs: subsMatch?.[1] || '0',
        price_rp: priceRp, profit: profitRaw, pips, jml_signal: postMo,
      });
    }

    const filtered = traders.filter((t) => {
      if (!['Elite', 'Pro', 'Master', 'Legend'].includes(t.rank)) return false;
      if (t.medal_level <= 3) return false;
      if (parseK(t.profit) <= 0) return false;
      if (parseK(t.pips) <= 0) return false;
      return true;
    });

    res.json({ status: 'success', total: filtered.length, data: filtered });
  } catch (error) {
    console.error('[channellist] error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/channel', async (req, res) => {
  try {
    if (!isLoggedIn) await loginTF();
    const id = req.query.id;
    const period = req.query.period || '1Y';
    if (!id) return res.status(400).json({ status: 'error', message: 'Missing id' });

    const result = await page.evaluate(async (baseUrl, channelId, period) => {
      const res = await fetch(`${baseUrl}/channels/ajax/getChannelSummaryx/${channelId}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams({ period }).toString(),
      });
      return await res.json();
    }, TF_BASE, id, period);

    res.json({ status: 'success', requested_id: id, requested_period: period, result });
  } catch (error) {
    console.error('[channel] error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    if (!isLoggedIn) await loginTF();
    const id = req.query.id;
    const start = req.query.start || '2025-11-30 17:00:00';
    const end = req.query.end || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const limit = parseInt(req.query.limit || '100');
    if (!id) return res.status(400).json({ status: 'error', data: [] });

    const allSignals = [];
    let offset = 0;
    const batchLimit = 100;

    while (true) {
      const body = new URLSearchParams({
        active: '0', offset: offset.toString(), limit: batchLimit.toString(),
        'search[close_time_start]': start, 'search[close_time_end]': end,
      }).toString();

      const fetched = await page.evaluate(async (baseUrl, channelId, body) => {
        const res = await fetch(`${baseUrl}/channels/ajax/historySignal/${channelId}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
          body,
        });
        const json = await res.json();
        if (Array.isArray(json?.message)) return json.message;
        if (Array.isArray(json?.rows)) return json.rows;
        if (Array.isArray(json)) return json;
        return [];
      }, TF_BASE, id, body);

      if (fetched.length === 0) break;
      allSignals.push(...fetched);
      offset += fetched.length;
      if (fetched.length < batchLimit) break;
      if (allSignals.length >= limit) break;
      await sleep(100);
    }

    res.json({
      status: 'success',
      summary: { channel_id: id, total_signals: allSignals.length, date_range: `${start} s/d ${end}` },
      data: allSignals.slice(0, limit),
    });
  } catch (error) {
    console.error('[history] error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/scrape/trigger', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100');
    const collected = await scrapeAndSaveChannels(limit);
    res.json({ status: 'success', message: `Scraped ${collected} channels` });
  } catch (error) {
    console.error('[scrape] error:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/scrape/status', async (req, res) => {
  try {
    const total = await prisma.tradersData.count();
    const active = await prisma.tblAntrian.count({ where: { active: true } });
    res.json({ status: 'success', total_channels: total, pending_jobs: active });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`MHC Studio API v2 running on port ${PORT}`);
});