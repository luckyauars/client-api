const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

const TF_BASE = 'https://account.tradersfamily.id';
const TF_EMAIL = process.env.TF_EMAIL || '';
const TF_PASSWORD = process.env.TF_PASSWORD || '';

let browser = null;
let page = null;
let isLoggedIn = false;

async function launchBrowser() {
  if (browser) return;
  browser = await puppeteer.launch({
    headless: 'new',
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

  console.log('[TF] Waiting for Cloudflare challenge to resolve...');
  try {
    await page.waitForFunction(
      () => document.querySelector('input[name="logname"]') !== null,
      { timeout: 60000 }
    );
    console.log('[TF] Login form found');
  } catch {
    const title = await page.title();
    const content = await page.content();
    console.log('[TF] Page title:', title);
    console.log('[TF] Page snippet:', content.slice(0, 500));
    throw new Error('Login form not found after CF challenge');
  }

  const formFields = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input, button');
    return Array.from(inputs).map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
    }));
  });
  console.log('[TF] Form fields:', JSON.stringify(formFields));

  await page.type('input[name="logname"]', TF_EMAIL, { delay: 50 });
  await page.type('input[name="pass"]', TF_PASSWORD, { delay: 50 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);

  await new Promise(r => setTimeout(r, 3000));

  const url = page.url();
  const pageContent = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log('[TF] After submit URL:', url);
  console.log('[TF] After submit body:', pageContent);
  if (url.includes('/dashboard') || url === TF_BASE + '/' || url === TF_BASE) {
    console.log('[TF] Login OK');
    isLoggedIn = true;
  } else {
    console.warn('[TF] Login may have failed');
  }
}

async function authFetch(url, options = {}) {
  if (!isLoggedIn) await loginTF();
  return page.evaluate(async (fetchUrl, fetchOptions) => {
    const res = await fetch(fetchUrl, fetchOptions);
    return { status: res.status, text: await res.text() };
  }, url, options);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'MHC Studio API', version: '1.0.0' });
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
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
      });
      return await res.text();
    }, TF_BASE, formData);

    if (result.length < 300) {
      return res.json({ status: 'success', total: 0, data: [] });
    }

    const blocks = result.split('data-id="');
    blocks.shift();

    const traders = [];
    for (const block of blocks) {
      const idEnd = block.indexOf('"');
      let channelId = block.slice(0, idEnd);

      const cartMatch = block.match(/addToCart\('(\d+)'/);
      if ((!channelId || channelId === '1' || channelId.length < 3) && cartMatch) {
        channelId = cartMatch[1];
      }
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

    const parseK = (s) => {
      const u = s.toUpperCase().trim();
      let m = 1;
      if (u.includes('K')) m = 1000;
      if (u.includes('M')) m = 1000000;
      return parseFloat(u.replace(/[^0-9.]/g, '')) * m || 0;
    };

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
      await new Promise((r) => setTimeout(r, 100));
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

app.listen(PORT, () => {
  console.log(`MHC Studio API running on port ${PORT}`);
});