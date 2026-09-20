'use strict';
/* 硬盘检测与格式化 Web 管理界面 —— 节点服务（零依赖 Node HTTP 服务） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const store = require('./lib/store');
const detect = require('./lib/detect');
const rules = require('./lib/rules');
const ex = require('./lib/exec');
const toolsDetect = require('./lib/tools');
const cleaner = require('./lib/clean');
const autoformat = require('./lib/autoformat');
const autoupdate = require('./lib/autoupdate');
const spaceinfo = require('./lib/space');
const crypto = require('crypto');

/* ---------- HTTP 客户端（兼容 Node 16：无全局 fetch） ---------- */
function httpReq(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const headers = Object.assign({}, opts.headers || {});
    let payload = null;
    if (opts.body !== undefined && opts.body !== null) {
      payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
      headers['Content-Length'] = payload.length;
    }
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: opts.method || 'GET', headers, timeout: opts.timeoutMs || 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode, statusCode: res.statusCode, headers: res.headers,
          text: async () => buf.toString('utf8'),
          json: async () => JSON.parse(buf.toString('utf8')),
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
/* 流式请求（SSE 转发用） */
function httpStream(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: opts.method || 'GET', headers: opts.headers || {}, timeout: opts.timeoutMs || 15000,
    }, (res) => resolve(res));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/* ---------- 定时清理（wdckit.txt / wdckit-trace.txt …） ---------- */
let cleanTimer = null;
function runClean(reason) {
  try {
    const st = store.load('settings');
    if (!st.clean || !st.clean.enabled) return null;
    const r = cleaner.run(st);
    st.clean.lastRun = r.at; st.clean.lastFreed = r.freed;
    store.save('settings', st);
    if (r.files.length || r.errors.length) {
      store.appendJSONL('audit.jsonl', { at: r.at, kind: 'clean', reason, mode: r.mode, freed: r.freed, files: r.files.map((f) => ({ p: f.path, sz: f.size })), errors: r.errors });
      console.log(`[disk-webui] 自动清理(${reason}): 处理 ${r.files.length} 个文件，释放 ${(r.freed / 1048576).toFixed(1)} MB`);
    }
    return r;
  } catch (e) { console.error('[disk-webui] 清理出错:', e.message); return null; }
}
function scheduleClean() {
  if (cleanTimer) clearInterval(cleanTimer);
  const st = store.load('settings');
  if (!st.clean || !st.clean.enabled) return;
  const ms = Math.max(1, Number(st.clean.intervalMin) || 30) * 60000;
  cleanTimer = setInterval(() => runClean('定时'), ms);
  if (cleanTimer.unref) cleanTimer.unref();
}

/* ---------- 权限（第十二章：查看 / 格式化 / 命令行 三级权限） ---------- */
const tokens = new Map();            // token -> {user, role, exp}
const remoteTokens = new Map();      // machineId -> {token, exp}
const RANK = { viewer: 1, operator: 2, admin: 3 };
/* token 持久化：服务重启不抦下线 */
const TOKEN_FILE = path.join(store.DATA, 'tokens.json');
function loadTokens() {
  try {
    const o = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    for (const [k, v] of Object.entries(o)) if (v.exp > Date.now()) tokens.set(k, v);
  } catch (e) {}
}
function saveTokens() {
  const o = {};
  const now = Date.now();
  for (const [k, v] of tokens) { if (v.exp <= now) tokens.delete(k); else o[k] = v; }
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(o), { mode: 0o600 }); } catch (e) {}
}
loadTokens();
function tokenOf(req, query) {
  if (req.headers['x-token']) return String(req.headers['x-token']);
  if (query && query.token) return String(query.token);
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dwtoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function currentUser(req, query) {
  if (!settings.auth.enabled) return { user: '(auth 已关闭)', role: 'admin' };
  const t = tokenOf(req, query);
  const rec = t && tokens.get(t);
  if (!rec) return null;
  if (rec.exp < Date.now()) { tokens.delete(t); return null; }
  return { user: rec.user, role: rec.role };
}
function requiredRole(p, m) {
  if (m === 'GET') return 'viewer';
  if (p === '/api/v1/password') return 'viewer';     // 改自己密码：登录即可
  if (/\/disks\/[^/]+\/(format|stop)$/.test(p) || /batch-format$/.test(p)) return 'operator';
  if (/\/override$/.test(p) || p.startsWith('/api/v1/templates')) return 'operator';
  return 'admin';
}

/* ---------- 远程机器（带登录） ---------- */
async function remoteToken(machine) {
  const c = remoteTokens.get(machine.id);
  if (c && c.exp > Date.now()) return c.token;
  const u = machine.user || 'admin', pw = machine.pass || '12345678';
  const r = await httpReq(`http://${machine.ip}:${machine.port || settings.nodePort}/api/v1/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: u, pass: pw }), timeoutMs: 8000,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('远程登录失败：' + (j.error || r.status));
  remoteTokens.set(machine.id, { token: j.token, exp: Date.now() + 200 * 60000 });
  return j.token;
}
async function remoteRaw(machine, tail, method, body, token, query) {
  const base = `http://${machine.ip}:${machine.port || settings.nodePort}`;
  const qs = new URLSearchParams(query || {}).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-token'] = token;
  return httpReq(base + tail + (qs ? '?' + qs : ''), {
    method, headers, body: (method === 'GET' || method === 'DELETE') ? undefined : JSON.stringify(body || {}), timeoutMs: 30000,
  });
}
async function remoteJson(machine, tail, method, body, query) {
  let token = null;
  try { token = await remoteToken(machine); } catch (e) { /* 远程可能未开鉴权 */ }
  let r = await remoteRaw(machine, tail, method, body, token, query);
  if (r.status === 401) { remoteTokens.delete(machine.id); token = await remoteToken(machine); r = await remoteRaw(machine, tail, method, body, token, query); }
  return r;
}

const PUBLIC = path.join(__dirname, 'public');
const VERSION = '0.2.0';
/* 构建指纹：用于节点间比对代码版本（自动同步更新用） */
function computeBuild() {
  const list = ['server.js'];
  for (const d of ['lib', 'public']) { try { for (const f of fs.readdirSync(path.join(__dirname, d)).sort()) list.push(d + '/' + f); } catch (e) {} }
  const h = crypto.createHash('md5');
  h.update(VERSION);
  for (const f of list) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch (e) {} }
  return h.digest('hex').slice(0, 12);
}
const BUILD = computeBuild();
let settings = store.load('settings');
/* 服务以 root 跑时 HOME=/root，而工具包在普通用户家目录下 → 自动定位并记住 */
if (!settings.homeDir) {
  settings.homeDir = store.resolveHome(settings);
  try { store.save('settings', settings); } catch (e) {}
  console.log('[disk-webui] 自动定位家目录: ' + settings.homeDir);
}
let diskCache = { at: 0, data: null };

/* ---------- 工具函数 ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
function localIPs() {
  const ips = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push({ iface: name, ip: i.address });
  }
  return ips;
}
function findMachine(id) { return store.load('machines').find((m) => m.id === id); }

async function proxy(machine, req, res, tail, method, body, query) {
  try {
    const r = await remoteJson(machine, tail, method, body, query);
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  } catch (e) {
    json(res, 504, { error: '目标机器不可达', detail: String(e.message || e), target: `${machine.ip}:${machine.port || settings.nodePort}` });
  }
}
/* SSE 透传（远程机器的终端实时输出） */
async function proxySSE(machine, req, res, tail, query, onFirstLine) {
  let token = null;
  try { token = await remoteToken(machine); } catch (e) {}
  const base = `http://${machine.ip}:${machine.port || settings.nodePort}`;
  const qs = new URLSearchParams(query || {}).toString();
  const headers = {}; if (token) headers['x-token'] = token;
  let r;
  try { r = await httpStream(base + tail + (qs ? '?' + qs : ''), { headers, timeoutMs: 20000 }); }
  catch (e) { try { onFirstLine && onFirstLine('\u001b[31m[远程连接失败: ' + String(e.message || e) + ']\u001b[0m'); } catch (e2) {} return res.end(); }
  if (r.statusCode !== 200) { try { onFirstLine && onFirstLine('\u001b[31m[远程连接失败 ' + r.statusCode + ']\u001b[0m'); } catch (e) {} try { r.resume(); } catch (e) {} return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  req.on('close', () => { try { r.destroy(); } catch (e) {} });
  r.pipe(res);
  await new Promise((resolve) => { r.on('end', resolve); r.on('close', resolve); r.on('error', resolve); });
  try { res.end(); } catch (e) {}
}

/* ---------- 机器列表互相同步（各节点取并集，收敛成同一份） ---------- */
async function syncMachines() {
  const ms = store.load('machines');
  const key = (ip, port) => String(ip || '').trim() + ':' + Number(port || settings.nodePort);
  const byKey = new Map();
  for (const m of ms) byKey.set(key(m.ip, m.port), m);
  let added = 0, updated = 0;
  const sources = [], errors = [];
  /* 同步种子：本机列表为空/只有自己时，靠种子节点引入全网列表 */
  const seeds = (store.load('settings').syncSeeds || ['192.168.2.139']).map((ip) => String(ip).trim()).filter(Boolean);
  const targets = ms.filter((m) => !m.local).slice();
  for (const ip of seeds) {
    if (targets.some((m) => String(m.ip).trim() === ip)) continue;
    if (ms.some((m) => m.local && String(m.ip).trim() === ip)) continue;
    targets.push({ id: 'seed_' + ip, name: ip, ip, port: settings.nodePort, user: 'admin', pass: '12345678' });
  }
  for (const m of targets) {
    try {
      const r = await remoteJson(m, '/api/v1/machines', 'GET');
      const j = await r.json();
      sources.push(m.ip);
      for (const rm of (j.machines || [])) {
        const k = key(rm.ip, rm.port);
        if (!byKey.has(k)) {
          byKey.set(k, {
            id: 'm_' + Math.random().toString(36).slice(2, 8), name: rm.name || rm.ip, ip: rm.ip,
            port: Number(rm.port) || settings.nodePort, note: rm.note || '', rack: rm.rack || '',
            user: rm.user || 'admin', pass: rm.pass || '12345678', status: rm.status || 'unknown', syncedFrom: m.ip,
          });
          added++;
        } else {
          const cur = byKey.get(k);
          if (!cur.local && rm.status && cur.status !== rm.status) { cur.status = rm.status; updated++; }
        }
      }
    } catch (e) { errors.push(m.ip + ': ' + String(e.message || e)); }
  }
  const list = Array.from(byKey.values());
  store.save('machines', list);
  const st = store.load('settings');
  st.lastSyncAt = Date.now();
  store.save('settings', st);
  return { total: list.length, added, updated, sources, errors };
}
let syncTimer = null;
function startSyncTimer() { /* 由统一调度器（schedulerTick）驱动，不再单独起定时器 */ }

/* ---------- 格式化完成后：若仍有缺陷 → 立即自动继续格（可暂停/单盘截停） ---------- */
ex.setFinishHook(async (job) => {
  try {
    const st = store.load('settings');
    const af = st.autoFormat || {};
    if (!af.continueOnDefect) return;
    if ((Number(job.round) || 1) >= Math.max(1, Number(af.maxRounds) || 20)) return;
    /* 2026-09-20（用户要求）：全局暂停期间，**单盘可以单独放行**（allowSerials）。
       以前这里直接 return，导致"全局暂停时点单盘恢复续格"无意义——现在改为：
       只有 paused 且没有任何放行名单时才整体跳过；否则在下面逐盘判断。 */
    const allowSerials = af.allowSerials || [];
    if (af.paused && !allowSerials.length) { store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-continue-skip', jobId: job.id, reason: '已全局暂停' }); return; }
    if (job.status !== '完成') return;
    await new Promise((r) => setTimeout(r, 6000));
    const r2 = await getDisks(true);
    /* 2026-09-19 用户要求：整批格完 → 统一查盘 → 复检缺陷 → 只把“仍有缺陷”的凑成下一批 */
    const devs = (job.devices && job.devices.length ? job.devices : [job.device]).filter(Boolean);
    const stillDefect = [];
    for (const dev of devs) {
      const d = r2.disks.find((x) => x.device === dev) || (job.serial ? r2.disks.find((x) => x.serial === job.serial) : null);
      if (!d) { store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-continue-skip', jobId: job.id, device: dev, reason: '盘已不在（可能被拔掉）' }); continue; }
      if ((af.stopSerials || []).indexOf(d.serial) >= 0) { store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-continue-skip', jobId: job.id, serial: d.serial, reason: '该盘已被标记不再续格' }); continue; }
      /* 全局暂停中：只有被"单盘放行"的盘才继续 */
      if (af.paused && allowSerials.indexOf(d.serial) < 0) { store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-continue-skip', jobId: job.id, serial: d.serial, reason: '全局暂停中，该盘未单独放行' }); continue; }
      const ev = rules.evaluateDefect(d, st);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-recheck', jobId: job.id, device: d.device, serial: d.serial, defectAfter: ev.status });
      if (ev.status === '有') stillDefect.push(d);
    }
    if (!stillDefect.length) { console.log('[disk-webui] 本批格完复检：无缺陷，停止续格'); return; }
    const cfg2 = { toolId: job.toolId, lunSize: job.lunSize, mode: job.mode };
    const group = rules.renderToolGroup(stillDefect, cfg2, st);
    if (!group || !group.command) return;
    const extra = stillDefect.length > 1 ? { devices: group.devices.map((x) => x.device), label: '多盘(' + stillDefect.length + '块)', round: (Number(job.round) || 1) + 1 } : { round: (Number(job.round) || 1) + 1 };
    const nj = ex.newJob(stillDefect[0], cfg2, group, st, extra);
    store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-continue', prevJob: job.id, jobId: nj.id, round: nj.round, count: stillDefect.length, devices: group.devices.map((x) => x.device), command: group.command });
    console.log('[disk-webui] 本批仍有缺陷 ' + stillDefect.length + ' 块 → 第 ' + nj.round + ' 轮继续');
  } catch (e) { console.error('[disk-webui] 续格判断出错:', e.message); }
});


/* ---------- 热插拔监听：插入/拔出硬盘立即感知（默认 5 秒一轮，可配置） ---------- */
let lastDevSet = null;
function currentDevSet() {
  try {
    return fs.readdirSync('/sys/block')
      .filter((n) => /^(sd|nvme|hd)[a-z0-9]+$/.test(n))
      .sort().join(',');
  } catch (e) { return null; }
}
async function hotplugTick() {
  const st = store.load('settings');
  if (!st.hotplug || st.hotplug.enabled === false) return;
  const cur = currentDevSet();
  if (cur === null) return;
  if (lastDevSet === null) { lastDevSet = cur; return; }   // 首次只记录基线
  if (cur === lastDevSet) return;
  const before = lastDevSet.split(',').filter(Boolean), after = cur.split(',').filter(Boolean);
  const added = after.filter((x) => before.indexOf(x) < 0);
  const removed = before.filter((x) => after.indexOf(x) < 0);
  lastDevSet = cur;
  console.log('[disk-webui] 检测到硬盘变化: 新增[' + added.join(',') + '] 移除[' + removed.join(',') + '] → 立即扫描');
  appendAudit({ kind: 'hotplug', added, removed });
  try { await getDisks(true); } catch (e) {}
  if (st.autoFormat && st.autoFormat.enabled) {
    try {
      await autoformat.tick(ex);
      const st2 = store.load('settings');
      st2.autoFormat = Object.assign({}, st2.autoFormat, { lastScanAt: Date.now() });
      store.save('settings', st2);
    } catch (e) {}
  }
}
function appendAudit(o) { try { store.appendJSONL('audit.jsonl', Object.assign({ at: Date.now() }, o)); } catch (e) {} }
function startHotplug() {
  /* 20 秒的粗粒度兜底 + 按配置的高频检查 */
  setInterval(() => {
    const st = store.load('settings');
    if (!st.hotplug || st.hotplug.enabled === false) return;
    const sec = Math.max(2, Number((st.hotplug.every || {}).n) * (UNIT_SEC[(st.hotplug.every || {}).unit] || 1) || 5);
    if (!startHotplug._last || Date.now() - startHotplug._last >= sec * 1000) {
      startHotplug._last = Date.now();
      hotplugTick().catch(() => {});
    }
  }, 2000);
}

/* ---------- 统一周期调度：所有"同步/刷新/清理/检测"的周期都可配置 ----------
   时间格式： 每 [n] [秒|分|时|天|周|月|年]
------------------------------------------------------------ */
const UNIT_SEC = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, quarter: 7776000, year: 31536000 };
function everySec(e, defUnit, defN) {
  if (e && typeof e === 'object' && Number(e.n) > 0) return Number(e.n) * (UNIT_SEC[e.unit] || UNIT_SEC[defUnit] || 60);
  return Number(defN || 0) * (UNIT_SEC[defUnit] || 1);
}
function isDue(lastAt, e, defUnit, defN) {
  const sec = everySec(e, defUnit, defN);
  if (!sec) return false;
  return !lastAt || (Date.now() - lastAt) >= sec * 1000;
}
async function schedulerTick() {
  try {
    const st = store.load('settings');
    if (st.syncEnabled !== false && isDue(st.lastSyncAt, st.syncEvery, 'week', 1)) { await syncMachines().catch(() => {}); }
    if (st.disks && st.disks.autoRefresh !== false && isDue(st.disks.lastAutoAt, st.disks.every, 'hour', 6)) {
      await getDisks(true);
      const st2 = store.load('settings');
      st2.disks = Object.assign({}, st2.disks, { lastAutoAt: Date.now() });
      store.save('settings', st2);
      console.log('[disk-webui] 已按周期自动刷新硬盘列表');
    }
    if (st.clean && st.clean.enabled && isDue(st.clean.lastRun, st.clean.every, 'minute', 30)) { runClean('定时'); }
    /* 自动同步更新：主服务器（syncSeeds[0]，默认 .139）有新版就拉下来并重启（默认 5 分钟一次；有格式化在跑时先不动） */
    if ((st.autoUpdate || {}).enabled !== false) {
      const auSec = Math.max(60, Number(((st.autoUpdate || {}).every || {}).sec) || 300);
      if (isDue((st.autoUpdate || {}).lastCheck, { n: auSec, unit: 'second' }, 'second', auSec)) {
        const r = await autoupdate.check().catch((e) => ({ error: e.message }));
        if (r && (r.updated || r.error)) console.log('[disk-webui] 自动更新检查：' + (r.updated ? ('已更新 ' + r.updated.from + ' → ' + r.updated.to) : r.error));
      }
    }
    /* 审计/历史文件轮转：超过上限就归档为 .1（保留旧文件，不删数据） */
    if (isDue(st.logRotateAt, null, 'second', 300)) {
      try {
        const rot = rotateBigLogs();
        if (rot.length) console.log('[disk-webui] 日志轮转：' + rot.join('、'));
      } catch (e) {}
      const st4 = store.load('settings'); st4.logRotateAt = Date.now(); store.save('settings', st4);
    }
    /* 任务/会话日志超限截断（默认 50MB，防写满根分区） */
    if (isDue(st.jobLogSweepAt, null, 'second', 60)) {
      const sw = ex.sweepJobLogs();
      st.jobLogSweepAt = Date.now();
      store.save('settings', st);
      if (sw && sw.n) console.log(`[disk-webui] 日志超限截断：${sw.n} 个文件，释放 ${(sw.freed / 1048576).toFixed(1)} MB`);
    }
    /* 有缺陷就自动格：按 intervalSec（默认 60s）跑，不能只按 every（默认 6 小时）那一条 —— 否则几乎不会触发 */
    if (st.autoFormat && st.autoFormat.enabled) {
      const ivSec = Math.max(15, Number(st.autoFormat.intervalSec) || 60);
      if (isDue(st.autoFormat.lastScanAt, { n: ivSec, unit: 'second' }, 'second', ivSec)) {
        await autoformat.tick(ex);
        const st3 = store.load('settings');
        st3.autoFormat = Object.assign({}, st3.autoFormat, { lastScanAt: Date.now() });
        store.save('settings', st3);
      }
    }
  } catch (e) { console.error('[disk-webui] 调度出错:', e.message); }
}
function startScheduler() { setInterval(schedulerTick, 20000); setTimeout(schedulerTick, 5000); }

/* 审计/格式化历史轮转 + 条数裁剪（用户 2026-09-17：默认全清腾空间） */
function rotateBigLogs() {
  const out = [];
  const st = store.load('settings');
  const r = Object.assign({ rotateMB: 5, keepArchives: 1, auditLines: 2000, historyLines: 2000 }, st.retention || {});
  const lim = Math.max(1, Number(r.rotateMB) || 5) * 1048576;
  for (const name of ['audit.jsonl', 'format-history.jsonl']) {
    const p = path.join(__dirname, 'data', name);
    try {
      const sz = fs.statSync(p).size;
      if (sz >= lim) {
        /* 先归档（保留旧文件，不直接删数据） */
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const arc = p + '.' + stamp;
        fs.renameSync(p, arc);
        out.push(`${name}（${(sz / 1048576).toFixed(1)}MB → ${path.basename(arc)}）`);
        store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'log-rotate', file: name, sizeBytes: sz });
      }
      /* 再按行数裁剪（只留最近 N 行） */
      const keep = name === 'audit.jsonl' ? (Number(r.auditLines) || 2000) : (Number(r.historyLines) || 2000);
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
      const lines = txt.split('\n').filter(Boolean);
      if (lines.length > keep) {
        fs.writeFileSync(p, lines.slice(-keep).join('\n') + '\n');
        out.push(`${name} 裁到最近 ${keep} 条`);
      }
    } catch (e) {}
  }
  /* 归档文件只留最近 N 份 */
  try {
    const dir = path.join(__dirname, 'data');
    const keepN = Math.max(1, Number(r.keepArchives) || 1);
    for (const base of ['audit.jsonl.', 'format-history.jsonl.']) {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keepN))) {
        try { fs.unlinkSync(path.join(dir, f)); out.push('删除旧归档 ' + f); } catch (e) {}
      }
    }
  } catch (e) {}
  return out;
}

/* ---------- 硬盘扫描（带人工修正覆盖） ---------- */
async function getDisks(force) {
  const now = Date.now();
  if (!force && diskCache.data && now - diskCache.at < 30000) return diskCache.data;
  const r = await detect.scan();
  const ov = store.load('overrides');
  /* 正在格式化/排队的盘：SMART 此时往往读不到 → 用任务里存的“格前快照”兜底，
     刷新硬盘不能把缺陷值刷成“未知”（2026-09-19 用户要求）。 */
  const jobByDev = new Map();
  for (const j of ex.jobs.values()) {
    if (j.status !== '运行中' && j.status !== '排队') continue;
    for (const dev of (j.devices || [])) jobByDev.set(dev, j);
  }
  for (const d of r.disks) {
    const jb = jobByDev.get(d.device);
    if (jb) {
      d.formatting = true;
      d.formattingJobId = jb.id;
      d.formattingStage = jb.stage;
      const snap = jb.defectBefore || null;
      /* 正在格式化的盘：一律用“格前快照”展示，不让刷新把缺陷值刷成未知/中间态
         （2026-09-19 用户要求：刷新硬盘不应该把在格盘的缺陷值刷掉） */
      if (snap) {
        d.gList = snap.gList; d.smart05 = snap.s05; d.smart196 = snap.s196; d.smart197 = snap.s197;
        d.smart198 = snap.s198; d.smart199 = snap.s199;
        if (snap.health && snap.health !== '未知') d.smartHealth = snap.health;
        d.smartSupported = true;
        d.defectSnapshot = 'before';       // 界面标记：显示的是格式化前快照
        d.smartError = snap.error || null;
        d.defectSnapshotFrom = snap.device || d.device;
      }
    }
    const o = ov[d.serial];
    d.hasOverride = !!o;
    if (o) {
      d.brand = o.brand || d.autoBrand;
      d.interfaceType = o.interfaceType || d.autoInterface;
      d.defectStatusOverride = o.defectStatus || null;
      d.lunSizeOverride = o.lunSize || null;
    }
    d.id = d.serial || d.device;
    const ev = rules.evaluateDefect(d, settings);
    Object.assign(d, {
      defectMethod: ev.method, autoDefectStatus: ev.autoStatus, defectStatus: ev.status,
      defectValues: ev.values, defectReason: ev.reason, allowFormat: ev.allow, blockReason: ev.blocked,
      sizeText: rules.fmtGB(d.sizeBytes),
      recommendedTool: rules.recommendTool(d, settings),
      editable: true,
    });
  }
  diskCache = { at: now, data: r };
  return r;
}

/* ---------- 路由 ---------- */
const handler = async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const m = req.method;

  /* 静态资源 */
  if (!p.startsWith('/api/')) {
    let f = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('404'); }
      const ext = path.extname(full);
      const ct = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
      /* 2026-09-20：前端改动后浏览器吃缓存 → 用户看到"改了没生效"。
         这里对 html/js/css 明确 no-cache（仍允许缓存，但每次都要回源校验）。 */
      const cc = (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache, must-revalidate' : 'public, max-age=3600';
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cc, 'Pragma': 'no-cache' });
      res.end(buf);
    });
    return;
  }

  const body = (m === 'POST' || m === 'PATCH' || m === 'DELETE') ? await readBody(req) : {};

  /* IP 白名单（第十二章：内网限制） */
  if (settings.ipWhitelist && settings.ipWhitelist.length) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const okIp = settings.ipWhitelist.some((cidr) => {
      if (cidr.includes('/')) {
        const [net, bits] = cidr.split('/');
        const n = Number(bits);
        const toInt = (s) => s.split('.').reduce((a, o) => (a << 8 >>> 0) + (Number(o) || 0), 0) >>> 0;
        return (toInt(ip) >>> (32 - n)) === (toInt(net) >>> (32 - n));
      }
      return ip === cidr || ip === '127.0.0.1';
    });
    if (!okIp) return json(res, 403, { error: 'IP 不在白名单内：' + ip });
  }

  /* 登录（无需 token） */
  if (p === '/api/v1/login' && m === 'POST') {
    if (!settings.auth.enabled) return json(res, 200, { token: 'noauth', user: '(auth 已关闭)', role: 'admin', authEnabled: false });
    const u = (settings.auth.users || []).find((x) => x.user === body.user && x.pass === body.pass);
    if (!u) {
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'login-fail', user: String(body.user || ''), passLen: String(body.pass || '').length, ip: req.socket.remoteAddress });
      return json(res, 401, { error: '用户名或密码错误' });
    }
    const tk = crypto.randomBytes(18).toString('hex');
    tokens.set(tk, { user: u.user, role: u.role, exp: Date.now() + (Number(settings.auth.tokenTtlMin) || 240) * 60000 });
    saveTokens();
    store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'login', user: u.user, role: u.role, ip: req.socket.remoteAddress });
    return json(res, 200, { token: tk, user: u.user, role: u.role, authEnabled: true });
  }
  if (p === '/api/v1/logout' && m === 'POST') {
    const t = tokenOf(req, u.query); if (t) tokens.delete(t);
    saveTokens();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/v1/me' && m === 'GET') {
    const usr = currentUser(req, u.query);
    if (!usr) return json(res, 401, { error: '未登录', needLogin: true });
    return json(res, 200, Object.assign({ authEnabled: settings.auth.enabled, permissions: { view: true, format: RANK[usr.role] >= 2, terminal: RANK[usr.role] >= 3 } }, usr));
  }

  /* 三级权限拦截（health/login 之外均需登录） */
  if (p !== '/api/v1/health' && p !== '/api/v1/version') {
    const need = requiredRole(p, m);
    const usr = currentUser(req, u.query);
    if (!usr) return json(res, 401, { error: '未登录或登录已过期', needLogin: true });
    if ((RANK[usr.role] || 0) < (RANK[need] || 0)) return json(res, 403, { error: `权限不足（当前 ${usr.role}，需要 ${need}）`, needRole: need, role: usr.role });
    req.user = usr;
  }

  try {
    /* 健康检查 / 本机信息 */
    if (p === '/api/v1/health' && m === 'GET') {
      return json(res, 200, { ok: true, version: VERSION, build: BUILD, hostname: os.hostname(), ips: localIPs(), port: settings.nodePort, httpsPort: settings.httpsPort || 8443, httpsEnabled: settings.httpsEnabled !== false, uptime: process.uptime(), dryRun: settings.dryRun });
    }
    /* 版本指纹（不需要登录：节点用来自查是否需要同步） */
    if (p === '/api/v1/version' && m === 'GET') {
      return json(res, 200, { version: VERSION, build: BUILD, hostname: os.hostname(), at: Date.now() });
    }
    /* 代码包（tar.gz，排除 data/tls）：节点自动更新时拉取 */
    if (p === '/api/v1/bundle' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="disk_webui_bundle.tar.gz"', 'Cache-Control': 'no-store', 'X-Build': BUILD });
      const t = require('child_process').spawn('tar', ['czf', '-', '-C', __dirname, '--exclude=data', '--exclude=tls', '--exclude=*.bak', '.']);
      t.stdout.pipe(res);
      t.on('error', () => { try { res.end(); } catch (e) {} });
      t.on('close', () => { try { res.end(); } catch (e) {} });
      return;
    }

    /* 机器管理 */
    if (p === '/api/v1/machines' && m === 'GET') {
      const ms = store.load('machines');
      return json(res, 200, { machines: ms, localIps: localIPs(), port: settings.nodePort });
    }
    if (p === '/api/v1/machines' && m === 'POST') {
      const ms = store.load('machines');
      const normIp = (s) => String(s || '').trim();
      const isIp = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
      const dup = (ip, port, excludeId) => ms.some((x) => normIp(x.ip) === normIp(ip) && Number(x.port || settings.nodePort) === Number(port || settings.nodePort) && x.id !== excludeId);
      if (body.bulk && body.bulk.length) {
        let n = 0, skipped = [];
        for (const line of String(body.bulk).split(/[\s,;]+/).filter(Boolean)) {
          const ip = normIp(line);
          if (!isIp(ip)) { skipped.push(`${ip}(格式不对)`); continue; }
          if (dup(ip, body.port)) { skipped.push(`${ip}(已存在)`); continue; }
          ms.push({ id: 'm_' + Math.random().toString(36).slice(2, 8), name: ip, ip, port: Number(body.port) || settings.nodePort, note: body.note || '', rack: body.rack || '', user: body.user || 'admin', pass: body.pass || '12345678', status: 'unknown' });
          n++;
        }
        store.save('machines', ms);
        return json(res, 200, { added: n, skipped, machines: ms });
      }
      const ip = normIp(body.ip);
      if (!isIp(ip)) return json(res, 400, { error: 'IP 格式不正确：' + (ip || '(空)') });
      if (dup(ip, body.port)) return json(res, 409, { error: `机器 ${ip}:${body.port || settings.nodePort} 已存在（不能重复添加）` });
      if (body.name && ms.some((x) => x.name === String(body.name).trim())) return json(res, 409, { error: `机器名称「${body.name}」已被占用` });
      const item = { id: 'm_' + Math.random().toString(36).slice(2, 8), name: body.name || ip, ip, port: Number(body.port) || settings.nodePort, note: body.note || '', rack: body.rack || '', user: body.user || 'admin', pass: body.pass || '12345678', status: 'unknown' };
      ms.push(item); store.save('machines', ms);
      return json(res, 200, item);
    }
    let mm = p.match(/^\/api\/v1\/machines\/([^/]+)$/);
    if (mm) {
      const ms = store.load('machines');
      const idx = ms.findIndex((x) => x.id === mm[1]);
      if (idx < 0) return json(res, 404, { error: '机器不存在' });
      if (m === 'GET') return json(res, 200, ms[idx]);
      if (m === 'PATCH') {
        if (body.ip || body.port || body.name) {
          const all = ms;
          const nip = String(body.ip !== undefined ? body.ip : ms[idx].ip).trim();
          const nport = Number(body.port !== undefined ? body.port : (ms[idx].port || settings.nodePort)) || settings.nodePort;
          const nname = String(body.name !== undefined ? body.name : ms[idx].name).trim();
          if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(nip)) return json(res, 400, { error: 'IP 格式不正确：' + nip });
          if (all.some((x) => x.id !== ms[idx].id && String(x.ip).trim() === nip && Number(x.port || settings.nodePort) === nport)) return json(res, 409, { error: `机器 ${nip}:${nport} 已存在（不能改成重复的 IP:端口）` });
          if (all.some((x) => x.id !== ms[idx].id && String(x.name).trim() === nname)) return json(res, 409, { error: `机器名称「${nname}」已被占用` });
        }
        Object.assign(ms[idx], body); store.save('machines', ms); return json(res, 200, ms[idx]);
      }
      if (m === 'DELETE') { const [del] = ms.splice(idx, 1); store.save('machines', ms); return json(res, 200, { deleted: del.id }); }
    }
    mm = p.match(/^\/api\/v1\/machines\/([^/]+)\/(test|connect)$/);
    if (mm && m === 'POST') {
      const machine = findMachine(mm[1]);
      if (!machine) return json(res, 404, { error: '机器不存在' });
      if (machine.local) {
        const t = Date.now();
        store.save('machines', store.load('machines'));
        return json(res, 200, { online: true, ms: 0, target: `http://127.0.0.1:${settings.nodePort}`, via: 'local' });
      }
      const t0 = Date.now();
      try {
        const r = await httpReq(`http://${machine.ip}:${machine.port || settings.nodePort}/api/v1/health`, { timeoutMs: 3500 });
        const j = await r.json();
        const ms = Date.now() - t0;
        const ms2 = store.load('machines'); const i2 = ms2.findIndex((x) => x.id === machine.id);
        if (i2 >= 0) { ms2[i2].status = 'online'; ms2[i2].lastCheck = Date.now(); store.save('machines', ms2); }
        if (mm[2] === 'connect') return json(res, 200, { url: `http://${machine.ip}:${machine.port || settings.nodePort}`, health: j });
        return json(res, 200, { online: true, ms, health: j });
      } catch (e) {
        const ms2 = store.load('machines'); const i2 = ms2.findIndex((x) => x.id === machine.id);
        if (i2 >= 0) { ms2[i2].status = 'offline'; ms2[i2].lastCheck = Date.now(); store.save('machines', ms2); }
        return json(res, 200, { online: false, ms: Date.now() - t0, error: String(e.message || e) });
      }
    }

    /* 自动续格：状态 / 暂停开关 / 单盘截停 */
    /* ---- 常驻工具会话（hugo / wdckit）：一直开着，只发 format 命令；用完 q ---- */
    if (p === '/api/v1/toolsession' && m === 'GET') {
      const out = [];
      for (const [tid, s] of ex.toolSessions.entries()) out.push({ toolId: tid, mode: s.mode, ok: !!s.ok, ready: !!s.ready, lastUsed: s.lastUsed, bin: s.bin, cwd: s.cwd });
      return json(res, 200, { sessions: out, setting: settings.toolSession || { enabled: true, idleQuitSec: 600 } });
    }
    if (p === '/api/v1/toolsession/ensure' && m === 'POST') {
      const tid = String((body && body.toolId) || 'hugo');
      return ex.ensureToolSession(tid, settings, (err, s) => {
        if (err || !s) return json(res, 500, { error: (err && err.message) || '启动失败' });
        return json(res, 200, { ok: true, toolId: tid, mode: s.mode, bin: s.bin, cwd: s.cwd });
      });
    }
    if (p === '/api/v1/toolsession/send' && m === 'POST') {
      const tid = String((body && body.toolId) || 'hugo');
      const s = ex.getToolSession(tid);
      if (!s || !s.ok) return json(res, 400, { error: '会话未启动，先调用 ensure' });
      const ok = ex.sendToolCmd(s, String((body && body.text) || ''));
      return json(res, ok ? 200 : 500, ok ? { ok: true } : { error: '发送失败' });
    }
    if (p === '/api/v1/toolsession/quit' && m === 'POST') {
      const tid = String((body && body.toolId) || 'hugo');
      const ok = ex.quitToolSession(tid);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'tool-session-quit', tool: tid, by: req.user && req.user.user, ok });
      return json(res, 200, { ok });
    }
    if (p === '/api/v1/toolsession/output' && m === 'GET') {
      const tid = String(u.query.toolId || 'hugo');
      const s = ex.getToolSession(tid);
      if (!s) return json(res, 404, { error: '无会话' });
      return json(res, 200, { toolId: tid, text: ex.sessionText(s) });
    }
    /* 自动更新：状态 / 手动触发 */
    if (p === '/api/v1/autoupdate/status' && m === 'GET') {
      const au = settings.autoUpdate || {};
      return json(res, 200, {
        enabled: au.enabled !== false, every: au.every || { n: 5, unit: 'minute' }, onlyWhenIdle: au.onlyWhenIdle !== false,
        localBuild: BUILD, master: ((settings.syncSeeds || [])[0]) || '192.168.2.139',
        lastCheck: au.lastCheck || null, lastMasterBuild: au.lastMasterBuild || null, lastResult: au.lastResult || null, lastUpdateAt: au.lastUpdateAt || null,
      });
    }
    if (p === '/api/v1/autoupdate/check' && m === 'POST') {
      const r = await autoupdate.check(true);
      return json(res, 200, r);
    }
    /* 磁盘空间 / 格式化历史 / 盘位标签 */
    if (p === '/api/v1/space' && m === 'GET') {
      return json(res, 200, spaceinfo.guard(settings, '/'));
    }
    if (p === '/api/v1/history' && m === 'GET') {
      const lim = Math.min(5000, Math.max(1, Number(u.query.limit) || 300));
      return json(res, 200, { history: store.readJSONL('format-history.jsonl', lim), total: store.readJSONL('format-history.jsonl', 100000).length });
    }
    if (p === '/api/v1/history.csv' && m === 'GET') {
      const rows = store.readJSONL('format-history.jsonl', 100000).reverse();
      const cols = [['时间', 'at'], ['设备', 'device'], ['序列号', 'serial'], ['品牌', 'brand'], ['接口', 'interfaceType'], ['工具', 'toolName'], ['逻辑块大小', 'lunSize'], ['轮次', 'round'], ['状态', 'status'], ['结果', 'result'], ['耗时秒', 'elapsedSec'], ['执行命令', 'command'], ['日志路径', 'logPath']];
      const esc = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
      const fmtTime = (ms) => { try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; } };
      let csv = '\uFEFF' + cols.map((c) => esc(c[0])).join(',') + '\r\n';
      for (const r of rows) csv += cols.map((c) => esc(c[1] === 'at' ? fmtTime(r.at) : r[c[1]])).join(',') + '\r\n';
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="format-history-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
      return res.end(csv);
    }
    /* 盘位标签：生成预览 PNG（不直接打印，先给用户看） */
    if (p === '/api/v1/labels' && m === 'POST') {
      const ids = (body && body.ids) || [];
      if (!ids.length) return json(res, 400, { error: '未选择硬盘' });
      const r = await getDisks(false);
      const dir = settings.labelDir || require('path').join(__dirname, 'data', 'labels');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      const outFiles = [];
      const py = require('child_process');
      for (const id of ids) {
        const d = r.disks.find((x) => x.id === id || x.device === id);
        if (!d) continue;
        const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        const dataFile = path.join(os.tmpdir(), 'label-' + stamp + '.json');
        const outPng = path.join(dir, 'label-' + String(d.serial || d.device).replace(/[^\w.-]/g, '_') + '-' + stamp + '.png');
        fs.writeFileSync(dataFile, JSON.stringify({
          device: d.device, model: d.model, serial: d.serial, brand: d.brand, interface: d.interfaceType,
          lun: d.logicalBlockSize, capacity: rules.fmtGB(d.sizeBytes), status: (d.defectStatus || '-') + (d.isSystemDisk ? ' / 系统盘' : ''),
          extra: '缺陷：' + (d.defectStatus || '-') + (d.gList !== null && d.gList !== undefined ? (' ｜ G-list ' + d.gList) : ''),
          date: new Date().toLocaleDateString('zh-CN'),
        }), 'utf8');
        try {
          const res2 = py.spawnSync('python3', [path.join(__dirname, 'scripts', 'make_label.py'), outPng, dataFile], { timeout: 30000, encoding: 'utf8' });
          const so = (res2.stdout || '') + (res2.stderr || '');
          if (fs.existsSync(outPng)) outFiles.push({ device: d.device, serial: d.serial, file: outPng, url: '/api/v1/labels/file/' + path.basename(outPng) });
          else outFiles.push({ device: d.device, error: so.trim().split('\n').slice(-1)[0] || '生成失败' });
        } catch (e) { outFiles.push({ device: d.device, error: e.message }); }
        try { fs.unlinkSync(dataFile); } catch (e) {}
      }
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'label-generate', count: outFiles.filter((x) => x.file).length, by: req.user && req.user.user });
      return json(res, 200, { files: outFiles });
    }
    if (p.startsWith('/api/v1/labels/file/') && m === 'GET') {
      const name = path.basename(p.replace('/api/v1/labels/file/', ''));
      const full = path.join(settings.labelDir || path.join(__dirname, 'data', 'labels'), name);
      if (!fs.existsSync(full)) return json(res, 404, { error: '标签不存在' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }
    /* 打印标签（必须先预览确认；用户明确要求：打印前先给预览） */
    if (p === '/api/v1/labels/print' && m === 'POST') {
      const files = (body && body.files) || [];
      if (!files.length) return json(res, 400, { error: '没有可打印的标签' });
      const results = [];
      for (const f of files) {
        const full = path.isAbsolute(f) ? f : path.join(settings.labelDir || path.join(__dirname, 'data', 'labels'), path.basename(f));
        if (!fs.existsSync(full)) { results.push({ file: full, error: '文件不存在' }); continue; }
        const args = ['-d', settings.printerName || 'HP_M1522nf', '-o', 'PageSize=A4', '-o', 'fit-to-page', '-o', 'orientation-requested=3', '-o', 'position=top', full];
        const rr = await detect.run('lp', args, 20000);
        results.push({ file: full, ok: !!(rr && rr.ok), out: ((rr && (rr.stdout || rr.stderr)) || '').trim().split('\n')[0] });
      }
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'label-print', count: results.length, by: req.user && req.user.user });
      return json(res, 200, { results });
    }
    /* ---- 运维：状态 / 全部停止 / 配置备份恢复 / 证书 ---- */
    if (p === '/api/v1/ops/purge-logs' && m === 'POST') {
      const freed0 = rotateBigLogs().length;
      /* 清空审计 + 历史（保留表头所需结构：直接截断） */
      let freed = 0;
      for (const name of ['audit.jsonl', 'format-history.jsonl']) {
        const f = path.join(__dirname, 'data', name);
        try { const s = fs.statSync(f).size; fs.truncateSync(f, 0); freed += s; } catch (e) {}
      }
      /* 任务日志：只保留正在跑的任务的日志 + 最新 5 个 */
      const keepIds = new Set([...ex.jobs.values()].filter((j) => j.status === '运行中').map((j) => j.id));
      let n = 0;
      try {
        const dir = ex.JOB_LOG_DIR && fs.existsSync(ex.JOB_LOG_DIR) ? ex.JOB_LOG_DIR : path.join(__dirname, 'data', 'jobs');
        const files = fs.readdirSync(dir).map((f) => ({ f, p: path.join(dir, f), m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { return 0; } })() })).sort((a, b) => b.m - a.m);
        files.forEach((x, i) => {
          const isRunning = [...keepIds].some((id) => x.f.indexOf(id) >= 0);
          if (isRunning || i < 5) return;
          try { freed += fs.statSync(x.p).size; fs.unlinkSync(x.p); n++; } catch (e) {}
        });
      } catch (e) {}
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'ops-purge-logs', freedBytes: freed, jobLogsDeleted: n, by: req.user && req.user.user });
      return json(res, 200, { ok: true, message: `已清空历史/日志（释放 ${(freed / 1048576).toFixed(1)}MB，删除 ${n} 个任务日志）` });
    }
    if (p === '/api/v1/ops/status' && m === 'GET') {
      let certDaysLeft = null;
      try {
        const certPath = path.join(__dirname, 'data', 'tls', 'cert.pem');
        if (fs.existsSync(certPath)) {
          const c = new crypto.X509Certificate(fs.readFileSync(certPath));
          certDaysLeft = Math.round((new Date(c.validTo).getTime() - Date.now()) / 86400000);
        }
      } catch (e) {}
      let lastBackup = null;
      try {
        const bdir = path.join(__dirname, 'data', '.backups');
        const list = fs.readdirSync(bdir).sort();
        if (list.length) lastBackup = list[list.length - 1];
      } catch (e) {}
      return json(res, 200, { build: BUILD, certDaysLeft, lastBackup });
    }
    if (p === '/api/v1/ops/stop-all' && m === 'POST') {
      const n = ex.stopAll();
      console.log('[disk-webui] 一键全部停止：' + n + ' 个任务');
      return json(res, 200, { ok: true, message: `已停止 ${n} 个任务`, count: n });
    }
    if (p === '/api/v1/ops/backup' && m === 'POST') {
      const bdir = path.join(__dirname, 'data', '.backups', new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(bdir, { recursive: true });
      let n = 0;
      for (const f of ['settings.json', 'overrides.json', 'machines.json', 'format-history.jsonl', 'seen-disks.json', 'templates.json']) {
        const src = path.join(__dirname, 'data', f);
        try { if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(bdir, f)); n++; } } catch (e) {}
      }
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'ops-backup', dir: bdir, files: n });
      return json(res, 200, { ok: true, message: `已备份 ${n} 个文件 → ${bdir}`, dir: bdir });
    }
    if (p === '/api/v1/ops/restore' && m === 'POST') {
      const root = path.join(__dirname, 'data', '.backups');
      let list = [];
      try { list = fs.readdirSync(root).sort(); } catch (e) {}
      if (!list.length) return json(res, 400, { error: '没有可用备份' });
      const latest = path.join(root, list[list.length - 1]);
      let n = 0;
      for (const f of fs.readdirSync(latest)) {
        try { fs.copyFileSync(path.join(latest, f), path.join(__dirname, 'data', f)); n++; } catch (e) {}
      }
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'ops-restore', from: latest, files: n, by: req.user && req.user.user });
      return json(res, 200, { ok: true, message: `已从 ${list[list.length - 1]} 恢复 ${n} 个文件（部分设置需刷新页面）` });
    }
    if (p === '/api/v1/ops/cert' && m === 'POST') {
      let days = null, regen = false;
      try {
        const certPath = path.join(__dirname, 'data', 'tls', 'cert.pem');
        if (fs.existsSync(certPath)) {
          const c = new crypto.X509Certificate(fs.readFileSync(certPath));
          days = Math.round((new Date(c.validTo).getTime() - Date.now()) / 86400000);
        }
      } catch (e) {}
      if (days === null || days < 30) {
        try { require('./lib/tls').ensureCert(Object.assign({}, settings, { tlsForce: true })); regen = true; } catch (e) { return json(res, 500, { error: '证书生成失败：' + e.message }); }
      }
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'ops-cert', days, regen, by: req.user && req.user.user });
      return json(res, 200, { ok: true, message: regen ? '证书已重新生成（重启服务后生效）' : `证书还有 ${days} 天到期，无需处理` });
    }
    if (p === '/api/v1/autoformat/status' && m === 'GET') {      const af = settings.autoFormat || {};
      const running = [];
      for (const j of ex.jobs.values()) if (j.status === '运行中') running.push({ device: j.device, serial: j.serial, round: j.round || 1, jobId: j.id });
      return json(res, 200, { paused: !!af.paused, continueOnDefect: af.continueOnDefect !== false, enabled: !!af.enabled, stopSerials: af.stopSerials || [], allowSerials: af.allowSerials || [], running });
    }
    if (p === '/api/v1/autoformat/pause' && m === 'POST') {
      /* 用户 2026-09-20 明确（主从模型）：
         点全局暂停 → 单盘全部暂停（同时清空"单盘放行"名单）
         点全局续格 → 单盘全部续格（同时清空所有单盘的"不再续格"标记） */
      const cur0 = settings.autoFormat || {};
      const want = !!body.paused;
      const cleared = want ? 0 : (cur0.stopSerials || []).length;
      settings.autoFormat = Object.assign({}, cur0, {
        paused: want,
        allowSerials: [],
        stopSerials: want ? (cur0.stopSerials || []) : [],
      });
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-pause', paused: want, clearedStopSerials: cleared, by: req.user && req.user.user });
      return json(res, 200, { ok: true, paused: want, stopSerials: settings.autoFormat.stopSerials || [], allowSerials: [] });
    }
    if (p === '/api/v1/autoformat/stop-serial' && m === 'POST') {
      const sn = String(body.serial || '').trim();
      if (!sn) return json(res, 400, { error: '缺少序列号' });
      const act = String(body.action || 'add');
      const at = settings.autoFormat || {};
      const on = (arr, yes) => yes ? (arr.indexOf(sn) >= 0 ? arr : arr.concat([sn])) : arr.filter((x) => x !== sn);
      let stops = (at.stopSerials || []).slice(), allows = (at.allowSerials || []).slice();
      if (act === 'remove') { stops = on(stops, false); }
      else if (act === 'allow') { allows = on(allows, true); stops = on(stops, false); }
      else if (act === 'unallow') { allows = on(allows, false); }
      else { stops = on(stops, true); allows = on(allows, false); }
      settings.autoFormat = Object.assign({}, at, { stopSerials: stops, allowSerials: allows });
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-stop-serial', serial: sn, action: act, by: req.user && req.user.user });
      return json(res, 200, { ok: true, stopSerials: stops, allowSerials: allows });
    }

    /* 自动续格控制 / 单盘截停（按机器维度）
       ─ 2026-09-20 修复：前端「不再续格 / 暂停自动续格」原来只会打到「当前页面那台机器」，
         在别的机器页面里用下拉选中远端机器时会标错机器（表现为“点了没反应/什么也没变”）。
         这里提供 /api/v1/machines/<mid>/autoformat/(status|pause|stop-serial)，远端走代理。 */
    mm = p.match(/^\/api\/v1\/machines\/([^/]+)\/autoformat\/(status|pause|stop-serial)$/);
    if (mm) {
      const machine = findMachine(mm[1]);
      if (!machine) return json(res, 404, { error: '机器不存在' });
      if (!machine.local) return proxy(machine, req, res, `/api/v1/autoformat/${mm[2]}`, m, body, u.query);
      if (mm[2] === 'status') {
        const af2 = settings.autoFormat || {};
        const running2 = [];
        for (const j of ex.jobs.values()) if (j.status === '运行中') running2.push({ device: j.device, serial: j.serial, round: j.round || 1, jobId: j.id });
        return json(res, 200, { paused: !!af2.paused, continueOnDefect: af2.continueOnDefect !== false, enabled: !!af2.enabled, stopSerials: af2.stopSerials || [], allowSerials: af2.allowSerials || [], running: running2 });
      }
      if (mm[2] === 'pause') {
        /* 同本机端点：全局暂停=单盘全停；全局续格=单盘全续（清空停止标记） */
        const cur1 = settings.autoFormat || {};
        const want1 = !!body.paused;
        const cleared1 = want1 ? 0 : (cur1.stopSerials || []).length;
        settings.autoFormat = Object.assign({}, cur1, {
          paused: want1,
          allowSerials: [],
          stopSerials: want1 ? (cur1.stopSerials || []) : [],
        });
        store.save('settings', settings);
        store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-pause', paused: want1, clearedStopSerials: cleared1, by: req.user && req.user.user });
        return json(res, 200, { ok: true, paused: want1, stopSerials: settings.autoFormat.stopSerials || [], allowSerials: [] });
      }
      const sn2 = String(body.serial || '').trim();
      if (!sn2) return json(res, 400, { error: '缺少序列号' });
      const act2 = String(body.action || 'add');
      const at2 = settings.autoFormat || {};
      const on2 = (arr, yes) => yes ? (arr.indexOf(sn2) >= 0 ? arr : arr.concat([sn2])) : arr.filter((x) => x !== sn2);
      let stops2 = (at2.stopSerials || []).slice(), allows2 = (at2.allowSerials || []).slice();
      if (act2 === 'remove') { stops2 = on2(stops2, false); }
      else if (act2 === 'allow') { allows2 = on2(allows2, true); stops2 = on2(stops2, false); }
      else if (act2 === 'unallow') { allows2 = on2(allows2, false); }
      else { stops2 = on2(stops2, true); allows2 = on2(allows2, false); }
      settings.autoFormat = Object.assign({}, at2, { stopSerials: stops2, allowSerials: allows2 });
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoformat-stop-serial', serial: sn2, action: act2, by: req.user && req.user.user });
      return json(res, 200, { ok: true, stopSerials: stops2, allowSerials: allows2 });
    }

    /* 机器列表同步：POST 立即同步 / GET 状态 */
    if (p === '/api/v1/machines/sync' && m === 'POST') {
      const r = await syncMachines();
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'machines-sync', by: req.user && req.user.user, total: r.total, added: r.added });
      return json(res, 200, r);
    }
    if (p === '/api/v1/machines/sync' && m === 'GET') {
      const st = store.load('settings');
      return json(res, 200, { lastSyncAt: st.lastSyncAt || null, enabled: st.syncEnabled !== false, intervalSec: st.syncIntervalSec || 60, total: store.load('machines').length });
    }

    /* 远程机器：终端执行 + 输出流（命令行可选目标机器，5.1）*/
    mm = p.match(/^\/api\/v1\/machines\/([^/]+)\/terminal\/exec$/);
    if (mm && m === 'POST') {
      const machine = findMachine(mm[1]);
      if (!machine) return json(res, 404, { error: '机器不存在' });
      if (machine.local) return json(res, 400, { error: '本机请用 /api/v1/terminal/exec' });
      try {
        const r = await remoteJson(machine, '/api/v1/terminal/exec', 'POST', body);
        const t = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(t);
      } catch (e) { return json(res, 504, { error: '目标机器不可达：' + String(e.message || e) }); }
    }
    mm = p.match(/^\/api\/v1\/machines\/([^/]+)\/terminal\/([^/]+)\/(stream|stop|cwd)$/);
    if (mm) {
      const machine = findMachine(mm[1]);
      if (!machine) return json(res, 404, { error: '机器不存在' });
      if (machine.local) return json(res, 400, { error: '本机请用 /api/v1/terminal/...' });
      const tail = `/api/v1/terminal/${mm[2]}/${mm[3]}`;
      if (mm[3] === 'stream' && m === 'GET') return proxySSE(machine, req, res, tail, u.query);
      try {
        const r = await remoteJson(machine, tail, m, body);
        const t = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(t);
      } catch (e) { return json(res, 504, { error: '目标机器不可达：' + String(e.message || e) }); }
    }

    /* 本机“正在格式化”总览：不只看本服务发起的，连终端/脚本发起的（sg_turs 探测）也扫出来 */
    if (p === '/api/v1/formatting' && m === 'GET') {
      const r = await getDisks(false);
      const out = [];
      await Promise.all(r.disks.filter((d) => d.sg).map(async (d) => {
        try {
          const t = await detect.runTool('sg_turs', ['-v', d.sg], 8000);
          const txt = (t.stdout || '') + (t.stderr || '');
          if (/not ready/i.test(txt) && /format in progress/i.test(txt)) {
            const mm2 = txt.match(/Progress indication:\s*([\d.]+)%/);
            out.push({ device: d.device, serial: d.serial, model: d.model, brand: d.brand, source: 'disk', progress: mm2 ? Number(mm2[1]) : null, stage: '格式化中（终端/脚本发起）', status: '运行中' });
          }
        } catch (e) {}
      }));
      for (const j of ex.jobs.values()) {
        if (j.status !== '运行中' && j.status !== '排队') continue;
        if (out.some((x) => x.device === j.device)) continue;
        out.push({ device: j.device, serial: j.serial, model: '', brand: j.brand, source: 'app', progress: j.progress, stage: j.stage, status: j.status, tool: j.toolName, lunSize: j.lunSize, jobId: j.id, round: j.round || 1, adopted: !!j.adopted, queuePos: j.status === '排队' ? (ex.queues.get(j.toolId) || []).indexOf(j) + 1 : 0 });
      }
      /* 兜底：有些工具（hugo / wdckit）格式化时盘不报 not-ready，用进程参数识别 */
      try {
        const ps = await detect.run('bash', ['-lc', "ps -eo args= | grep -Ei 'hugo .*format|wdckit .*format|sg_format|SeaChest_Format' | grep -v grep | head -40"], 8000);
        const lines = (ps.stdout || '').split('\n').filter(Boolean);
        const seenDev = new Set(out.map((x) => x.device));
        for (const ln of lines) {
          const devs = ln.match(/\/dev\/(sd[a-z]+|sg[0-9]+)/g) || [];
          for (const dv of devs) {
            const d = r.disks.find((x) => x.device === dv || x.sg === dv);
            if (!d || seenDev.has(d.device)) continue;
            seenDev.add(d.device);
            out.push({ device: d.device, serial: d.serial, model: d.model, brand: d.brand, source: 'proc', progress: null, stage: '格式化中（外部工具进程）', status: '运行中' });
          }
        }
      } catch (e) {}
      return json(res, 200, { formatting: out, dryRun: settings.dryRun, autoFormat: settings.autoFormat, count: out.length });
    }

    /* 远程机器的格式化任务列表（前端“本机在格盘总览”用）*/
    mm = p.match(/^\/api\/v1\/machines\/([^/]+)\/jobs$/);
    if (mm && m === 'GET') {
      const machine = findMachine(mm[1]);
      if (!machine) return json(res, 404, { error: '机器不存在' });
      if (machine.local) {
        const list = [];
        for (const j of ex.jobs.values()) list.push(ex.pub(j));
        list.sort((a, b) => b.startedAt - a.startedAt);
        return json(res, 200, { jobs: list.slice(0, 100), dryRun: settings.dryRun, autoFormat: settings.autoFormat });
      }
      return proxy(machine, req, res, '/api/v1/jobs', 'GET', null, u.query);
    }
    mm = p.match(/^\/api\/v1\/machines\/([^/]+)\/formatting$/);
    if (mm && m === 'GET') {
      const machine = findMachine(mm[1]);
      if (!machine) return json(res, 404, { error: '机器不存在' });
      if (machine.local) {
        const r = await getDisks(false);
        const out = [];
        await Promise.all(r.disks.filter((d) => d.sg).map(async (d) => {
          try {
            const t = await detect.runTool('sg_turs', ['-v', d.sg], 8000);
            const txt = (t.stdout || '') + (t.stderr || '');
            if (/not ready/i.test(txt) && /format in progress/i.test(txt)) {
              const mm2 = txt.match(/Progress indication:\s*([\d.]+)%/);
              out.push({ device: d.device, serial: d.serial, model: d.model, brand: d.brand, source: 'disk', progress: mm2 ? Number(mm2[1]) : null, stage: '格式化中（终端/脚本发起）', status: '运行中' });
            }
          } catch (e) {}
        }));
        for (const j of ex.jobs.values()) {
          if (j.status !== '运行中' || out.some((x) => x.device === j.device)) continue;
          out.push({ device: j.device, serial: j.serial, brand: j.brand, source: 'app', progress: j.progress, stage: j.stage, status: j.status, tool: j.toolName, lunSize: j.lunSize, jobId: j.id });
        }
        return json(res, 200, { formatting: out, dryRun: settings.dryRun, autoFormat: settings.autoFormat, count: out.length });
      }
      return proxy(machine, req, res, '/api/v1/formatting', 'GET', null, u.query);
    }

    /* 硬盘 */
    mm = p.match(/^\/api\/v1\/machines\/([^/]+)\/disks(\/.*)?$/);
    if (mm) {
      const mid = mm[1], tail = mm[2] || '';
      if (mid !== 'local') {
        const machine = findMachine(mid);
        if (!machine) return json(res, 404, { error: '机器不存在' });
        return proxy(machine, req, res, p.replace(`/api/v1/machines/${mid}`, '/api/v1/machines/local'), m, body, u.query);
      }
      if (!tail && m === 'GET') {
        const r = await getDisks(u.query.scan === '1');
        if (u.query.scan === '1') autoformat.tickSoon(ex, 1200);   // 手动刷新硬盘后也按“有缺陷就格”的规则跑一轮
        return json(res, 200, { disks: r.disks, tools: r.tools, scannedAt: r.scannedAt, localIps: localIPs(), port: settings.nodePort, dryRun: settings.dryRun });
      }
      if (tail === '/scan' && m === 'POST') {
        const r = await getDisks(true);
        autoformat.tickSoon(ex, 1200);
        return json(res, 200, { disks: r.disks, tools: r.tools, scannedAt: r.scannedAt });
      }
      mm = tail.match(/^\/([^/]+)$/);
      if (mm && m === 'GET') {
        const r = await getDisks(false);
        const d = r.disks.find((x) => x.id === decodeURIComponent(mm[1]) || x.device === decodeURIComponent(mm[1]));
        if (!d) return json(res, 404, { error: '硬盘不存在' });
        return json(res, 200, d);
      }
      mm = tail.match(/^\/([^/]+)\/override$/);
      if (mm && m === 'PATCH') {
        const r = await getDisks(false);
        const d = r.disks.find((x) => x.id === decodeURIComponent(mm[1]) || x.device === decodeURIComponent(mm[1]));
        if (!d || !d.serial) return json(res, 400, { error: '找不到该硬盘或序列号为空' });
        const ov = store.load('overrides');
        ov[d.serial] = Object.assign({ serial: d.serial, at: Date.now() }, ov[d.serial] || {}, body);
        store.save('overrides', ov);
        store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'override', serial: d.serial, device: d.device, auto: { brand: d.autoBrand, it: d.autoInterface, defect: d.autoDefectStatus }, manual: body });
        diskCache = { at: 0, data: null };
        const r2 = await getDisks(true);
        return json(res, 200, r2.disks.find((x) => x.id === d.id));
      }
      mm = tail.match(/^\/([^/]+)\/preview$/);
      if (mm && m === 'POST') {
        const r = await getDisks(false);
        const d = r.disks.find((x) => x.id === decodeURIComponent(mm[1]) || x.device === decodeURIComponent(mm[1]));
        if (!d) return json(res, 404, { error: '硬盘不存在' });
        const rendered = rules.renderCommand(d, body, settings);
        const pf = rules.preflight(d, body, settings, rendered);
        return json(res, 200, { disk: { device: d.device, serial: d.serial, brand: d.brand, interfaceType: d.interfaceType, defectStatus: d.defectStatus, sizeText: d.sizeText, isSystemDisk: d.isSystemDisk, isMounted: d.isMounted }, rendered, allow: d.allowFormat, blockReason: d.blockReason, preflight: pf });
      }
      mm = tail.match(/^\/([^/]+)\/format$/);
      if (mm && m === 'POST') {
        const r = await getDisks(false);
        const d = r.disks.find((x) => x.id === decodeURIComponent(mm[1]) || x.device === decodeURIComponent(mm[1]));
        if (!d) return json(res, 404, { error: '硬盘不存在' });
        if (!body.confirm) return json(res, 400, { error: '缺少二次确认（勾选框）', needConfirm: true });
        /* 硬拦截（系统盘/挂载盘/无缺陷记录）：不可覆盖 */
        const hardBlock = (d.isSystemDisk && settings.protect.blockSystemDisk) || (d.isMounted && settings.protect.blockMountedDisk) || d.defectStatus === '无';
        if (hardBlock) return json(res, 403, { error: '该硬盘被规则拦截：' + d.blockReason, blockReason: d.blockReason });
        const rendered = rules.renderCommand(d, body, settings);
        const pf = rules.preflight(d, body, settings, rendered);
        if (!pf.ok) return json(res, 403, { error: '执行前校验未通过', preflight: pf });
        const job = ex.newJob(d, body, rendered, settings);
        return json(res, 200, { job: ex.pub(job), preflight: pf });
      }
      /* 批量命令预览（不执行，给二次确认框显示“将要用的命令”）*/
      if (tail === '/batch-preview' && m === 'POST') {
        const ids = body.ids || [];
        const r0 = await getDisks(false);
        const sel = ids.map((id) => r0.disks.find((x) => x.id === id || x.device === id)).filter(Boolean);
        const groups = rules.renderBatch(sel, body.cfg || body, settings);
        return json(res, 200, {
          count: sel.length,
          disks: sel.map((d) => ({ id: d.id, device: d.device, model: d.model, serial: d.serial, brand: d.brand, interfaceType: d.interfaceType, sg: d.sg, allowFormat: d.allowFormat, blockReason: d.blockReason })),
          groups: groups.map((g) => ({ toolId: g.toolId, toolName: g.toolName, count: g.count, devices: g.devices, command: g.command, inToolCommand: g.inToolCommand, cwd: g.cwd, warnings: g.warnings, isBatch: g.isBatch })),
        });
      }
      /* 批量格式化（第十三章）：多盘按工具分组，每组一条批量命令 */
      if (tail === '/batch-format' && m === 'POST') {
        if (!body.confirm) return json(res, 400, { error: '缺少二次确认', needConfirm: true });
        const r = await getDisks(false);
        const ids = body.ids || [];
        const cfg = body.cfg || body;
        const sel = ids.map((id) => r.disks.find((x) => x.id === id || x.device === id)).filter(Boolean);
        const results = [];
        const allowed = [];
        for (const d of sel) {
          const hardBlock = (d.isSystemDisk && settings.protect.blockSystemDisk) || (d.isMounted && settings.protect.blockMountedDisk) || d.defectStatus === '无';
          if (hardBlock) { results.push({ id: d.id, device: d.device, ok: false, error: d.blockReason || '规则拦截' }); continue; }
          allowed.push(d);
        }
        const groups = rules.renderBatch(allowed, cfg, settings);
        for (const g of groups) {
          if (g.toolId === 'custom' && !String(g.command || '').trim()) { results.push({ ok: false, device: g.devices.map((x) => x.device).join(','), error: '未匹配到工具（品牌/接口不在映射表里），请手动指定工具' }); continue; }
          const problems = [];
          for (const dv of g.devices) {
            const full = allowed.find((x) => x.id === dv.id || x.device === dv.device);
            const pf = rules.preflight(full, cfg, settings, { toolId: g.toolId, lunSize: g.lunSize, cwd: g.cwd, binPath: g.binPath });
            if (!pf.ok) problems.push(`${dv.device}: ${pf.problems.join('；')}`);
          }
          if (problems.length) { results.push({ ok: false, device: g.devices.map((x) => x.device).join(','), error: problems.join(' / ') }); continue; }
          const rendered = { toolId: g.toolId, toolName: g.toolName, command: g.command, cwd: g.cwd, lunSize: g.lunSize, mode: '', isBatch: g.isBatch };
          const first = allowed.find((x) => x.id === g.devices[0].id || x.device === g.devices[0].device);
          const job = ex.newJob(first, cfg, rendered, settings, { devices: g.devices.map((x) => x.device), label: `多盘(${g.count}块)` });
          results.push({ ok: true, jobId: job.id, device: g.devices.map((x) => x.device).join(' '), command: g.command, count: g.count });
        }
        return json(res, 200, { results });
      }
      mm = tail.match(/^\/([^/]+)\/stop$/);
      if (mm && m === 'POST') {
        const ok = ex.stopJob(body.jobId);
        return json(res, 200, { ok });
      }
    }

    /* 任务完整日志下载（第十三章） */
    mm = p.match(/^\/api\/v1\/jobs\/([^/]+)\/log$/);
    if (mm && m === 'GET') {
      const job = ex.jobs.get(mm[1]);
      if (!job) return json(res, 404, { error: '任务不存在' });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="format-${job.device.replace(/[^a-z0-9]/gi, '')}-${job.id}.log"` });
      return res.end(`任务 ${job.id}\n设备 ${job.device}\n序列号 ${job.serial || '-'}\n品牌/接口 ${job.brand}/${job.interfaceType}\n逻辑块大小 ${job.lunSize}B\n工具 ${job.toolName}\n命令 ${job.command}\n工作目录 ${job.cwd || '-'}\ndryRun ${job.dryRun}\n开始 ${new Date(job.startedAt).toLocaleString('zh-CN')}\n结束 ${job.endedAt ? new Date(job.endedAt).toLocaleString('zh-CN') : '-'}\n状态 ${job.status}\n\n` + job.log.join('\n') + '\n');
    }

    /* 任务进度 SSE */
    mm = p.match(/^\/api\/v1\/jobs\/([^/]+)\/stream$/);
    if (mm) {
      const job = ex.jobs.get(mm[1]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ type: 'state', state: ex.pub(job || {}) });
      if (job) job.subs.add(send);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { clearInterval(hb); if (job) job.subs.delete(send); });
      return;
    }

    /* 终端 */
    if (p === '/api/v1/terminal/exec' && m === 'POST') {
      const r = ex.execInSession(body.sessionId, body.cmd, body.cwd, { confirm: !!body.confirm });
      return json(res, 200, r);
    }
    mm = p.match(/^\/api\/v1\/terminal\/([^/]+)\/stream$/);
    if (mm) {
      const s = ex.getSession(mm[1]);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (line) => res.write(`data: ${JSON.stringify({ line })}\n\n`);
      for (const line of s.buffer.slice(-300)) send(line);
      s.subs.add(send);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { clearInterval(hb); s.subs.delete(send); });
      return;
    }
    mm = p.match(/^\/api\/v1\/terminal\/([^/]+)\/(stop|cwd)$/);
    if (mm && m === 'POST') {
      const s = ex.getSession(mm[1]);
      if (mm[2] === 'stop') return json(res, 200, { ok: ex.stopSession(mm[1]) });
      if (body.cwd) s.cwd = body.cwd;
      return json(res, 200, { cwd: s.cwd });
    }
    if (p === '/api/v1/terminal/history' && m === 'GET') {
      const all = [];
      for (const s of ex.sessions.values()) for (const h of s.history) all.push(Object.assign({ session: s.name }, h));
      return json(res, 200, { history: all.slice(0, 100), cwd: process.env.HOME });
    }

    /* 所有格式化任务（前端用：按盘显示进度 + 本机在格盘总览）*/
    if (p === '/api/v1/jobs' && m === 'GET') {
      const list = [];
      for (const j of ex.jobs.values()) list.push(ex.pub(j));
      list.sort((a, b) => b.startedAt - a.startedAt);
      return json(res, 200, { jobs: list.slice(0, 100), dryRun: settings.dryRun, autoFormat: settings.autoFormat });
    }
    /* 清理全局日志（归档/清空）*/
    if (p === '/api/v1/logs/clear' && m === 'POST') {
      const mode = body.mode === 'truncate' ? 'truncate' : 'archive';
      const f = path.join(store.DATA, 'audit.jsonl');
      let size = 0;
      try { size = fs.statSync(f).size; } catch (e) { size = 0; }
      if (size > 0) {
        try {
          if (mode === 'archive') {
            const name = 'audit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
            fs.renameSync(f, path.join(store.DATA, name));
          } else {
            fs.writeFileSync(f, '');
          }
        } catch (e) { return json(res, 500, { error: '清理失败：' + e.message }); }
      }
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'logs-clear', mode, bytes: size, by: req.user && req.user.user });
      return json(res, 200, { ok: true, mode, freedMB: +(size / 1048576).toFixed(2) });
    }

    /* 用户管理（第十二章）：增/删/改/查，admin 专属 */
    if (p === '/api/v1/users' && m === 'GET') {
      let us = (settings.auth.users || []).map((x) => ({ user: x.user, role: x.role }));
      const q = (u.query.q || '').trim().toLowerCase();
      const role = (u.query.role || '').trim();
      if (q) us = us.filter((x) => x.user.toLowerCase().includes(q));
      if (role) us = us.filter((x) => x.role === role);
      return json(res, 200, {
        users: us, total: (settings.auth.users || []).length,
        authEnabled: settings.auth.enabled, tokenTtlMin: settings.auth.tokenTtlMin,
        current: req.user.user,
      });
    }
    /* 增 */
    if (p === '/api/v1/users' && m === 'POST') {
      const us = settings.auth.users || (settings.auth.users = []);
      const name = String(body.user || '').trim();
      if (!name) return json(res, 400, { error: '用户名不能为空' });
      if (!body.pass || String(body.pass).length < 4) return json(res, 400, { error: '密码至少 4 位' });
      if (!RANK[body.role]) return json(res, 400, { error: '角色必须是 viewer / operator / admin' });
      if (us.some((x) => x.user === name)) return json(res, 409, { error: `账号 ${name} 已存在（用“编辑”修改）` });
      us.push({ user: name, pass: String(body.pass), role: body.role });
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'user-add', user: name, role: body.role, by: req.user.user });
      return json(res, 200, { ok: true, users: us.map((x) => ({ user: x.user, role: x.role })) });
    }
    /* 改（角色 / 密码 / 改名） */
    mm = p.match(/^\/api\/v1\/users\/([^/]+)$/);
    if (mm && m === 'PATCH') {
      const us = settings.auth.users || [];
      const oldName = decodeURIComponent(mm[1]);
      const tgt = us.find((x) => x.user === oldName);
      if (!tgt) return json(res, 404, { error: '账号不存在' });
      const admins = us.filter((x) => x.role === 'admin');
      if (body.role && body.role !== tgt.role) {
        if (!RANK[body.role]) return json(res, 400, { error: '角色非法' });
        if (tgt.role === 'admin' && admins.length <= 1 && body.role !== 'admin') return json(res, 400, { error: '至少保留一个 admin 账号' });
        tgt.role = body.role;
      }
      if (body.pass) {
        if (String(body.pass).length < 4) return json(res, 400, { error: '密码至少 4 位' });
        tgt.pass = String(body.pass);
      }
      if (body.newUser && body.newUser !== oldName) {
        const nn = String(body.newUser).trim();
        if (!nn) return json(res, 400, { error: '新用户名不能为空' });
        if (us.some((x) => x.user === nn)) return json(res, 409, { error: `账号 ${nn} 已存在` });
        tgt.user = nn;
        if (req.user.user === oldName) { /* 改了名字后旧 token 仍指向旧名 */ }
      }
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'user-update', user: oldName, to: tgt.user, role: tgt.role, passChanged: !!body.pass, by: req.user.user });
      return json(res, 200, { ok: true, user: { user: tgt.user, role: tgt.role } });
    }
    /* 删 */
    if (mm && m === 'DELETE') {
      const us = settings.auth.users || [];
      const name = decodeURIComponent(mm[1]);
      const tgt = us.find((x) => x.user === name);
      if (!tgt) return json(res, 404, { error: '账号不存在' });
      if (name === req.user.user) return json(res, 400, { error: '不能删除当前登录的账号' });
      if (tgt.role === 'admin' && us.filter((x) => x.role === 'admin').length <= 1) return json(res, 400, { error: '至少保留一个 admin 账号' });
      const i = us.findIndex((x) => x.user === name);
      us.splice(i, 1);
      store.save('settings', settings);
      for (const [k, v] of tokens) if (v.user === name) tokens.delete(k);
      saveTokens();
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'user-delete', user: name, by: req.user.user });
      return json(res, 200, { deleted: name });
    }
    if (p === '/api/v1/password' && m === 'POST') {
      const u0 = (settings.auth.users || []).find((x) => x.user === req.user.user);
      if (!u0) return json(res, 404, { error: '账号不存在' });
      if (u0.pass !== body.old) return json(res, 400, { error: '原密码不正确' });
      if (!body.new || String(body.new).length < 4) return json(res, 400, { error: '新密码至少 4 位' });
      u0.pass = String(body.new);
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'password-change', user: u0.user });
      return json(res, 200, { ok: true });
    }

    /* 工具与设置 */

    /* 目录浏览（设置页图形化选工具路径） */
    if (p === '/api/v1/fs/list' && m === 'GET') {
      const home = settings.homeDir || process.env.HOME || '/root';
      const raw = String(u.query.path || home);
      const target = path.resolve(raw.replace(/^~(?=\/|$)/, home));
      let entries = [];
      try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch (e) { return json(res, 400, { error: '无法读取目录：' + target + '（' + e.code + '）' }); }
      const reHugo = /^hugo-[\d.]+[.\-_]x86_64$/i, reWd = /^wdckit-[\d.]+[.\-_]x86_64$/i, reSea = /^SeaChest/i;
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => {
        const full = path.join(target, e.name);
        const it = { name: e.name, path: full, tool: null, bin: null };
        if (reHugo.test(e.name)) { it.tool = 'hugo'; if (fs.existsSync(path.join(full, 'hugo'))) it.bin = 'hugo'; }
        else if (reWd.test(e.name)) { it.tool = 'wdckit'; if (fs.existsSync(path.join(full, 'wdckit'))) it.bin = 'wdckit'; }
        else if (reSea.test(e.name)) { it.tool = 'seachest'; }
        return it;
      }).sort((a, b) => (a.tool === b.tool ? a.name.localeCompare(b.name) : (a.tool ? -1 : 1)));
      const parent = path.dirname(target);
      return json(res, 200, { path: target, parent: parent === target ? null : parent, home, dirs: dirs.slice(0, 500) });
    }
    /* 工具目录候选（按文档形式扫家目录） */
    if (p === '/api/v1/fs/candidates' && m === 'GET') {
      const d = toolsDetect.detect(settings.homeDir);
      return json(res, 200, {
        hugo: d.all.hugo.map((x) => ({ path: x.path + '/', bin: x.bin })),
        wdckit: d.all.wdckit.map((x) => ({ path: x.path + '/', bin: x.bin })),
        seachest: d.all.seachest.map((x) => ({ path: x.path + '/', bin: x.bin })),
        home: settings.homeDir,
      });
    }
    if (p === '/api/v1/tools' && m === 'GET') return json(res, 200, { tools: rules.TOOLS, paths: settings.toolPaths, bins: settings.toolBins, homeDir: settings.homeDir, detected: toolsDetect.detect(settings.homeDir).summary });
    /* 自动探测本地工具包路径（各机版本/文件名不同）*/
    if (p === '/api/v1/tools/detect' && m === 'GET') {
      const d = toolsDetect.detect(settings.homeDir);
      return json(res, 200, { detected: d.summary, detail: d.all, scannedHome: d.scannedHome, current: settings.toolPaths, currentBins: settings.toolBins });
    }
    if (p === '/api/v1/tools/detect' && m === 'POST') {
      if (!settings.homeDir || !require('fs').existsSync(settings.homeDir)) settings.homeDir = store.resolveHome(settings);
      const d = toolsDetect.detect(settings.homeDir);
      const applied = {};
      for (const k of ['hugo', 'wdckit', 'seachest']) {
        if (d[k]) { settings.toolPaths[k] = d[k].path + '/'; settings.toolBins[k] = d[k].bin; applied[k] = d[k].path + '/' + d[k].bin; }
      }
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'tools-detect', applied, by: req.user && req.user.user });
      return json(res, 200, { ok: true, applied, detected: d.summary, homeDir: settings.homeDir, missing: ['hugo', 'wdckit', 'seachest'].filter((k) => !d[k]) });
    }
    if (/^\/api\/v1\/tools\/detect$/.test(p)) { /* handled above */ }
    mm = p.match(/^\/api\/v1\/tools\/([^/]+)$/);
    if (mm && m === 'PATCH') {
      const t = rules.TOOLS.find((x) => x.id === mm[1]);
      if (!t) return json(res, 404, { error: '工具不存在' });
      if (body.modes) Object.assign(t.modes, body.modes);
      if (body.supports) t.supports = body.supports;
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'tool-config', tool: t.id, patch: body });
      return json(res, 200, t);
    }
    if (p === '/api/v1/clean' && m === 'GET') {
      return json(res, 200, { settings: settings.clean, scannedHome: settings.homeDir, matched: cleaner.scan(settings).map((f) => ({ path: f.path, sizeMB: +(f.size / 1048576).toFixed(2) })) });
    }
    if (p === '/api/v1/clean/now' && m === 'POST') {
      const r = cleaner.run(settings);
      settings = store.load('settings');
      settings.clean.lastRun = r.at; settings.clean.lastFreed = r.freed;
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: r.at, kind: 'clean', reason: '手动', mode: r.mode, freed: r.freed, files: r.files.map((f) => ({ p: f.path, sz: f.size })), errors: r.errors });
      return json(res, 200, { ok: true, mode: r.mode, freedMB: +(r.freed / 1048576).toFixed(2), files: r.files, errors: r.errors });
    }
    if (p === '/api/v1/settings' && m === 'GET') return json(res, 200, settings);
    if (p === '/api/v1/settings' && m === 'PATCH') {
      settings = Object.assign(settings, body, { toolPaths: Object.assign(settings.toolPaths, body.toolPaths || {}), toolBins: Object.assign(settings.toolBins || {}, body.toolBins || {}), clean: Object.assign(settings.clean || {}, body.clean || {}), autoFormat: Object.assign(settings.autoFormat || {}, body.autoFormat || {}), toolSession: Object.assign(settings.toolSession || { enabled: true, idleQuitSec: 600 }, body.toolSession || {}), terminal: Object.assign(settings.terminal, body.terminal || {}), protect: Object.assign(settings.protect, body.protect || {}) });
      store.save('settings', settings);
      store.appendJSONL('audit.jsonl', { at: Date.now(), kind: 'settings', patch: body });
      return json(res, 200, settings);
    }
    if (p === '/api/v1/logs' && m === 'GET') {
      return json(res, 200, { logs: store.readJSONL('audit.jsonl', Number(u.query.limit) || 200) });
    }
    if (p === '/api/v1/templates' && m === 'GET') return json(res, 200, { templates: store.load('templates') });
    if (p === '/api/v1/templates' && m === 'POST') {
      const ts = store.load('templates');
      const key = (t) => [t.brand || '', t.interfaceType || '', t.toolId || '', t.mode || '', t.lunSize || ''].join('|');
      const dup = ts.find((x) => key(x) === key(body));
      if (dup) return json(res, 200, { duplicated: true, template: dup, error: `同样的模板已存在（${dup.brand || '*'}/${dup.toolId}/${dup.mode}/${dup.lunSize}B），未重复添加` });
      const item = Object.assign({ id: 'tp_' + Math.random().toString(36).slice(2, 8), at: Date.now() }, body);
      ts.push(item); store.save('templates', ts);
      return json(res, 200, item);
    }
    mm = p.match(/^\/api\/v1\/templates\/([^/]+)$/);
    if (mm && m === 'DELETE') {
      const ts = store.load('templates');
      const i = ts.findIndex((x) => x.id === mm[1]);
      if (i < 0) return json(res, 404, { error: '模板不存在' });
      const [del] = ts.splice(i, 1); store.save('templates', ts);
      return json(res, 200, { deleted: del.id });
    }
    mm = p.match(/^\/api\/v1\/terminal\/([^/]+)\/history$/);
    if (mm && m === 'GET') {
      const s = ex.getSession(mm[1]);
      return json(res, 200, { history: s.history });
    }

    return json(res, 404, { error: '未知接口 ' + p });
  } catch (e) {
    return json(res, 500, { error: String(e && e.stack || e) });
  }
};

const PORT = Number(process.env.PORT || settings.nodePort || 8090);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || settings.httpsPort || 8443);
const server = http.createServer(handler);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[disk-webui] v${VERSION} HTTP  listening on http://0.0.0.0:${PORT}`);
  localIPs().forEach((i) => console.log('   http://' + i.ip + ':' + PORT));
  startScheduler();
  startHotplug();
  const hp = (settings.hotplug && settings.hotplug.every) || { n: 5, unit: 'second' };
  console.log('[disk-webui] 热插拔监听: ' + ((settings.hotplug && settings.hotplug.enabled === false) ? '已关闭' : ('已开启（每 ' + hp.n + ' ' + hp.unit + ' 检查）')));
  autoformat.start(ex);
  /* 重启后认领重启前遗留、仍在跑的任务 */
  try {
    const adopted = ex.adoptJobs(settings);
    if (adopted && adopted.length) console.log('[disk-webui] 已认领重启前遗留任务 ' + adopted.length + ' 个：' + adopted.map((a) => a.device).join(' '));
  } catch (e) { console.error('[disk-webui] 认领遗留任务出错:', e.message); }
  /* 重启后重新接管已存在的 tmux 常驻工具会话 */
  try {
    const re = ex.attachExistingSessions(settings);
    if (re && re.length) console.log('[disk-webui] 已重新接管常驻工具会话：' + re.join(' '));
  } catch (e) { console.error('[disk-webui] 接管常驻会话出错:', e.message); }
  /* 清理空转的遗留工具会话（script 模式重启不会接管，越堆越多会拖垮机器） */
  try {
    const reaped = ex.reapIdleToolSessions(ex.loadRegistry());
    if (reaped && reaped.length) console.log('[disk-webui] 待核查的空转工具会话 ' + reaped.length + ' 个（10 秒后确认无 IO 才结束）');
  } catch (e) { console.error('[disk-webui] 清理遗留会话出错:', e.message); }
  /* 启动时先清理任务日志个数 + 历史/审计轮转（默认不让它们长大） */
  try {
    const sw = ex.sweepJobLogs();
    const rot = rotateBigLogs();
    if ((sw && sw.n) || rot.length) console.log('[disk-webui] 启动清理：任务日志 ' + ((sw && sw.n) || 0) + ' 个，历史/审计 ' + rot.join('、'));
  } catch (e) {}
  startSyncTimer();
  setTimeout(() => { syncMachines().catch(() => {}); }, 8000);
  console.log('[disk-webui] 插盘自动检测: ' + (settings.autoFormat && settings.autoFormat.enabled ? '已开启' : '未开启'));
});

/* HTTPS（自签证书，自动按本机 IP 生成 SAN） */
let httpsServer = null;
if (settings.httpsEnabled !== false) {
  try {
    const tls = require('./lib/tls').ensureCert(settings);
    const https = require('https');
    httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, handler);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[disk-webui] HTTPS listening on https://0.0.0.0:${HTTPS_PORT}  (自签证书，浏览器会提示不安全，正常)`);
      localIPs().forEach((i) => console.log('   https://' + i.ip + ':' + HTTPS_PORT));
    });
    httpsServer.on('error', (e) => console.error('[disk-webui] HTTPS 错误: ' + e.message));
  } catch (e) {
    console.error('[disk-webui] HTTPS 启动失败: ' + (e.message || e));
  }
}

module.exports = { runClean, scheduleClean };
