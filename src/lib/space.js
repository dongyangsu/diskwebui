'use strict';
/* 磁盘空间保护：根分区剩余低于阈值时，禁止再开新格式化任务（防止日志/输出把盘写满导致服务挂掉） */
const fs = require('fs');

function space(dir) {
  try {
    const st = fs.statfsSync(dir || '/');
    const bsize = st.bsize || st.frsize || 4096;
    const total = Number(st.blocks) * bsize;
    const free = Number(st.bavail) * bsize;
    return {
      path: dir || '/',
      totalMB: Math.round(total / 1048576),
      freeMB: Math.round(free / 1048576),
      freePct: total ? Number(((free / total) * 100).toFixed(1)) : 0,
    };
  } catch (e) {
    return { path: dir || '/', totalMB: 0, freeMB: 0, freePct: 100, error: e.message };
  }
}

function limits(settings) {
  const p = (settings && settings.protect) || {};
  const pct = Number(p.minFreePct);
  const mb = Number(p.minFreeMB);
  return {
    minFreePct: Number.isFinite(pct) ? pct : 5,
    minFreeMB: Number.isFinite(mb) ? mb : 2048,
  };
}

/* ok=false 时禁止开新任务；reason 可直接展示给用户 */
function guard(settings, dir) {
  const s = space(dir);
  const L = limits(settings);
  const ok = s.freePct >= L.minFreePct && s.freeMB >= L.minFreeMB;
  return Object.assign({ ok }, s, L, {
    reason: ok ? '' : `磁盘空间不足（剩余 ${s.freePct}% / ${s.freeMB}MB，低于阈值 ${L.minFreePct}% / ${L.minFreeMB}MB）→ 已暂停新格式化任务`,
  });
}

/* 多个关键目录一起看：根分区 / 家目录（工具与日志） / 标签目录 —— 取最紧的那个 */
function guardAll(settings) {
  const home = (settings && settings.homeDir) || process.env.HOME || '/root';
  const dirs = ['/', home];
  if (settings && settings.labelDir) dirs.push(settings.labelDir);
  const seen = new Set();
  let worst = null;
  for (const d of dirs) {
    let real = d;
    try { real = require('fs').realpathSync(d); } catch (e) { continue; }
    const s = space(real);
    if (seen.has(s.totalMB + ':' + s.freeMB)) continue;
    seen.add(s.totalMB + ':' + s.freeMB);
    const L = limits(settings);
    const ok = s.freePct >= L.minFreePct && s.freeMB >= L.minFreeMB;
    const cand = Object.assign({ ok }, s, L, { path: real, reason: ok ? '' : `磁盘空间不足（${real} 剩余 ${s.freePct}% / ${s.freeMB}MB，低于阈值 ${L.minFreePct}% / ${L.minFreeMB}MB）→ 已暂停新任务` });
    if (!worst || cand.freePct < worst.freePct) worst = cand;
  }
  return worst || Object.assign({ ok: true }, space('/'), limits(settings), { reason: '' });
}

module.exports = { space, guard, guardAll, limits };
