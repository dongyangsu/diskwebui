'use strict';
/* 定时清理：wdckit.txt / wdckit-trace.txt 这类工具日志会长到几十 G，需要定期清掉。
   默认用「清空(truncate)」而不是删除 —— 工具还在写该文件时，truncate 能立刻释放空间且不破坏工具句柄；
   也可切换为 delete。 */
const fs = require('fs');
const path = require('path');

function expand(p, home) {
  return String(p || '').replace(/^~(?=\/|$)/, home);
}

/* 列出命中的文件（支持 * 通配，仅在指定目录顶层匹配） */
function scan(settings) {
  const home = settings.homeDir || process.env.HOME || '/root';
  const cfg = settings.clean || {};
  const patterns = (cfg.patterns && cfg.patterns.length) ? cfg.patterns : ['wdckit.txt', 'wdckit-trace.txt'];
  const dirs = (cfg.dirs && cfg.dirs.length) ? cfg.dirs : [home];
  const out = [];
  for (const d0 of dirs) {
    const d = expand(d0, home);
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    for (const pat of patterns) {
      const re = new RegExp('^' + String(pat).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      for (const n of names) {
        if (!re.test(n)) continue;
        const full = path.join(d, n);
        let st = null;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (!st.isFile()) continue;
        if (out.some((x) => x.path === full)) continue;
        out.push({ path: full, size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/* 系统日志（kern.log / syslog 这类会长到几十 G）：超过上限就截断（默认 512MB） */
const SYS_LOGS_DEFAULT = ['/var/log/kern.log', '/var/log/kern.log.1', '/var/log/syslog', '/var/log/syslog.1', '/var/log/messages'];
function runSystemLogs(settings) {
  const cfg = settings.clean || {};
  if (cfg.systemLogs === false) return { files: [], freed: 0, errors: [], skipped: true };
  const list = Array.isArray(cfg.systemLogs) && cfg.systemLogs.length ? cfg.systemLogs : SYS_LOGS_DEFAULT;
  const maxBytes = (Number(cfg.sysLogMaxMB) > 0 ? Number(cfg.sysLogMaxMB) : 512) * 1048576;
  const done = [], errors = [];
  let freed = 0;
  for (const p of list) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size <= maxBytes) continue;
      const fd = fs.openSync(p, 'r+');
      fs.ftruncateSync(fd, 0);
      fs.closeSync(fd);
      freed += st.size;
      done.push({ path: p, size: st.size, mode: 'truncate-syslog' });
    } catch (e) {
      if (e && e.code !== 'ENOENT') errors.push({ path: p, error: String(e.message || e) });
    }
  }
  return { files: done, freed, errors };
}

/* 执行清理，返回 { files, freed, errors } */
function run(settings) {
  const cfg = settings.clean || {};
  const mode = cfg.mode === 'delete' ? 'delete' : 'truncate';
  const files = scan(settings);
  let freed = 0;
  const errors = [];
  const done = [];
  for (const f of files) {
    if (f.size < (Number(cfg.minSizeKB) || 0) * 1024) continue;   // 小于阈值的跳过（默认 0 = 全清）
    try {
      if (mode === 'delete') {
        fs.unlinkSync(f.path);
      } else {
        const fd = fs.openSync(f.path, 'r+');
        fs.ftruncateSync(fd, 0);
        fs.closeSync(fd);
      }
      freed += f.size;
      done.push({ path: f.path, size: f.size, mode });
    } catch (e) {
      errors.push({ path: f.path, error: String(e.message || e) });
    }
  }
  return { mode, files: done, freed, errors, at: Date.now() };
}

/* 一次完整清理：工具日志 + 系统日志 */
function runAll(settings) {
  const a = run(settings);
  const b = runSystemLogs(settings);
  return { mode: a.mode, files: a.files.concat(b.files), freed: a.freed + b.freed, errors: a.errors.concat(b.errors), at: Date.now() };
}

module.exports = { scan, run, runAll, runSystemLogs, expand };
