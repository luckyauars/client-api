import os
import re
import asyncio
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from playwright.async_api import async_playwright
from playwright_stealth import stealth_async

load_dotenv()

TF_BASE = "https://account.tradersfamily.id"
TF_EMAIL = os.getenv("TF_EMAIL", "")
TF_PASSWORD = os.getenv("TF_PASSWORD", "")

browser = None
pw_instance = None
page = None
is_logged_in = False


def num(val):
    if val is None:
        return 0
    if isinstance(val, (int, float)):
        return int(val)
    res = re.sub(r"[^0-9-]", "", str(val))
    return int(res) if res else 0


def curr(val):
    if val is None:
        return 0
    if isinstance(val, (int, float)):
        return float(val)
    return float(re.sub(r"[^0-9.-]", "", str(val)) or 0)


def parse_k(s):
    u = str(s).upper().strip()
    m = 1
    if "K" in u:
        m = 1000
    if "M" in u:
        m = 1000000
    try:
        return float(re.sub(r"[^0-9.]", "", u)) * m
    except Exception:
        return 0


async def launch_browser():
    global browser, pw_instance, page
    if browser:
        return
    pw_instance = await async_playwright().start()
    browser = await pw_instance.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
        ],
    )
    ctx = await browser.new_context(
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        viewport={"width": 1920, "height": 1080},
        locale="id-ID",
        timezone_id="Asia/Jakarta",
    )
    page = await ctx.new_page()
    await stealth_async(page)


async def login_tf():
    global is_logged_in
    if is_logged_in:
        return
    await launch_browser()
    print("[TF] Navigating to login...")
    await page.goto(f"{TF_BASE}/login/", wait_until="domcontentloaded", timeout=60000)

    print("[TF] Waiting for Cloudflare challenge...")
    try:
        await page.wait_for_selector('input[name="logname"]', timeout=60000)
        print("[TF] Login form found")
    except Exception:
        raise Exception("Login form not found after CF challenge")

    await page.fill('input[name="logname"]', TF_EMAIL)
    await page.fill('input[name="pass"]', TF_PASSWORD)
    await asyncio.sleep(0.5)

    await page.click("#btn-signin")
    await page.wait_for_load_state("load", timeout=30000)
    await asyncio.sleep(5)

    url = page.url
    if "/dashboard" in url or url == TF_BASE + "/" or url == TF_BASE:
        print("[TF] Login OK")
        is_logged_in = True
    else:
        print(f"[TF] Login may have failed, URL: {url}")


async def ensure_session():
    global is_logged_in, page
    if not page or page.is_closed():
        is_logged_in = False
    if not is_logged_in:
        await login_tf()


async def fetch_channellist(limit=36, offset=0):
    await ensure_session()

    form_data = {
        "limit": str(limit),
        "offset": str(offset),
        "sort": "total_profit",
        "period": "12",
        "max_loss": "0",
        "price": "0.5",
        "sort_order": "desc",
        "symbol": "",
    }

    result = await page.evaluate(
        """async (baseUrl, data) => {
            const params = new URLSearchParams(data).toString();
            const res = await fetch(baseUrl + '/channels/ajax/symbollistNew/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: params
            });
            return await res.text();
        }""",
        TF_BASE,
        form_data,
    )

    if len(result) < 300:
        return []

    blocks = result.split('data-id="')
    blocks.pop(0)

    traders = []
    for block in blocks:
        id_end = block.index('"')
        channel_id = block[:id_end]

        cart_match = re.search(r"addToCart\('(\d+)'", block)
        if (not channel_id or channel_id == "1" or len(channel_id) < 3) and cart_match:
            channel_id = cart_match.group(1)
        if not channel_id or channel_id == "0" or channel_id == "1":
            continue

        subs_match = re.search(r'<p class="txt-subs-new-2">(\d+)</p>', block)
        rank_match = re.search(r'<b class="text-green"[^>]*>([^<]+)</b>', block)
        medal_match = re.search(r"Medal (\d+)", block)

        username = "Unknown"
        name1 = re.search(r'class="user_name"[^>]*>[\s\S]*?<p[^>]*>([^<]+)</p>', block)
        if name1:
            username = name1.group(1).strip()
        else:
            name2 = re.search(r"addToCart\([^,]+,\s*'[^']*',\s*`([^`]+)`", block)
            if name2:
                username = name2.group(1)

        price_rp = "0"
        price_match = re.search(r"Rp([\d.]+)", block)
        if price_match:
            price_rp = price_match.group(1).replace(".", "")
        elif re.search(r"\bFree\b", block):
            price_rp = "0"

        profit_raw = "0"
        pm1 = re.search(
            r"(\d+\.?\d*K?)\s*<span class=\"spanDescPips\">Pips[\s\S]*?Total Profit",
            block,
        )
        if pm1:
            profit_raw = pm1.group(1)
        else:
            pm2 = re.search(r"color: #00b451[^>]*>\s*(\d+\.?\d*K?\s*)", block)
            if pm2:
                profit_raw = pm2.group(1)

        pips = "0"
        am = re.search(
            r"Avg\. Monthly Profit[\s\S]*?span class=\"summary-value\"[^>]*>\s*(\d+\.?\d*)\s*Pips",
            block,
        )
        if am:
            pips = am.group(1)

        post_mo = "0"
        pm_match = re.search(
            r"Post/Month[\s\S]*?baseline-flex[^>]*>\s*(\d+)", block
        )
        if pm_match:
            post_mo = pm_match.group(1)

        traders.append(
            {
                "id": channel_id,
                "username": username,
                "rank": rank_match.group(1).strip() if rank_match else "Unknown",
                "medal_level": int(medal_match.group(1)) if medal_match else 0,
                "subs": subs_match.group(1) if subs_match else "0",
                "price_rp": price_rp,
                "profit": profit_raw,
                "pips": pips,
                "jml_signal": post_mo,
            }
        )

    return traders


async def fetch_channel_summary(channel_id, period="1Y"):
    await ensure_session()
    return await page.evaluate(
        """async (baseUrl, id, p) => {
            const res = await fetch(baseUrl + '/channels/ajax/getChannelSummaryx/' + id + '/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: new URLSearchParams({period: p}).toString()
            });
            return await res.json();
        }""",
        TF_BASE,
        channel_id,
        period,
    )


async def fetch_history(channel_id, start, end, limit=100):
    await ensure_session()
    all_signals = []
    offset = 0
    batch_limit = 100

    while True:
        body = {
            "active": "0",
            "offset": str(offset),
            "limit": str(batch_limit),
            "search[close_time_start]": start,
            "search[close_time_end]": end,
        }

        fetched = await page.evaluate(
            """async (baseUrl, id, data) => {
                const params = new URLSearchParams(data).toString();
                const res = await fetch(baseUrl + '/channels/ajax/historySignal/' + id + '/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: params
                });
                const json = await res.json();
                if (Array.isArray(json?.message)) return json.message;
                if (Array.isArray(json?.rows)) return json.rows;
                if (Array.isArray(json)) return json;
                return [];
            }""",
            TF_BASE,
            channel_id,
            body,
        )

        if len(fetched) == 0:
            break
        all_signals.extend(fetched)
        offset += len(fetched)
        if len(fetched) < batch_limit:
            break
        if len(all_signals) >= limit:
            break
        await asyncio.sleep(0.1)

    return all_signals[:limit]


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    if browser:
        await browser.close()
    if pw_instance:
        await pw_instance.stop()


app = FastAPI(title="MHC Studio API", version="2.0.0", lifespan=lifespan)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "MHC Studio API",
        "version": "2.0.0",
        "engine": "python-playwright-stealth",
        "timestamp": datetime.now().isoformat(),
    }


@app.get("/api/channellist")
async def channellist(offset: str = "0", limit: str = "36"):
    try:
        await ensure_session()
        channels = await fetch_channellist(int(limit), int(offset))

        if not channels:
            return {"status": "success", "total": 0, "data": []}

        filtered = []
        for t in channels:
            if t["rank"] not in ["Elite", "Pro", "Master", "Legend"]:
                continue
            if t["medal_level"] <= 3:
                continue
            if parse_k(t["profit"]) <= 0:
                continue
            if parse_k(t["pips"]) <= 0:
                continue
            filtered.append(t)

        return {"status": "success", "total": len(filtered), "data": filtered}
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.get("/api/channel")
async def channel(id: str = Query(...), period: str = "1Y"):
    try:
        await ensure_session()
        result = await fetch_channel_summary(id, period)
        return {
            "status": "success",
            "requested_id": id,
            "requested_period": period,
            "result": result,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.get("/api/history")
async def history(
    id: str = Query(...),
    start: str = "2025-11-30 17:00:00",
    end: str = "",
    limit: int = 100,
):
    try:
        await ensure_session()
        if not end:
            end = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        data = await fetch_history(id, start, end, limit)
        return {
            "status": "success",
            "summary": {
                "channel_id": id,
                "total_signals": len(data),
                "date_range": f"{start} s/d {end}",
            },
            "data": data,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.get("/api/scrape/trigger")
async def scrape_trigger(limit: int = 100):
    try:
        all_channels = []
        offset = 0
        while len(all_channels) < limit:
            chunk = min(100, limit - len(all_channels))
            channels = await fetch_channellist(chunk, offset)
            if not channels:
                break
            valid = [c for c in channels if c["id"] and c["id"] != "0"]
            if not valid:
                break
            all_channels.extend(valid)
            offset += len(channels)
        return {
            "status": "success",
            "message": f"Scraped {len(all_channels)} channels",
            "data": all_channels,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
