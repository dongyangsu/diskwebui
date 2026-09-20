'use strict';
/* 简易 JSON 文件存储：machines / overrides / templates / settings / audit */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

const f = (n) => path.join(DATA, n);

function readJSON(name, def) {
  try { return JSON.parse(fs.readFileSync(f(name), 'utf8')); }
  catch (e) { return def; }
}
function writeJSON(name, val) {
  fs.writeFileSync(f(name), JSON.stringify(val, null, 2));
}
function appendJSONL(name, obj) {
  fs.appendFileSync(f(name), JSON.stringify(obj) + '\n');
}
function readJSONL(name, limit = 200) {
  let txt = '';
  try { txt = fs.readFileSync(f(name), 'utf8'); } catch (e) { return []; }
  const lines = txt.trim().split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try { out.push(JSON.parse(lines[i])); } catch (e) {}
  }
  return out;
}

const DEFAULTS = {
  settings: {
    nodePort: 8090,
    syncEnabled: true,
    syncSeeds: ['192.168.2.139'],
    syncEvery: { n: 1, unit: 'week' },
    disks: { autoRefresh: true, every: { n: 6, unit: 'hour' }, lastAutoAt: 0 },
    /* 热插拔监听：插入/拔出硬盘时按这个频率检查变化（默认 5 秒），一变就立即扫描+自动检测 */
    hotplug: { enabled: true, every: { n: 5, unit: 'second' } },  // 硬盘列表自动刷新（默认每 6 小时）
    syncIntervalSec: 60,
    httpsEnabled: true,           // 同时启用 HTTPS（自签证书）
    httpsPort: 8443,
    dryRun: false,                // 用户 2026-09-16 要求：默认关闭 dryRun（真实执行格式化）
    defaultLunSize: 512,
    toolPaths: {
      hugo: '~/hugo-7.4.5.x86_64/',
      wdckit: '~/wdckit-3.0.2.0-x86_64/',
      seachest: '~/SeaChestUtilities/Linux/Non-RAID/x86_64/',
    },
    /* 工具包所在的家目录：服务以 root 跑时 HOME=/root，需自动定位到真正放工具的那个家（如 /home/admin1）*/
    homeDir: '',
    /* 可执行文件名也可能不同（如 SeaChest_Format / SeaChest_Format_linux_x86_64 / hugo 版本差异）*/
    toolBins: {
      hugo: 'hugo',
      wdckit: 'wdckit',
      seachest: 'SeaChest_Format_linux_x86_64',
    },
    terminal: {
      whitelist: [],              // 空 = 不限制白名单（仍受黑名单与二次确认约束）
      blacklist: ['rm -rf /', 'mkfs', 'wipefs', 'shred', '> /dev/sd', 'of=/dev/sd'],
      needConfirm: true,
      timeoutSec: 300,
    },
    protect: { blockSystemDisk: true, blockMountedDisk: true, blockUnknown: true, minFreePct: 5, minFreeMB: 2048 },
    /* 工具选盘方式：serial=按序列号精确指定单盘（推荐）；model=按型号（同型号全格） */
    hugoPick: 'serial',
    /* sg_format 批量并发（xargs -P）；0 = 不限（与文档一致） */
    sgConcurrency: 0,
    /* 同工具串行排队（默认关 = 各任务独立进程并行、立即执行） */
    serializeTools: false,
    /* hugo 报 already run 时自动稍后重试一次 */
    retryAlreadyRun: true,
    /* 常驻工具会话（默认关：会话天然串行，开启后不能立即并行格盘） */
    toolSession: { enabled: false, idleQuitSec: 600 },
    /* 备用更新源（主源不可达时用；用户 2026-09-17：备用主源 = 本机 .59） */
    syncBackups: ['192.168.0.59'],
    /* 自动同步更新 */
    autoUpdate: { enabled: true, every: { n: 5, unit: 'minute' }, onlyWhenIdle: true, syncTime: true },
    /* 打印 */
    printerName: 'HP_M1522nf',
    labelDir: '',
    auth: {
      enabled: true,                    // 第十二章：查看/格式化/命令行 三级权限
      tokenTtlMin: 240,
      users: [
        { user: 'admin', pass: '12345678', role: 'admin' },      // 全部权限
        { user: 'operator', pass: 'operator123', role: 'operator' }, // 查看 + 格式化
        { user: 'viewer', pass: 'viewer123', role: 'viewer' },     // 只读
      ],
    },
    ipWhitelist: [],                    // 空 = 不限制；填入网段如 192.168.2.0/24
    cmdTimeoutSec: 3600,                // 格式化任务超时
    /* 插盘自动检测 + 自动格式化（有缺陷的盘自动排格式化）*/
    autoFormat: {
      enabled: false,                   // 默认关：开启后“新插入的有缺陷盘”会自动格式化
      onlyWithDefect: true,             // 只对“有缺陷记录”的盘自动格（文档规则：无缺陷则禁止格式化）
      intervalSec: 60,
      every: { n: 6, unit: 'hour' },
      cooldownSec: 300,
      cooldownEvery: { n: 5, unit: 'minute' },
      lastScanAt: 0,
      continueOnDefect: true,          // 格完仍有缺陷 → 立即自动继续格（不限次数）
      paused: false,                    // 全局截停开关
      stopSerials: [],                  // 不再自动续格的盘（序列号）
      allowSerials: [],                 // 全局暂停期间「单独放行」的盘（2026-09-20 用户要求）
      lunSize: 0,                       // 0 = 用 defaultLunSize
      toolId: '',                       // 空 = 按品牌自动推荐
      mode: '',
    },
    /* 定时清理：wdckit.txt / wdckit-trace.txt 等工具日志会长到几十 G（.134 曾达 49G）*/
    clean: {
      enabled: true,
      intervalMin: 30,
      every: { n: 1, unit: 'month' },
      mode: 'truncate',                 // truncate=清空（推荐，工具仍在写也能立即释放）；delete=删除
      patterns: ['wdckit.txt', 'wdckit-trace.txt'],
      dirs: [],                         // 空 = 用 homeDir
      minSizeKB: 0,
      lastRun: null,
      lastFreed: 0,
      systemLogs: true,                 // 同时清理 kern.log/syslog（超 sysLogMaxMB 就截断）
      sysLogMaxMB: 512,
      jobLogKeep: 20,                   // 任务日志文件保留个数（旧的删）——用户要求默认清干净腾空间
    },
    /* 历史/审计保留（用户 2026-09-17：没必要留太久，默认全清腾空间） */
    retention: {
      rotateMB: 5,        // 单文件超过这么多就归档为 .1
      keepArchives: 1,    // 归档文件保留份数（多了删最旧）
      auditLines: 2000,   // audit.jsonl 最多保留行数
      historyLines: 2000, // format-history.jsonl 最多保留行数
    },
  },
  machines: [],
  templates: [],
  overrides: {},                  // key = 序列号
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const b = base[k];
    out[k] = (b && typeof b === 'object' && !Array.isArray(b) && over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
      ? deepMerge(b, over[k]) : over[k];
  }
  return out;
}
function load(name) {
  const def = JSON.parse(JSON.stringify(DEFAULTS[name]));
  const cur = readJSON(name + '.json', null);
  if (cur === null || cur === undefined) return def;
  if (name === 'settings') return deepMerge(def, cur);
  return cur;
}
function save(name, val) { writeJSON(name + '.json', val); }

function initLocalMachine() {
  const machines = load('machines');
  if (!machines.some((m) => m.id === 'local')) {
    const os = require('os');
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
    }
    machines.unshift({
      id: 'local', name: os.hostname(), ip: ips[0] || '127.0.0.1', port: load('settings').nodePort,
      note: '本机（当前服务所在机器）', rack: '', local: true, status: 'online', lastCheck: Date.now(),
    });
    save('machines', machines);
  }
}
initLocalMachine();

function resolveHome(settings) {
  const fs = require('fs');
  const s = settings || load('settings');
  if (s.homeDir) { try { if (fs.existsSync(s.homeDir)) return s.homeDir; } catch (e) {} }
  const looksLikeToolHome = (d) => {
    try { return fs.readdirSync(d).some((n) => /^(hugo|wdckit|SeaChest|HUGO|WDCKIT)/i.test(n)); } catch (e) { return false; }
  };
  const cands = [];
  try {
    for (const u of fs.readdirSync('/home')) cands.push('/home/' + u);
  } catch (e) {}
  if (process.env.SUDO_USER) cands.push('/home/' + process.env.SUDO_USER);
  if (process.env.HOME) cands.push(process.env.HOME);
  cands.push('/root');
  for (const c of cands) if (looksLikeToolHome(c)) return c;
  return process.env.HOME || '/root';
}

module.exports = { DATA, load, save, readJSON, writeJSON, appendJSONL, readJSONL, DEFAULTS, deepMerge, resolveHome };
