'use strict';
/* 品牌「联网兜底」查找（2026-09-29 用户拍板：四层判定 + 联网兜底，默认关闭）
   用途：型号规则 / OEM 表 / OUI 都判不出品牌时，才联网查一次，结果写入本地缓存
        （标「待人工确认」），下次同型号直接命中缓存，不再联网。
   注意：内网/离线环境必须保持关闭，否则扫盘会变慢或超时。 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'brand-cache.json');

/* 关键词 → 品牌（中英文都算；权重高的先判） */
const KEYS = [
  { brand: '日立/HGST', re: /(HGST|HITACHI|(?:^|[^A-Z])日立|昱科|ULTRASTAR)/i },
  { brand: '西数', re: /(WESTERN\s*DIGITAL|WDC|(?:^|[^A-Z])西数|西部数据|WD\b)/i },
  { brand: '希捷', re: /(SEAGATE|希捷|EXOS|IRONWOLF|BARRACUDA)/i },
  { brand: '东芝', re: /(TOSHIBA|东芝)/i },
];

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveCache(c) {
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); } catch (e) {}
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch (e) {}
}
function cacheGet(model) {
  const m = String(model || '').trim().toUpperCase();
  if (!m) return null;
  const c = loadCache();
  return c[m] || null;
}
function cachePut(model, brand, evidence) {
  const m = String(model || '').trim().toUpperCase();
  if (!m || !brand) return;
  const c = loadCache();
  c[m] = { model: m, brand, evidence: evidence || '', at: Date.now(), source: 'online', confirmed: false };
  saveCache(c);
}

function fetchText(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      timeout: timeoutMs || 6000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
      },
    }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      try {
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      } catch (e) {}
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => { buf += d; if (buf.length > 500000) { req.destroy(); } });
      stream.on('end', () => resolve(buf));
      stream.on('error', () => resolve(buf));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

/* 统计搜索页里各品牌关键词出现次数 → 取最高且明显领先的；否则返回 null（不猜） */
function scoreBrand(text) {
  const t = String(text || '');
  let best = null;
  const hits = {};
  for (const k of KEYS) {
    const m = t.match(new RegExp(k.re.source, 'gi'));
    hits[k.brand] = m ? m.length : 0;
    if (!best || hits[k.brand] > hits[best]) best = k.brand;
  }
  const sorted = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const top = sorted[0] || ['', 0];
  const second = sorted[1] || ['', 0];
  if (!top[1] || top[1] < 2) return { brand: null, hits };
  if (second[1] && top[1] < second[1] * 2) return { brand: null, hits };   // 两个品牌都很像 → 不猜
  return { brand: top[0], hits };
}

async function lookupOnline(model, timeoutMs) {
  const m = String(model || '').trim();
  if (!m) return null;
  /* 用 cn.bing.com（本机 www.bing.com 会 302 到 cn 且不带 cookie 拿不到结果） */
  const queries = [
    `https://cn.bing.com/search?q=${encodeURIComponent('"' + m + '" 硬盘')}`,
    `https://cn.bing.com/search?q=${encodeURIComponent(m + ' 硬盘 品牌')}`,
  ];
  let best = { brand: null, hits: {}, evidence: queries[0], reason: '联网无结果' };
  for (const url of queries) {
    const txt = await fetchText(url, timeoutMs || 6000);
    if (!txt) { best.reason = '联网失败/超时'; continue; }
    const r = scoreBrand(txt);
    if (r.brand) return { brand: r.brand, hits: r.hits, evidence: url };
    best = { brand: null, hits: r.hits, evidence: url, reason: '结果不明显，拒绝乱猜' };
  }
  return best;
}

module.exports = { loadCache, saveCache, cacheGet, cachePut, lookupOnline, scoreBrand, CACHE_FILE };
