'use strict';
/* 自动同步更新
   ─ 主服务器 = settings.syncSeeds[0]（默认 192.168.2.139），所有节点以它的代码为准
   ─ 节点每次检查：拿主服务器的构建指纹跟本地比；不一致就拉代码包、校验、覆盖、重启自己
   ─ 离线机器什么都不做，开机后下一次检查自动补齐
   ─ 安全阀：默认“有格式化任务在跑时先不动”（onlyWhenIdle），避免打断正在跑的格式化
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { load, save, appendJSONL } = require('./store');
const build = require('./build');

const APP_DIR = path.join(__dirname, '..');

function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function req(method, url, { token, body, timeoutMs } = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({
        method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
        headers: Object.assign({ 'Content-Type': 'application/json' },
          token ? { 'x-token': token } : {},
          payload ? { 'Content-Length': payload.length } : {}),
        timeout: timeoutMs || 15000,
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      });
      r.on('error', (e) => resolve({ error: e.message }));
      r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
      if (payload) r.write(payload);
      r.end();
    } catch (e) { resolve({ error: e.message }); }
  });
}
async function getJSON(url) {
  const r = await req('GET', url);
  if (r.error || !r.buf) return null;
  try { return JSON.parse(r.buf.toString('utf8')); } catch (e) { return null; }
}

/* 有格式化任务在跑？（hugo / wdckit / sg_format / SeaChest） */
function busyFormatting() {
  try {
    const out = execSync('ps -eo comm= | grep -E "^(hugo|wdckit|sg_format|SeaChest_Format.*)$" | wc -l', { encoding: 'utf8', timeout: 8000 });
    return Number(String(out).trim()) > 0;
  } catch (e) { return false; }
}

function findMasterCreds(st, masterIp) {
  const m = (st.machines || []).find((x) => x && x.ip === masterIp && x.user && x.pass);
  if (m) return { user: m.user, pass: m.pass };
  const u = ((st.auth && st.auth.users) || [])[0];
  if (u) return { user: u.user, pass: u.pass };
  return { user: 'admin', pass: '12345678' };
}

async function masterLogin(st, masterIp, port) {
  const c = findMasterCreds(st, masterIp);
  const r = await req('POST', `http://${masterIp}:${port}/api/v1/login`, { body: { user: c.user, pass: c.pass } });
  if (r.error || !r.buf) return null;
  try { return JSON.parse(r.buf.toString('utf8')).token || null; } catch (e) { return null; }
}

/* 用主服务器的包覆盖本地代码（保留 data/），成功后重启自己 */
function applyBundle(tgzBuf, masterBuild, log) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dwupd-'));
  fs.writeFileSync(path.join(stage, 'bundle.tar.gz'), tgzBuf);
  execSync(`tar xzf ${JSON.stringify(path.join(stage, 'bundle.tar.gz'))} -C ${JSON.stringify(stage)}`, { timeout: 60000 });
  const files = build.fileList(stage);
  for (const f of files) if (!fs.existsSync(path.join(stage, f))) throw new Error('包不完整，缺 ' + f);
  /* 语法校验（用 node 自检，避免推半截包把服务打挂） */
  try { execSync(`${process.execPath} --check ${JSON.stringify(path.join(stage, 'server.js'))}`, { timeout: 20000 }); }
  catch (e) { throw new Error('新代码语法校验失败，已放弃本次更新'); }
  /* 备份现有代码 */
  const bak = path.join(os.tmpdir(), 'disk_webui.bak-' + Date.now());
  try { execSync(`mkdir -p ${JSON.stringify(bak)} && tar czf - -C ${JSON.stringify(APP_DIR)} --exclude=data --exclude=tls . | tar xzf - -C ${JSON.stringify(bak)}`, { timeout: 60000 }); } catch (e) {}
  /* 覆盖（data/ 与 tls/ 不动） */
  for (const f of files) {
    const dst = path.join(APP_DIR, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(stage, f), dst);
  }
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
  log && log('代码已更新到构建 ' + masterBuild + '，备份在 ' + bak + '，准备重启服务');
  /* 重启自己（脱离当前进程，避免自杀中断） */
  try {
    spawn('sh', ['-c', 'sleep 2; systemctl restart diskwebui.service'], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
  return bak;
}

async function check(force) {
  const st = load('settings');
  const cfg = st.autoUpdate || {};
  /* 主服务器链：主源（syncSeeds[0]）+ 备用源（本机 .59）；主源不可达就自动用备用源 */
  const prim = String((st.syncSeeds && st.syncSeeds[0]) || '192.168.2.139');
  const backups = Array.isArray(st.syncBackups) && st.syncBackups.length ? st.syncBackups : ['192.168.0.59'];
  const port = Number(st.nodePort) || 8090;
  const mine = build.compute(APP_DIR);
  const out = { at: Date.now(), master: prim, backups, localBuild: mine };
  try {
    if (cfg.enabled === false && !force) { out.skipped = '未开启自动更新'; saveState(st, out); return out; }
    const myIps = localIPs();
    if (myIps.indexOf(prim) >= 0) { out.skipped = '本机就是主服务器'; saveState(st, out); return out; }
    /* 用户 2026-09-20 明确：**只要主服务器(syncSeeds[0]，即 139)在线，就只用主源**；
       副源(syncBackups，如 .59) 只在主源**确实不可达**时兜底 —— 避免两边构建不一致把节点来回刷。
       主源改成"连续 3 次都失败"才认定离线（防止主源偶尔忙/超时就被误判掉线）。 */
    let v = null, usedIp = null;
    for (let attempt = 1; attempt <= 3 && !v; attempt++) {
      const t = await getJSON(`http://${prim}:${port}/api/v1/version`).catch(() => null);
      if (t && t.build) { v = t; usedIp = prim; out.primaryAttempts = attempt; }
      else { out.primaryAttempts = attempt; if (attempt < 3) await new Promise((r) => setTimeout(r, 2000)); }
    }
    if (!v) {
      out.primaryUnreachable = true;
      for (const ip of backups.filter((b) => b && b !== prim && myIps.indexOf(b) < 0)) {
        const t = await getJSON(`http://${ip}:${port}/api/v1/version`).catch(() => null);
        if (t && t.build) { v = t; usedIp = ip; out.usedBackup = true; appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoupdate-backup-source', master: ip, note: '主源不可达，改用副源' }); console.log('[disk-webui] 主源不可达 → 改用副源 ' + ip); break; }
      }
    }
    if (!v) { out.error = '主源/备用源都不可达（离线就等下次）'; saveState(st, out); return out; }
    out.master = usedIp;
    if (usedIp !== prim) out.usedBackup = true;   // 只有主源不可达才会走到这里
    const t0 = Date.now();
    v = await getJSON(`http://${usedIp}:${port}/api/v1/version`);
    const t1 = Date.now();
    if (!v || !v.build) { out.error = '主源/备用源都不可达（离线就等下次）'; saveState(st, out); return out; }
    /* ① 校时：以东八区北京时间（主服务器）为准，偏差 >60s 就校正 */
    if (cfg.syncTime !== false && v.at) {
      const masterMs = v.at + (t1 - t0) / 2;
      const offSec = Math.round((Date.now() - masterMs) / 1000);
      out.clockOffsetSec = offSec;
      if (Math.abs(offSec) > 60) {
        try {
          execSync(`timedatectl set-timezone Asia/Shanghai 2>/dev/null; date -s "@${Math.floor(masterMs / 1000)}" >/dev/null 2>&1; hwclock --systohc 2>/dev/null || true`, { timeout: 15000 });
          out.timeFixed = offSec;
          appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoupdate-time', offsetSec: offSec, master: masterIp });
          console.log('[disk-webui] 已按北京时间校时（原偏差 ' + offSec + 's）');
        } catch (e) { out.timeError = e.message; }
      }
    }
    out.masterBuild = v.build;
    if (v.build === mine) { out.upToDate = true; saveState(st, out); return out; }
    if (cfg.onlyWhenIdle !== false && busyFormatting()) { out.skipped = '有格式化任务在跑，稍后再更新'; saveState(st, out); return out; }
    const masterIp = usedIp;
    const token = await masterLogin(st, masterIp, port);
    if (!token) { out.error = '登录更新源失败'; saveState(st, out); return out; }
    const b = await req('GET', `http://${masterIp}:${port}/api/v1/bundle`, { token, timeoutMs: 60000 });
    if (b.error || !b.buf || !b.buf.length) { out.error = '拉取代码包失败：' + (b.error || '空包'); saveState(st, out); return out; }
    applyBundle(b.buf, v.build, (m) => console.log('[disk-webui] ' + m));
    out.updated = { from: mine, to: v.build };
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'autoupdate', from: mine, to: v.build, master: masterIp });
    saveState(st, out, true);
    return out;
  } catch (e) {
    out.error = e.message;
    saveState(st, out);
    return out;
  }
}

function saveState(st, out, updated) {
  try {
    const s = load('settings');
    s.autoUpdate = Object.assign({ enabled: true, every: { n: 5, unit: 'minute' }, onlyWhenIdle: true, syncTime: true }, s.autoUpdate || {}, {
      lastCheck: out.at, lastLocalBuild: out.localBuild, lastMasterBuild: out.masterBuild || null,
      lastClockOffsetSec: out.clockOffsetSec === undefined ? (s.autoUpdate || {}).lastClockOffsetSec : out.clockOffsetSec,
      lastResult: out.updated ? ('已更新 → ' + out.updated.to) : (out.upToDate ? '已是最新' : (out.error || out.skipped || '')),
    });
    if (updated) s.autoUpdate.lastUpdateAt = Date.now();
    save('settings', s);
  } catch (e) {}
}

module.exports = { check, busyFormatting, localIPs };
