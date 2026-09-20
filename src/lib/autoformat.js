'use strict';
/* 插盘自动检测 + 自动格式化：
   周期扫描本机硬盘，发现「新插入」且「有缺陷记录」的盘 → 自动排队格式化。
   规则（与文档 6.4/6.5/7.1 一致）：SAS 看 G-list>0；SATA 看 SMART 05/196/197 任一非 0。
   安全阀：系统盘/已挂载盘不碰；dryRun 打开时只走流程不真格；冷却时间防重复触发。 */
const fs = require('fs');
const path = require('path');
const { load, save, appendJSONL } = require('./store');
const detect = require('./detect');
const rules = require('./rules');

const SEEN_FILE = path.join(__dirname, '..', 'data', 'seen-disks.json');
/* 连续失败计数（2026-09-19）：某块盘反复失败（如 sdl 已 round 149）→ 暂时搁置，
   不再无限重排，避免“找不到设备/无响应”的盘把队列和工具会话吃死。 */
const FAILS_FILE = path.join(__dirname, '..', 'data', 'autoformat-fails.json');
function loadFails() {
  try { return JSON.parse(fs.readFileSync(FAILS_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveFails(o) {
  try { fs.writeFileSync(FAILS_FILE, JSON.stringify(o, null, 2)); } catch (e) {}
}
/* 盘无响应检测：NOT READY 且不是“format in progress” → 根本格不动 */
function probeReady(dev) {
  if (!dev || !String(dev).startsWith('/dev/')) return { ready: true };
  try {
    const out = require('child_process').execFileSync('bash', ['-lc', 'sg_turs -v ' + rules.shq(String(dev)) + ' 2>&1 || true'], { encoding: 'utf8', timeout: 8000 });
    const txt = String(out);
    const notReady = /not ready/i.test(txt);
    const formatting = /format in progress/i.test(txt);
    const noResp = /does not respond to selection|INQUIRY failed/i.test(txt);
    if (noResp && !formatting) return { ready: false, reason: '设备无响应（检查供电/背板/线缆，需断电重启）' };
    if (notReady && !formatting) return { ready: false, reason: '设备未就绪（NOT READY）' };
    return { ready: true, formatting };
  } catch (e) { return { ready: true }; }
}

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveSeen(o) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(o, null, 2)); } catch (e) {}
}

let timer = null;
let busy = false;
const recent = new Map();   // serial -> ts（最近自动格过，冷却用）
const lastLog = new Map();  // serial|reason -> ts（避免每轮刷屏）
let presentSet = null;      // 上一轮在场的盘（序列号集合）：服务启动后新增的就是“新插入”（含拔了再插回）
function isNewlyPlugged(sn) {
  if (!presentSet) return false;   // 启动第一轮：只记录不触发
  return !presentSet.has(sn);
}

function logThrottled(kind, sn, reasonKey, obj, ms) {
  const k = sn + '|' + reasonKey;
  const now = Date.now();
  if (now - (lastLog.get(k) || 0) < (ms || 1800000)) return;
  lastLog.set(k, now);
  appendJSONL('audit.jsonl', Object.assign({ at: now, kind, serial: sn }, obj));
}

/* 用户 2026-09-17 明确规则：只要检测到「有缺陷」就自动格式化。
   触发点：定时扫描、手动刷新硬盘、插盘、格完再检测 —— 全部走这里。 */
async function tick(exec) {
  const st = load('settings');
  const cfg = st.autoFormat || {};
  if (!cfg.enabled || busy) return;
  if (cfg.paused) return;
  busy = true;
  try {
    const r = await detect.scan();
    const seen = loadSeen();
    const ov = load('overrides') || {};      // 人工修正是最高优先级（用户 2026-09-17：手动设了“有缺陷”就必须自动格）
    const now = Date.now();
    const curSet = new Set();
    for (const d of r.disks) { const s0 = d.serial || d.device; if (s0) curSet.add(s0); }
    const pending = [];                      // 本轮的待格候选（按工具合批）
    const firstRound = !presentSet;          // 启动后第一轮：只记录不触发（否则重启会把机箱里所有盘都格一遍）
    if (firstRound) presentSet = new Set(curSet);
    for (const d of r.disks) {
      const sn = d.serial || d.device;
      if (!sn) continue;
      const isNew = isNewlyPlugged(sn);
      seen[sn] = seen[sn] || { firstSeen: now, device: d.device };
      const o = ov[sn];
      if (o) {
        if (o.brand) d.brand = o.brand;
        if (o.interfaceType) d.interfaceType = o.interfaceType;
        if (o.defectStatus) d.defectStatusOverride = o.defectStatus;
      }
      if (d.isSystemDisk) { logThrottled('autoformat-skip', sn, 'sys', { device: d.device, reason: '系统盘' }); continue; }
      if (d.isMounted) { logThrottled('autoformat-skip', sn, 'mnt', { device: d.device, reason: '已挂载' }); continue; }

      /* 用户 2026-09-17：新插入的盘先无条件格一遍 512，格完再由续格钩子判定/续格 */
      /* 重新插拔（盘回过一次又插回来）→ 解除搁置，重新纳入 */
      if (isNew && !firstRound) { const fl1 = loadFails(); if (fl1[sn]) { delete fl1[sn]; saveFails(fl1); logThrottled('autoformat-skip', sn, 'hold-clear', { device: d.device, reason: '盘重新插入 → 已解除搁置' }, 60000); } }
      if (isNew && !firstRound && cfg.firstFormat512 !== false) {
        const running = [...exec.jobs.values()].some((j) => (j.devices || []).indexOf(d.device) >= 0 && (j.status === '运行中' || j.status === '排队'));
        if (!running) {
          const cfg512 = { toolId: cfg.toolId || rules.recommendTool(d, st), mode: cfg.mode || undefined, lunSize: 512 };
          const r512 = rules.renderCommand(d, cfg512, st);
          const pf512 = rules.preflight(d, cfg512, st, r512);
          if (r512 && !r512.error && pf512.ok) {
            recent.set(sn, now);
            /* BUGFIX 2026-09-20: 此处原写 pending.push({d, cfgFmt, rendered}) —— cfgFmt 在本函数后面才用 const 声明，
               命中 TDZ，抛 "Cannot access 'cfgFmt' before initialization"，导致整个 tick 中断（自动检测全废、日志刷 1400+ 行）。
               应压入本次 512 首格的 cfg512/r512。 */
            pending.push({ d, cfgFmt: cfg512, rendered: r512 });
            appendJSONL('audit.jsonl', { at: now, kind: 'autoformat-first512', device: d.device, serial: sn, tool: r512.toolId, note: '新盘先格 512 再判定' });
            console.log('[disk-webui] 新插入 ' + d.device + ' → 先格一遍 512，之后再判定缺陷');
            try { exec.newJob(d, cfg512, r512, st); } catch (e) {}
          } else {
            logThrottled('autoformat-skip', sn, 'first512-pf', { device: d.device, reason: '新盘先格 512 预检未过', problems: (pf512 && pf512.problems) || [] });
          }
        }
        continue;
      }

      const ev = rules.evaluateDefect(d, st);
      if (ev.status !== '有') {
        const fl0 = loadFails();
        if (fl0[sn]) { delete fl0[sn]; saveFails(fl0); }   // 已无缺陷 → 清零失败计数
        logThrottled('autoformat-skip', sn, 'nodefect', { device: d.device, reason: '无缺陷记录', defect: ev.status }, 3600000);
        continue;
      }
      /* 连续失败到上限 → 搁置，不再重排（防止 round 149 这种死循环） */
      const fails = loadFails();
      const maxFails = Math.max(1, Number(cfg.maxFails) || 1);   // 用户 2026-09-19：一次不行就先搁置
      if ((Number(fails[sn]) || 0) >= maxFails) {
        logThrottled('autoformat-skip', sn, 'hold', { device: d.device, reason: '连续失败 ' + fails[sn] + ' 次，已搁置（修好后可在设置里清除）' }, 1800000);
        continue;
      }
      /* 盘根本无响应 → 别排任务（但正在格式化/已有任务的盘不能当“无响应”，
         2026-09-19 真机踩坑：格式中的盘 sg_turs 会回 “does not respond”，被误判成硬件故障） */
      const alreadyBusy = [...exec.jobs.values()].some((j) => (j.status === '运行中' || j.status === '排队') && ((j.devices || []).indexOf(d.device) >= 0 || j.serial === sn));
      if (alreadyBusy) continue;
      const pr = probeReady(d.device);
      if (!pr.ready) {
        fails[sn] = (Number(fails[sn]) || 0) + 1;
        saveFails(fails);
        logThrottled('autoformat-skip', sn, 'notready', { device: d.device, reason: pr.reason, fails: fails[sn] }, 600000);
        continue;
      }
      /* BUGFIX 2026-09-20（139 巡检）：盘正在格式化中（sg_turs 回 “format in progress”，
         常见于被人手动/外部启动的格式化）→ 本轮跳过，不再排队。
         否则会每 ~5 分钟排一条 0 秒失败的任务（报 “Device not ready, format in progress”），
         刷屏并吃队列（sdi 曾一晚上白刷 12 条失败）。 */
      if (pr.formatting) {
        logThrottled('autoformat-skip', sn, 'formatting', { device: d.device, reason: '该盘正在格式化（format in progress）→ 本轮跳过' }, 600000);
        continue;
      }
      /* 已标记不再续格 */
      if ((cfg.stopSerials || []).indexOf(sn) >= 0) { logThrottled('autoformat-skip', sn, 'stop', { device: d.device, reason: '该盘已被标记不再自动格' }); continue; }
      /* 这块盘已经在跑 / 已排队 → 不重复下任务 */
      let busyDisk = false;
      for (const j of exec.jobs.values()) {
        if (j.status === '运行中' || j.status === '排队') {
          if (j.serial === sn || (j.devices || []).indexOf(d.device) >= 0 || j.device === d.device) { busyDisk = true; break; }
        }
      }
      if (busyDisk) continue;
      /* 冷却（防止格完立刻又格同一块，符合 cooldownSec 设置） */
      const last = recent.get(sn) || 0;
      if (now - last < (Number(cfg.cooldownSec) || 300) * 1000) continue;

      const cfgFmt = {
        toolId: cfg.toolId || rules.recommendTool(d, st),
        mode: cfg.mode || undefined,
        lunSize: Number(cfg.lunSize) || Number(st.defaultLunSize) || 512,
      };
      const rendered = rules.renderCommand(d, cfgFmt, st);
      const pf = rules.preflight(d, cfgFmt, st, rendered);
      if (!rendered || rendered.error || !pf.ok) {
        logThrottled('autoformat-skip', sn, 'preflight', { device: d.device, reason: '预检未通过', problems: pf.problems });
        continue;
      }
      recent.set(sn, now);
      pending.push({ d, cfgFmt, rendered });
      const fails2 = loadFails();
      if (fails2[sn]) { delete fails2[sn]; saveFails(fails2); }
      appendJSONL('audit.jsonl', { at: now, kind: 'autoformat-queue', device: d.device, serial: sn, defect: ev.status, tool: rendered.toolId, lunSize: cfgFmt.lunSize });
    }
    /* 同一工具的多块盘 → 合成一条命令（hugo: format -s A -s B；wdckit: --serial A --serial B），
       2026-09-19 用户要求：这才是真并行。（sg_format 无多盘参数，退化为一条命令串行循环） */
    const byTool = new Map();
    for (const x of pending) {
      const tid = rules.batchKey(x.d, st);
      if (!byTool.has(tid)) byTool.set(tid, []);
      byTool.get(tid).push(x);
    }
    for (const [tid, arr] of byTool) {
      try {
        /* 用户 2026-09-19：同一批（同工具）要等整批格完再开下一批；
           新插入的盘（日立/西数）等这批格完再入下一批 → 有在跑/排队的同工具任务就本轮不排。 */
        const runningSame = [...exec.jobs.values()].some((j) => (j.status === '运行中' || j.status === '排队') && (j.toolId === tid || (j.toolId && rules.batchKey({ brand: (j.brand || ''), interfaceType: (j.interfaceType || '') }, st) === tid)));
        if (runningSame) {
          logThrottled('autoformat-skip', String(tid), 'batch-wait', { reason: '该工具本批还在格 → 等整批完成后再开下一批', devices: arr.map((x) => x.d.device) }, 600000);
          continue;
        }
        /* allDisks：把本机全盘列表传进去，好让 rules 判断「-m 型号会不会误伤不在本批的盘」
           （2026-09-20 测试 bug：sdd 单盘有缺陷，-m 却把 sdd/sdh/sdk 三块同型号盘全格了） */
        const group = rules.renderToolGroup(arr.map((x) => x.d), { toolId: tid, mode: arr[0].cfgFmt.mode, lunSize: arr[0].cfgFmt.lunSize, allDisks: r.disks }, st);
        if (group) group.cfgToolId = arr[0].cfgFmt.toolId;
        if (!group || !group.devices || !group.command) continue;
        const first = arr[0];
        const extra = arr.length > 1 ? { devices: group.devices.map((x) => x.device), label: '多盘(' + arr.length + '块)' } : undefined;
        appendJSONL('audit.jsonl', { at: now, kind: 'autoformat-start', tool: tid, count: arr.length, devices: group.devices.map((x) => x.device), command: group.command });
        exec.newJob(first.d, first.cfgFmt, group, st, extra);
      } catch (e) { console.error('[disk-webui] 合批执行失败:', e.message); }
    }
    saveSeen(seen);
    presentSet = curSet;                    // 本轮结束：更新“在场盘”集合
  } catch (e) {
    console.error('[disk-webui] 自动检测出错:', e.message);
  } finally { busy = false; }
}

/* 手动刷新 / 插盘 / 格完后立刻补一刀（延后几秒等状态稳定） */
function tickSoon(exec, delayMs) {
  setTimeout(() => { tick(exec).catch(() => {}); }, Number(delayMs) || 1500);
}

function start(exec) {
  const st = load('settings');
  const sec = Math.max(15, Number((st.autoFormat || {}).intervalSec) || 60);
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick(exec), sec * 1000);
  if (timer.unref) timer.unref();
  /* 先把现有盘记为“已见”，避免服务启动瞬间把已有盘当成新插入的盘 */
  try {
    const seen = loadSeen();
    let changed = false;
    detect.scan().then((r) => {
      for (const d of r.disks) { const sn = d.serial || d.device; if (sn && !seen[sn]) { seen[sn] = { firstSeen: Date.now(), device: d.device, existing: true }; changed = true; } }
      if (changed) saveSeen(seen);
    }).catch(() => {});
  } catch (e) {}
}

module.exports = { start, tick, tickSoon, loadSeen, saveSeen };
