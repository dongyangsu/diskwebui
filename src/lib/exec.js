'use strict';
/* 命令执行：终端会话（多开/多标签）+ 格式化任务（进度推送） */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { load, save, appendJSONL, resolveHome } = require('./store');
const rules = require('./rules');
const spaceGuard = require('./space');

/* ---------- 基础：任务日志目录 / 脱离 webui 服务 cgroup / 文件尾部跟踪 ---------- */
const JOB_LOG_DIR = process.env.DW_JOB_LOG_DIR || '/var/log/diskwebui/jobs';
const JOB_LOG_MAX_BYTES = Math.max(1, Number(process.env.DW_JOB_LOG_MAX_MB) || 50) * 1024 * 1024;
const JOB_LOG_FALLBACK = path.join(__dirname, '..', 'data', 'jobs');
let _jobLogDir = null;
/* 日志目录：优先 /var/log/diskwebui/jobs（服务通常 root 跑），不可写就回退到 data/jobs */
function jobLogDir() {
  if (_jobLogDir) return _jobLogDir;
  for (const d of [JOB_LOG_DIR, JOB_LOG_FALLBACK]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const probe = path.join(d, '.write-test');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      _jobLogDir = d;
      return d;
    } catch (e) {}
  }
  _jobLogDir = JOB_LOG_FALLBACK;
  return _jobLogDir;
}
/* 把子进程移出 diskwebui.service 的 cgroup：
   否则 systemctl restart/stop 时 KillMode=control-group 会把它一起杀掉（2026-09-17 踩过坑） */
/* 进程树里所有 pid（含自身），用 pstree 拿 */
function procTreePids(pid) {
  if (!pid) return [];
  try {
    const out = require('child_process').execFileSync('bash', ['-lc', 'pstree -p ' + Number(pid) + ' 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000 });
    const arr = (String(out).match(/\((\d+)\)/g) || []).map((x) => Number(x.replace(/[()]/g, '')));
    return arr.filter((n) => n && n !== Number(pid));
  } catch (e) { return []; }
}
function moveOutOfServiceCgroup(pid) {
  if (!pid) return false;
  try {
    const dst = '/sys/fs/cgroup/system.slice/diskwebui-jobs.scope';
    fs.mkdirSync(dst, { recursive: true });
    /* 2026-09-20 修复（139 真机测试抓到）：cgroup v2 的进程迁移只影响「单个进程」，
       之前只写了 bash 外壳的 pid → 它后 spawn 的 script/sudo/hugo 仍留在 diskwebui.service 里，
       重启服务时被 KillMode=control-group 一起杀掉（日志却写“重启不会杀掉它”，名不副实）。
       → 把整棵进程树都移出去，并隔几次补移（子进程是陆续 fork 出来的，一次移不全）。 */
    const moveAll = () => {
      const pids = [Number(pid)].concat(procTreePids(pid));
      for (const p of pids) { try { fs.writeFileSync(path.join(dst, 'cgroup.procs'), String(p)); } catch (e) {} }
    };
    moveAll();
    for (const ms of [400, 1500, 4000]) { const t = setTimeout(moveAll, ms); if (t.unref) t.unref(); }
    return true;
  } catch (e) { return false; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/* 2026-09-20 修复（139 巡检发现）：超时/设备消失时只 `child.kill()` 杀不掉真正的 hugo/wdckit。
   根因：命令被 `printf Y | script -qfc <cmd> /dev/null` 套了一层，child 是 script/bash，
   真工具是它的子孙（且 detached 时自成进程组）→ 只杀外层 → “界面判失败/超时，盘其实还在格”。
   这里按「进程组 + pstree 递归子孙」一起杀，保证真工具被终止。 */
function killProcTree(pid, child, sig) {
  const s = sig || 'SIGTERM';
  let kids = [];
  if (pid) {
    /* detached 的子进程自成进程组：先整组杀（连 sudo 带工具） */
    try { process.kill(-pid, s); } catch (e) {}
    /* 非 detached（单次调用 fd=null）时不是组长 → 用 pstree 找出所有子孙逐个杀 */
    try {
      const out = require('child_process').execFileSync('bash', ['-lc', 'pstree -p ' + Number(pid) + ' 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000 });
      kids = (String(out).match(/\((\d+)\)/g) || []).map((x) => Number(x.replace(/[()]/g, '')));
    } catch (e) {}
    for (const k of kids) { try { process.kill(k, s); } catch (e) {} }
    try { process.kill(Number(pid), s); } catch (e) {}
  }
  if (child) { try { child.kill(s); } catch (e) {} }
  return kids;
}
/* 跟踪日志文件新增内容（按行回调） */
function tailFile(file, onLine) {
  let pos = 0, carry = '';
  const st = { timer: null };
  try { pos = fs.statSync(file).size; } catch (e) { pos = 0; }
  let lastCap = 0;
  st.timer = setInterval(() => {
    let buf = '';
    try {
      const size = fs.statSync(file).size;
      /* 日志上限（默认 50MB）：超了就截断（truncate）。
         子进程的 fd 是 O_APPEND，截断后它的后续输出会从新末尾继续写 → 不会留空洞。 */
      const nowTs = Date.now();
      if (size > JOB_LOG_MAX_BYTES && nowTs - lastCap > 30000) {
        lastCap = nowTs;
        try { fs.truncateSync(file, 0); pos = 0; carry = ''; return; } catch (e) {}
      }
      if (size > pos) {
        const fd = fs.openSync(file, 'r');
        const len = Math.min(size - pos, 512 * 1024);
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, pos);
        fs.closeSync(fd);
        buf = b.toString('utf8');
        pos += len;
      } else if (size < pos) { pos = size; }   // 文件被清空/重建
    } catch (e) { return; }
    if (!buf) return;
    const parts = (carry + buf).split(/\r?\n/);
    carry = parts.pop();
    for (const ln of parts) if (ln.trim()) onLine(ln);
  }, 1500);
  if (st.timer.unref) st.timer.unref();
  return st;
}
/* 扫描任务/会话日志目录，超限的文件统统截断（防止再发生 “日志写满根分区” 事故） */
function sweepJobLogs(maxBytes) {
  const limit = Number(maxBytes) || JOB_LOG_MAX_BYTES;
  let freed = 0, n = 0;
  try {
    const dir = jobLogDir();
    /* ① 保留个数：超出就删最旧的（任务日志文件数不能无限长） */
    try {
      const stt = load('settings');
      const keep = Math.max(10, Number((stt.clean || {}).jobLogKeep) || 80);
      const files = fs.readdirSync(dir).map((f) => { const p = path.join(dir, f); try { const s = fs.statSync(p); return s.isFile() ? { p, f, m: s.mtimeMs } : null; } catch (e) { return null; } }).filter(Boolean).sort((a, b) => b.m - a.m);
      for (const x of files.slice(keep)) {
        try { freed += fs.statSync(x.p).size; fs.unlinkSync(x.p); n++; } catch (e) {}
      }
    } catch (e) {}
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const stt = fs.statSync(p);
        if (stt.isFile() && stt.size > limit) { fs.truncateSync(p, 0); freed += stt.size; n++; }
      } catch (e) {}
    }
  } catch (e) {}
  return { n, freed };
}

/* 一键停止本机所有在跑/排队的任务 */
function stopAll() {
  let n = 0;
  for (const j of [...jobs.values()]) {
    if (j.status === '运行中' || j.status === '排队') { try { stopJob(j.id); n++; } catch (e) {} }
  }
  for (const [tid, q] of queues.entries()) {
    for (const j of q) { j.status = '已停止'; j.stage = '已停止（全部停止）'; j.endedAt = Date.now(); n++; }
    q.length = 0; queues.set(tid, q);
  }
  saveRegistry();
  appendJSONL('audit.jsonl', { at: Date.now(), kind: 'stop-all', count: n });
  return n;
}

function homeDir() { try { return resolveHome(); } catch (e) { return process.env.HOME || '/'; } }

/* ---------------- 终端会话 ---------------- */
const sessions = new Map();

function newSession(name, forceId) {
  const id = forceId || 't_' + Math.random().toString(36).slice(2, 10);
  const s = { id, name: name || '终端', cwd: homeDir(), history: [], buffer: [], subs: new Set(), running: null, lastExit: null };
  sessions.set(id, s);
  push(s, `\u001b[90m[会话 ${id} 已创建] 工作目录: ${s.cwd}\u001b[0m`);
  return s;
}
/* 关键：必须用调用方给的 id 建会话，否则 SSE 与 exec 会挂在两个不同会话上 */
function getSession(id) {
  if (!id) return newSession();
  return sessions.get(id) || newSession(id, id);
}
function push(s, line) {
  s.buffer.push(line);
  if (s.buffer.length > 2000) s.buffer.splice(0, s.buffer.length - 2000);
  for (const send of s.subs) { try { send(line); } catch (e) {} }
}
/* ---------- 真终端：每个标签页一个常驻 PTY shell ----------
   2026-09-19 用户反馈：“命令行为什么不能像真正的 Linux 那样用”。
   原因：旧实现每条命令都是 temp `bash -lc`，没有 PTY、没有常驻 shell →
   vim/top 跑不了、cd / 环境变量不保留。现改为用 `script` 分配伪终端跑一个常驻交互 bash。 */
function ensureShell(s) {
  if (s.shell && s.shell.ok && s.shell.proc && !s.shell.proc.killed) return s.shell;
  try {
    const p = spawn('script', ['-qfc', '/bin/bash -i', '/dev/null'], {
      cwd: (s.cwd && fs.existsSync(s.cwd)) ? s.cwd : homeDir(),
      env: Object.assign({}, process.env, {
        TERM: 'xterm-256color',
        PS1: '\\[\\e[32m\\]\\u@\\h\\[\\e[0m\\]:\\w\\$ ',
        PROMPT_COMMAND: '',
        HISTCONTROL: 'ignoredups',
      }),
    });
    s.shell = { proc: p, ok: true, carry: '' };
    const onData = (d) => {
      let txt = (s.shell.carry || '') + d.toString();
      /* 解析心跳标记：__DWX__<退出码>|<cwd>__ → 更新会话的 cwd/退出码，不让标记显示出来 */
      txt = txt.replace(/__DWX__([^|]*)\|([^\n]*?)__/g, (m, code, pwd) => {
        s.lastExit = Number(String(code).trim());
        const c = String(pwd).replace(/[\r\n]/g, '').trim();
        if (c) s.cwd = c;
        return '';
      });
      const idx = txt.lastIndexOf('__DWX__');
      if (idx >= 0 && txt.length - idx < 80) { s.shell.carry = txt.slice(idx); txt = txt.slice(0, idx); }
      else s.shell.carry = '';
      if (txt) push(s, txt);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', () => {
      if (s.shell) s.shell.ok = false;
      push(s, '\u001b[90m[shell 已退出，下次执行命令时自动重建]\u001b[0m');
    });
  } catch (e) {
    s.shell = { ok: false, err: e.message };
  }
  return s.shell;
}
function checkPolicy(cmd, settings) {
  const t = settings.terminal;
  const low = cmd.toLowerCase();
  for (const b of t.blacklist || []) if (low.includes(String(b).toLowerCase())) return `命中黑名单规则「${b}」`;
  if (t.whitelist && t.whitelist.length) {
    const ok = t.whitelist.some((w) => cmd.startsWith(w));
    if (!ok) return '不在命令白名单内';
  }
  return null;
}
function execInSession(sessionId, cmd, cwd, opts) {
  const s = getSession(sessionId);
  const settings = load('settings');
  if (cwd) s.cwd = cwd;  const bad = checkPolicy(cmd, settings);
  const echo = `\u001b[36m${s.cwd}$\u001b[0m ${cmd}`;
  push(s, echo);
  if (bad) { push(s, `\u001b[31m[拦截] ${bad}\u001b[0m`); return { sessionId: s.id, blocked: bad }; }
  /* 危险命令二次确认（用户 2026-09-17：其它工具/命令可能的错误也要卡住） */
  const needConfirm = (settings.terminal && settings.terminal.needConfirm) !== false;
  const dangerous = /(^|[^\w])(format|sg_format|SeaChest\w*|wipefs|mkfs\w*|shred|blkdiscard|hdparm)([^\w]|$)|dd\s+[^\n]*of=\/dev\/|of=\/dev\/|>\s*\/dev\//i.test(cmd);
  if (needConfirm && dangerous && !(opts && opts.confirm)) {
    push(s, '\u001b[33m[需二次确认] 该命令会改动/擦除硬盘数据，已拦截；确认后请重发\u001b[0m');
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'terminal-need-confirm', cmd, cwd: s.cwd });
    return { sessionId: s.id, needConfirm: true, command: cmd };
  }
  s.history.unshift({ cmd, at: Date.now(), cwd: s.cwd });
  s.history = s.history.slice(0, 200);

  if (settings.dryRun && /format|SeaChest|sg_format|dd if=\/dev\/zero/.test(cmd)) {
    push(s, '\u001b[33m[dryRun 模式] 未真正执行（设置页可关闭 dryRun）\u001b[0m');
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'terminal-dryrun', cmd, cwd: s.cwd });
    return { sessionId: s.id, dryRun: true };
  }

  /* 优先走常驻 PTY shell（真终端体验）；不可用才回退为单次 bash -lc */
  const sh = ensureShell(s);
  if (sh && sh.ok && sh.proc && sh.proc.stdin && !sh.proc.killed) {
    try {
      sh.proc.stdin.write(cmd + '\n');
      /* 心跳：上报退出码与当前目录；把字面量拆开写，避免回显的输入行被当成标记 */
      sh.proc.stdin.write('echo -n "__DW""X__$?|${PWD}__"\n');
      s.running = sh.proc;
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'terminal', cmd, cwd: s.cwd, shell: true });
      return { sessionId: s.id, shell: true };
    } catch (e) { sh.ok = false; }
  }

  const child = spawn('bash', ['-lc', cmd], { cwd: s.cwd });
  s.running = child;
  /* 终端命令超时保护（settings.terminal.timeoutSec，默认 300s） */
  const tsec = Number((settings.terminal || {}).timeoutSec) || 300;
  const to = setTimeout(() => {
    if (!s.running) return;
    push(s, `\u001b[31m[超时 ${tsec}s] 已强制终止命令\u001b[0m`);
    try { process.kill(-s.running.pid, 'SIGKILL'); } catch (e) { try { s.running.kill('SIGKILL'); } catch (e2) {} }
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'terminal-timeout', cmd, cwd: s.cwd, timeoutSec: tsec });
  }, tsec * 1000);
  if (to.unref) to.unref();
  child.stdout.on('data', (d) => push(s, d.toString()));
  child.stderr.on('data', (d) => push(s, d.toString()));
  child.on('close', (code) => {
    clearTimeout(to);
    s.lastExit = code;
    s.running = null;
    push(s, `\u001b[90m[退出码 ${code}]\u001b[0m`);
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'terminal', cmd, cwd: s.cwd, exit: code });
  });
  return { sessionId: s.id };
}
function stopSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return false;
  /* 常驻 shell：直接送 Ctrl-C，等价于在真终端里按 ^C */
  if (s.shell && s.shell.ok && s.shell.proc && s.shell.proc.stdin) {
    try { s.shell.proc.stdin.write('\u0003'); push(s, '\u001b[33m[已发送 Ctrl-C]\u001b[0m'); return true; } catch (e) {}
  }
  if (!s.running) return false;
  try { process.kill(-s.running.pid, 'SIGTERM'); } catch (e) { try { s.running.kill('SIGTERM'); } catch (e2) {} }
  push(s, '\u001b[33m[已发送中断信号]\u001b[0m');
  return true;
}

/* ---------------- 格式化任务 ---------------- */
let finishHook = null;
function setFinishHook(fn) { finishHook = fn; }
function fireFinish(job) { if (!finishHook) return; try { Promise.resolve(finishHook(job)).catch(() => {}); } catch (e) {} }

const jobs = new Map();
/* 同工具串行：hugo / wdckit 的 CLI 同一时刻只能有一个实例，否则报 "already run"（用户 2026-09-17 反馈） */
const SERIAL_TOOLS = new Set(['hugo', 'wdckit']);
const queues = new Map();   // toolId -> [job,...]
const REGISTRY = () => path.join(__dirname, '..', 'data', 'jobs.json');
function saveRegistry() {
  try {
    const arr = [];
    for (const j of jobs.values()) {
      arr.push({ id: j.id, serial: j.serial, device: j.device, devices: j.devices, toolId: j.toolId, toolName: j.toolName,
        command: j.command, cwd: j.cwd, lunSize: j.lunSize, logPath: j.logPath, pid: j.pid || null,
        status: j.status, stage: j.stage, progress: j.progress, startedAt: j.startedAt, endedAt: j.endedAt, round: j.round });
    }
    fs.writeFileSync(REGISTRY(), JSON.stringify(arr.slice(-100), null, 1));
  } catch (e) {}
}
function loadRegistry() { try { return JSON.parse(fs.readFileSync(REGISTRY(), 'utf8')); } catch (e) { return []; } }

function newJob(disk, cfg, rendered, settings, extra) {
  const id = 'j_' + Math.random().toString(36).slice(2, 10);
  const batch = (extra && extra.devices && extra.devices.length > 1) ? extra.devices : null;
  const job = {
    id, diskId: disk.id, device: batch ? (extra.label || ('多盘(' + batch.length + '块)')) : disk.device,
    devices: batch || [disk.device], isBatch: !!batch,
    serial: disk.serial, brand: disk.brand,
    interfaceType: disk.interfaceType, lunSize: rendered.lunSize, toolId: rendered.toolId,
    toolName: rendered.toolName, mode: rendered.mode, command: rendered.command, cwd: rendered.cwd,
    inToolCommand: rendered.inToolCommand || '',
    status: '运行中', stage: '准备', progress: 0, speed: '', startedAt: Date.now(), endedAt: null,
    log: [], subs: new Set(), child: null, dryRun: !!settings.dryRun, round: Number((extra && extra.round) || 1),
  };
  jobs.set(id, job);
  if (batch) jlog(job, `批量任务：共 ${batch.length} 块盘 → ${batch.join(' ')}`);
  jlog(job, `命令：${rendered.command}`);
  if (rendered.cwd) jlog(job, `工作目录：${rendered.cwd}`);
  appendJSONL('audit.jsonl', {
    at: Date.now(), kind: 'format', jobId: id, device: job.device, devices: job.devices, isBatch: job.isBatch, serial: disk.serial,
    brand: disk.brand, interfaceType: disk.interfaceType, lunSize: rendered.lunSize,
    tool: rendered.toolId, mode: rendered.mode, command: rendered.command, cwd: rendered.cwd,
    dryRun: !!settings.dryRun, override: !!disk.defectStatusOverride,
  });
  /* 命令为空保护：空命令会让 bash 立即退出 0 → 假成功 */
  if (!String(job.command || '').trim()) {
    job.status = '失败';
    job.stage = '命令为空，未启动';
    job.endedAt = Date.now();
    jlog(job, '⛔ 生成的命令为空（工具未匹配/自定义命令为空）→ 拒绝执行');
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-blocked-empty', jobId: id, device: job.device });
    saveRegistry();
    return job;
  }
  /* 磁盘空间保护：根分区/家目录/标签目录任一低于阈值就不再开新任务 */
  const sp = spaceGuard.guardAll(settings);
  if (!sp.ok) {
    job.status = '失败';
    job.stage = '空间不足，未启动';
    job.endedAt = Date.now();
    jlog(job, '⛔ ' + sp.reason);
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-blocked-space', jobId: id, device: job.device, serial: job.serial, freePct: sp.freePct, freeMB: sp.freeMB });
    saveRegistry();
    return job;
  }
  /* 同盘互斥：同一块盘不允许同时存在两个任务（不分工具，防止 hugo/wdckit 同时操作一块盘） */
  for (const j of jobs.values()) {
    if (j.id === job.id) continue;
    if (j.status !== '运行中' && j.status !== '排队') continue;
    const sameDev = (j.devices || []).some((dev) => (job.devices || []).indexOf(dev) >= 0);
    if (sameDev || (j.serial && job.serial && j.serial === job.serial)) {
      job.status = '失败';
      job.stage = '该盘已有任务，已拒绝';
      job.endedAt = Date.now();
      jlog(job, `⛔ 该盘已有任务在跑/排队（${j.device} · ${j.toolName}，状态 ${j.status}）→ 拒绝重复提交`);
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-blocked-dupe', jobId: id, device: job.device, serial: job.serial, existing: j.id });
      saveRegistry();
      return job;
    }
  }
  /* hugo/wdckit 同工具串行（默认关）：开了才排队，不开就是各自独立进程并行、立即执行 */
  const serialize = (settings && settings.serializeTools) === true;
  if (serialize && SERIAL_TOOLS.has(job.toolId)) {
    const running = [...jobs.values()].some((j) => j.id !== id && j.toolId === job.toolId && (j.status === '运行中' || j.status === '排队'));
    if (running) {
      job.status = '排队';
      job.stage = '排队等待同工具任务';
      if (!queues.has(job.toolId)) queues.set(job.toolId, []);
      queues.get(job.toolId).push(job);
      jlog(job, `⏳ ${job.toolName} 同时只能跑一个 → 已排队，等前面的任务结束`);
      saveRegistry();
      return job;
    }
  }
  runJob(job, settings);
  return job;
}
/* 一个任务结束后：开下一个排队的同工具任务 */
function drainQueue(toolId) {
  const q = queues.get(toolId);
  if (!q || !q.length) return;
  const running = [...jobs.values()].some((j) => j.toolId === toolId && j.status === '运行中');
  if (running) return;
  const next = q.shift();
  if (!next) return;
  next.status = '运行中'; next.stage = '准备';
  jlog(next, '▶ 前面的同工具任务已结束，开始执行');
  runJob(next, load('settings'));
}
/* 工具输出里的致命错误（2026-09-19 排查）：wdckit 即使“No devices found / Command Execution Failed”
   也常常返回退出码 0 → 被当成“完成”，接着续格钩子又排下一轮，形成死循环（sdl 已 round 149）。 */
const TOOL_FATAL_RE = /(No devices found|Command Execution Failed|Error code:\s*-\d+)/i;
function toolFatalLine(line) { return TOOL_FATAL_RE.test(String(line || '')); }
/* ---------- 缺陷快照（2026-09-19 用户要求）：每次格式化前查一遍、格完再查一遍，
   把 SMART 05/196/197/198/199（SATA）或 G-list（SAS）显示出来，避免只显示“未知”。 ---------- */
let _detectMod = null;
function detectMod() { if (!_detectMod) _detectMod = require('./detect'); return _detectMod; }
async function readDefects(dev) {
  const empty = { device: dev || '', health: '未知', s05: null, s196: null, s197: null, s198: null, s199: null, gList: null, error: null };
  if (!dev || !String(dev).startsWith('/dev/')) return empty;
  try {
    const o = { device: String(dev) };
    await detectMod().probeDisk(String(dev), o);
    return {
      device: String(dev), health: o.smartHealth || '未知',
      s05: o.smart05 === undefined ? null : o.smart05,
      s196: o.smart196 === undefined ? null : o.smart196,
      s197: o.smart197 === undefined ? null : o.smart197,
      s198: o.smart198 === undefined ? null : o.smart198,
      s199: o.smart199 === undefined ? null : o.smart199,
      gList: o.gList === undefined ? null : o.gList,
      error: o.smartError || null,
    };
  } catch (e) { empty.error = e.message; return empty; }
}
function fmtDefects(tag, d) {
  if (!d) return tag + '：读取失败';
  const v = (x) => (x === null || x === undefined ? '-' : x);
  const g = (d.gList === null || d.gList === undefined) ? '-' : d.gList;
  return `${tag}：健康=${d.health || '未知'}，05=${v(d.s05)} 196=${v(d.s196)} 197=${v(d.s197)} 198=${v(d.s198)} 199=${v(d.s199)}（G-list=${g}）${d.error ? ' ⚠ ' + d.error : ''}`;
}
/* 开始前记录缺陷快照（异步，不阻塞任务启动） */
function captureDefectsBefore(job) {
  const dev = (job.devices || [])[0];
  if (!dev) return;
  readDefects(dev).then((d) => {
    job.defectBefore = d;
    jlog(job, fmtDefects('📋 格式化前缺陷', d));
    jstate(job, {});
  }).catch(() => {});
}
/* 进度解析（2026-09-19 强化）：hugo/wdckit 的进度条带退格与 ANSI 控制符，
   直接找 % 会漏 → 先清掉控制字符再找。 */
function parsePct(line) {
  const s = stripAnsi(String(line || '')).replace(/\u0008+/g, '').replace(/[\u0000-\u0007\u000b-\u001f]/g, ' ');
  const m = s.match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}
/* 记录真实进度：只有真拿到百分比才标记 pctSeen，
   否则界面不再把初始值 2 当“进度”显示（2026-09-19 真机发现 wdckit 全程不给百分比） */
function markPct(job, p) {
  if (p == null) return;
  job.pctSeen = true;
  job.lastProgressAt = Date.now();   /* 发现B修复：记录“最近一次有进展”，供超时判断是否该延长 */
  jstate(job, { progress: Math.min(99, Math.max(2, p)) });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jlog(job, line) {
  job.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  if (job.log.length > 500) job.log.shift();
  for (const send of job.subs) { try { send({ type: 'log', line }); } catch (e) {} }
}
function jstate(job, patch) {
  Object.assign(job, patch);
  for (const send of job.subs) { try { send({ type: 'state', state: pub(job) }); } catch (e) {} }
}
function pub(job) {
  /* 注意：watch / sessionWatch / progressTimer 是 Node 的定时器对象，带循环引用，
     混进 JSON 会让接口 500（2026-09-19 定位到的老 bug）→ 这里一律剔除。 */
  const { subs, child, log, timer, tail, watch, sessionWatch, progressTimer, ...rest } = job;
  const elapsed = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  let etaSec = null;
  const pct = job.pctSeen ? job.progress : (job.endedAt ? job.progress : null);
  if (!job.endedAt && job.pctSeen && job.progress > 2) etaSec = Math.max(0, Math.round(elapsed / job.progress * (100 - job.progress)));
  return Object.assign(rest, { progress: pct, elapsedSec: elapsed, etaSec, logTail: log.slice(-100) });
}

/* 任务收尾：登记结束 + 写格式化历史 + 开下一个排队任务 + 有缺陷续格钩子 */
function finishJob(job, opts) {
  if (!job.endedAt) job.endedAt = Date.now();
  /* 格式化完成后复检缺陷（用户 2026-09-19 要求：前后各查一遍并显示） */
  /* 格式化后处理（2026-09-19 用户要求“格完一定要能完成缺陷检测”）：
     ①等盘重新就绪（刚格完盘可能还在 Not Ready/format in progress）②再查 SMART 缺陷值 ③才真正收尾 */
  if (job.status === '完成' && !job._postChecked) {
    job._postChecked = true;
    job.endedAt = null;                       // 后处理期间仍算运行中
    jstate(job, { status: '运行中', stage: '等待设备就绪（格后收尾）' });
    const dev = (job.devices || [])[0];
    (async () => {
      let last = null;
      const deadline = Date.now() + 4 * 3600 * 1000;   // 最长等 4 小时
      for (;;) {
        const pr = probeFormatProgress(dev);
        if (pr.progress != null && Math.round(pr.progress) > (job.progress || 0)) jstate(job, { progress: Math.min(99, Math.round(pr.progress)) });
        if (!pr.formatting && !pr.notReady) break;       // 已就绪
        if (Date.now() > deadline) { jlog(job, '⚠ 等待设备就绪超时（4h），按当前状态收尾'); break; }
        await sleep(30000);
      }
      jstate(job, { stage: '格后缺陷复检' });
      for (let i = 0; i < 6; i++) {
        last = await readDefects(dev).catch(() => null);
        if (last && (last.health !== '未知' || last.gList !== null || last.s05 !== null || last.s197 !== null)) break;
        await sleep(10000);
      }
      job.defectAfter = last || { device: dev, health: '未知', error: '复检未读到 SMART' };
      jlog(job, fmtDefects('📋 格式化后缺陷', job.defectAfter));
      job.endedAt = Date.now();
      job.status = '完成';
      job.stage = '完成';
      job.progress = 100;
      finishJob(job, Object.assign({}, opts || {}, { _post: true }));
    })().catch(() => finishJob(job, Object.assign({}, opts || {}, { _post: true })));
    return;
  }
  saveRegistry();
  stopProgressPoller(job);
  try { if (job.tail && job.tail.timer) clearInterval(job.tail.timer); } catch (e) {}
  /* 写入格式化历史（供导出 CSV / 留档） */
  try {
    appendJSONL('format-history.jsonl', {
      at: Date.now(), jobId: job.id, device: job.device, devices: job.devices, isBatch: !!job.isBatch,
      serial: job.serial, brand: job.brand, interfaceType: job.interfaceType, toolId: job.toolId, toolName: job.toolName,
      lunSize: job.lunSize, round: job.round || 1, command: job.command, status: job.status, stage: job.stage,
      startedAt: job.startedAt, endedAt: job.endedAt || Date.now(),
      elapsedSec: Math.round(((job.endedAt || Date.now()) - (job.startedAt || Date.now())) / 1000),
      defectBefore: job.defectBefore === undefined ? null : job.defectBefore, defectAfter: job.defectAfter === undefined ? null : job.defectAfter,
      result: /^完成/.test(job.status || '') ? 'success' : (/失败|已停止/.test(job.status || '') ? 'fail' : 'unknown'),
      logPath: job.logPath || null, adopted: !!job.adopted,
    });
  } catch (e) {}
  try {
    const s = getToolSession(job.toolId);
    if (s) { s.lastUsed = Date.now(); s.runningJob = null; scheduleIdleQuit(job.toolId); }
  } catch (e) {}
  drainQueue(job.toolId);
  if (!opts || opts.hook !== false) fireFinish(job);
}

/* ---------- 重启后认领遗留任务 ----------
   服务重启不会杀掉已脱离的任务（detached + 移出 cgroup + 日志落盘），
   启动时把还活着的任务重新接管，继续报进度；已经没了的标成结束。 */
function adoptJobs(settings) {
  const list = loadRegistry();
  const adopted = [];
  for (const r of list) {
    if (!r || r.status !== '运行中' || !r.id) continue;
    if (jobs.has(r.id)) continue;
    const alive = r.pid ? pidAlive(r.pid) : false;
    const job = {
      id: r.id, diskId: r.serial || r.device, device: r.device, devices: r.devices || [r.device], isBatch: !!r.isBatch,
      serial: r.serial, brand: r.brand, interfaceType: r.interfaceType, lunSize: r.lunSize, toolId: r.toolId, toolName: r.toolName,
      mode: '', command: r.command, cwd: r.cwd, status: alive ? '运行中' : '已结束', stage: alive ? '重启前启动，已认领' : '已结束（重启前）',
      progress: r.progress || 0, speed: '', startedAt: r.startedAt || Date.now(), endedAt: alive ? null : Date.now(),
      log: [], subs: new Set(), child: null, dryRun: false, round: r.round || 1, pid: r.pid || null, logPath: r.logPath || null,
      adopted: true,
    };
    jobs.set(job.id, job);
    if (!alive) {
      jlog(job, '（该任务在服务重启前已结束，未接管运行）');
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'job-adopt-dead', jobId: job.id, device: job.device, pid: job.pid });
      finishJob(job);
      continue;
    }
    jlog(job, '（本任务在服务重启前启动，现已自动接管：继续跟踪日志与进度）');
    /* 继续跟踪日志文件 */
    if (job.logPath && fs.existsSync(job.logPath)) {
      const onLine = (line) => {
        jlog(job, String(line).slice(0, 500));
        markPct(job, parsePct(line));
      };
      job.tail = tailFile(job.logPath, onLine);
      try { job.log = fs.readFileSync(job.logPath, 'utf8').split(/\r?\n/).slice(-120); } catch (e) {}
    }
    /* 轮询进程存活；结束时根据日志尾部判断成功/失败 */
    job.watch = setInterval(() => {
      if (job.endedAt) { clearInterval(job.watch); return; }
      if (pidAlive(job.pid)) return;
      clearInterval(job.watch);
      const tail = (job.log || []).slice(-25).join('\n');
      const okRe = /(successfully|completed|format(ting)? (is )?complete|已完成|success|100\s*%)/i;
      const badRe = /(error|failed|already run|abort|denied|invalid)/i;
      const alreadyRun = /already run/i.test(tail);
      /* “already run” 往往是瞬时的（另一个实例刚在收尾）→ 自动稍后重试一次 */
      if (alreadyRun && (load('settings').retryAlreadyRun !== false)) {
        job._retries = (job._retries || 0) + 1;
        if (job._retries > 240) { jlog(job, '✖ 等待工具空闲超过 4 小时，放弃'); }
        else {
          jlog(job, '⏳ 工具单实例：已有同工具在跑，60 秒后重试（第 ' + job._retries + ' 次）');
          job.status = '运行中'; job.stage = '等待工具空闲（工具单实例限制）'; job.endedAt = null;
          setTimeout(() => {
            if (job.endedAt) return;
            job.stage = '重试中';
            runJob(job, load('settings'));
          }, 60000);
          return;
        }
      }
      let st = '完成', tailTxt = '✔ 完成（重启前启动，按日志判定）';
      if (badRe.test(tail) && !okRe.test(tail)) { st = '失败'; tailTxt = '✖ 失败（重启前启动，日志里出现错误）'; }
      jstate(job, { status: st, stage: st, progress: st === '完成' ? 100 : job.progress, endedAt: Date.now() });
      jlog(job, tailTxt + '（进程已退出）');
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'job-adopt-done', jobId: job.id, device: job.device, result: st });
      finishJob(job);
    }, 5000);
    if (job.watch.unref) job.watch.unref();
    adopted.push({ jobId: job.id, device: job.device, pid: job.pid });
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'job-adopt', jobId: job.id, device: job.device, pid: job.pid });
  }
  return adopted;
}
function runJob(job, settings) {
  const stages = ['准备', '卸载', '调用工具', '格式化', '校验', '完成'];
  const home = (settings && settings.homeDir) || process.env.HOME || '/root';

  if (job.dryRun) {
    jlog(job, '⚠️ dryRun 模式：只做流程演示，不真正执行命令');
    let i = 0;
    job.timer = setInterval(() => {
      if (i < stages.length - 1) {
        i++;
        jstate(job, { stage: stages[i], progress: Math.min(99, Math.round((i / (stages.length - 1)) * 100)), speed: (120 + Math.round(Math.random() * 80)) + ' MB/s' });
        jlog(job, `阶段：${stages[i]}`);
        if (i === 3) jlog(job, '写入中（逻辑块大小 ' + job.lunSize + 'B）…');
      } else {
        clearInterval(job.timer);
        jstate(job, { status: '完成', stage: '完成', progress: 100, speed: '', endedAt: Date.now() });
        jlog(job, '✔ 完成（dryRun）');
        appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-done', jobId: job.id, device: job.device, result: 'success', dryRun: true });
        finishJob(job);
      }
    }, 1200);
    return;
  }

  /* 常驻工具会话模式（hugo / wdckit）：仅当设置里显式打开 toolSession.forFormat 才用。
     2026-09-19 用户明确：**不要排队**，必须“随时立即格” → 默认每个任务各自独立进程、并行立即执行。 */
  const sessCfg = (settings && settings.toolSession) || {};
  if (SERIAL_TOOLS.has(job.toolId) && job.inToolCommand && sessCfg.enabled === true && sessCfg.forFormat === true) {
    runJobInSession(job, settings);
    return;
  }

  /* 单次调用：输出写文件 + detached + 移出服务 cgroup（服务重启不会杀掉任务） */
  const cwd = job.cwd ? path.resolve(job.cwd.replace(/^~/, home)) : undefined;
  jstate(job, { stage: '调用工具', progress: 2 });
  captureDefectsBefore(job);   // 格式化前缺陷快照（SMART 05~199 / SAS G-list）
  jlog(job, `执行：${job.command}`);
  let child, logPath = null, fd = null;
  try { logPath = path.join(jobLogDir(), job.id + '.log'); fd = fs.openSync(logPath, 'a'); } catch (e) { fd = null; logPath = null; }
  const opts = { cwd, detached: !!fd };
  /* hugo/wdckit 会问 “Are you sure … (Y/N)”，而且需要终端才能画进度条：
     2026-09-19 实测：不套 PTY 时输出 “Error opening terminal: unknown.” 直接失败。
     → 单次调用也用 `script` 包一层伪终端：既能真并行、又能回 Y、又有进度条。 */
  const needYes = job.toolId === 'hugo' || job.toolId === 'wdckit';
  /* 确认回 Y 用管道喂进去：`printf 'Y\n' | script -qfc <cmd> /dev/null`。
     2026-09-19 真机踩坑：之前用 node 的 stdin 管道，服务一重启就把管道关了 → 正在格的 hugo 直接死掉。
     改成用 printf 喂完就 EOF，与 node 无关，重启不掉。 */
  const shellCmd = needYes
    ? "printf 'Y\\n' | script -qfc " + rules.shq(job.command) + ' /dev/null'
    : job.command;
  if (needYes) opts.env = Object.assign({}, process.env, { TERM: 'xterm' });
  if (fd !== null) opts.stdio = ['ignore', fd, fd];
  try {
    child = spawn('bash', ['-lc', shellCmd], opts);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
    jstate(job, { status: '失败', stage: '失败', endedAt: Date.now() });
    jlog(job, '✖ 启动失败：' + e.message);
    finishJob(job);
    return;
  }
  if (needYes && child.stdin && !opts.stdio) {
    job.answerYes = () => { try { child.stdin.write('Y\n'); jlog(job, '⏎ 检测到确认提示（Y/N）→ 已自动回 Y'); } catch (e) {} };
  }
  if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} try { child.unref(); } catch (e) {} }
  job.child = child; job.pid = child.pid || null; job.logPath = logPath;
  if (job.pid && fd !== null && moveOutOfServiceCgroup(job.pid)) jlog(job, '（任务已脱离 webui 服务进程组：重启服务不会杀掉它）');
  saveRegistry();

  const onLine = (line) => {
    jlog(job, String(line).slice(0, 500));
    if (toolFatalLine(line)) job.toolFatal = String(line).trim();
    if (job.answerYes && /\(\s*Y\s*\/\s*N\s*\)|Are you sure/i.test(String(line))) job.answerYes();
    markPct(job, parsePct(line));
  };
  if (fd === null) {
    const onData = (d) => String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) onLine(l); });
    child.stdout.on('data', onData); child.stderr.on('data', onData);
  } else {
    job.tail = tailFile(logPath, onLine);
    if (child.stdout) child.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) onLine(l); }));
  }

  /* 拔盘/设备消失检测（第十一章） */
  const watchdog = setInterval(() => {
    if (job.endedAt) return;
    if (job.devices && job.devices.length) {
      const gone = job.devices.find((p) => p && p.startsWith('/dev/') && !fs.existsSync(p));
      if (gone) {
        jlog(job, '⚠️ 设备已移除：' + gone + '，立即停止任务');
        killProcTree(job.pid, child, 'SIGTERM');
        {
          const t = setTimeout(() => { if (job.pid && pidAlive(job.pid)) killProcTree(job.pid, null, 'SIGKILL'); }, 3000);
          if (t.unref) t.unref();
        }
        jstate(job, { status: '失败', stage: '设备已移除', endedAt: Date.now() });
        appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, result: 'device-removed' });
        clearInterval(watchdog);
        finishJob(job);
      }
    }
  }, 4000);
  /* 超时（第十一章）—— 2026-09-20 改为“可延长”：到点先确认盘是否真还在格式化 */
  const timeoutSec = Number(settings.cmdTimeoutSec) || 3600;
  let deadline = Date.now() + timeoutSec * 1000;
  const timeout = setInterval(() => {
    if (job.endedAt) { clearInterval(timeout); return; }
    if (Date.now() < deadline) return;
    if (shouldExtendJobTimeout(job, Date.now())) {
      job._extended = (job._extended || 0) + 1;
      deadline = Date.now() + timeoutSec * 1000;
      jlog(job, `⏳ 已超过设定超时 ${timeoutSec}s，但检测到格式化仍在进行 → 自动延长 ${timeoutSec}s（第 ${job._extended} 次）`);
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-timeout-extend', jobId: job.id, device: job.device, times: job._extended });
      return;
    }
    jlog(job, `⚠️ 超过设定超时 ${timeoutSec}s 且无进展，强制结束`);
    killProcTree(job.pid, child, 'SIGKILL');
    jstate(job, { status: '失败', stage: '超时', endedAt: Date.now() });
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, result: 'timeout' });
    finishJob(job);
  }, 30000);
  if (timeout.unref) timeout.unref();

  child.on('close', (code) => {
    clearInterval(watchdog); clearInterval(timeout);
    stopProgressPoller(job);
    if (job.endedAt) return;
    if (code === 0 && job.toolFatal) {
      jstate(job, { status: '失败', stage: '工具报错（找不到设备/执行失败）', endedAt: Date.now() });
      jlog(job, '✖ 工具报告致命错误（退出码虽为 0）：' + job.toolFatal);
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, serial: job.serial, result: 'tool-fatal-output', fatal: job.toolFatal });
      finishJob(job);
      return;
    }
    /* 2026-09-20 修复（.134 真机抓到）：hugo/wdckit 是单实例工具，机器上已有同类在跑时
       新进程会立刻打印 “HUGO is already running.” 并以退出码 0 结束。
       原来：退出码 0 一律判「完成」→ 触发续格钩子 → 复检仍"有缺陷" → 立刻再排一轮 →
       形成 12 秒一轮的“假完成”死循环（.134 上 sdb/K1GEY091 一分钟内续到第 20 轮），
       而且每轮都调 getDisks(true) 全盘扫描，把服务端拖住 → 前端页面卡死。
       现在：识别到 already run(ning) → 不判完成（不进续格）→ 按设置等 60 秒重试；不重试则判失败。 */
    if (code === 0) {
      const tailNow = (job.log || []).slice(-25).join('\n');
      if (/already run/i.test(tailNow)) {
        const retryAr = (load('settings').retryAlreadyRun !== false);
        job._retries = (job._retries || 0) + 1;
        if (retryAr && job._retries <= 240) {
          jstate(job, { status: '运行中', stage: '等待工具空闲（工具单实例限制）', endedAt: null });
          jlog(job, '⏳ 工具单实例：已有同一个工具在跑 → 60 秒后重试（第 ' + job._retries + ' 次）');
          appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-retry-already-run', jobId: job.id, device: job.device, serial: job.serial, attempt: job._retries });
          const t = setTimeout(() => { if (!job.endedAt) { jstate(job, { status: '运行中', stage: '重试中' }); runJob(job, load('settings')); } }, 60000);
          if (t.unref) t.unref();
          return;
        }
        jstate(job, { status: '失败', stage: '失败（工具已在运行）', endedAt: Date.now() });
        jlog(job, '✖ 工具报 “already running”：机器上已有同一个工具在跑（不算完成，不续格）');
        appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, serial: job.serial, result: 'already-run' });
        finishJob(job);
        return;
      }
      jstate(job, { stage: '校验', progress: 95 });
      jlog(job, '调具完成，校验中…');
      setTimeout(() => {
        jstate(job, { status: '完成', stage: '完成', progress: 100, endedAt: Date.now() });
        jlog(job, '✔ 完成');
        appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-done', jobId: job.id, device: job.device, result: 'success' });
        finishJob(job);
      }, 800);
    } else {
      jstate(job, { status: '失败', stage: '失败', endedAt: Date.now() });
      jlog(job, `✖ 退出码 ${code}`);
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, result: 'exit-' + code });
      finishJob(job);
    }
  });
}

/* ---------------- 常驻工具会话（hugo / wdckit）----------------
   用户 2026-09-17 要求：界面一直开着，格单盘/多盘只需往里发 format；用完自动 q。
   优先 tmux（服务重启也能活），没有 tmux 则用 script 伪终端。 */
const toolSessions = new Map();   // toolId -> session
const PROMPT_RE = { hugo: /\(hugo\)\s*$/, wdckit: /\(wdckit[^)]*\)\s*$/ };
/* hugo/wdckit 的 format 会问 “Are you sure ... (Y/N)”。
   2026-09-19 排查发现：会话模式只发了 format 命令、没人回 Y，
   结果是命令全部堆在确认提示上（日志刷 Invalid response），格式化根本没开始。
   这里统一识别确认提示并自动回 Y。 */
const CONFIRM_RE = /(are you sure[\s\S]{0,300}?\(\s*y\s*\/\s*n\s*\)\s*)$/i;
function stripAnsi(s) { return String(s || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); }
function sessionTail(sess, n) {
  const t = stripAnsi(sessionText(sess)).replace(/\r/g, '\n');
  return t.split('\n').filter((x) => x.trim()).slice(-(n || 6)).join('\n');
}
function confirmPending(sess) { return CONFIRM_RE.test(sessionTail(sess, 8).trim()); }
/* 若会话正卡在确认提示上 → 回 Y；返回是否回答了 */
function answerConfirmIfNeeded(sess, job) {
  if (!sess || !sess.ok) return false;
  if (!confirmPending(sess)) return false;
  const ok = sendToolCmd(sess, 'Y');
  if (ok && job) jlog(job, '⏎ 检测到工具确认提示（Are you sure ... Y/N）→ 已自动回 Y');
  return ok;
}
/* 等会话回到工具提示符（hugo)/wdckit) 再发下一条命令，避免命令被塞进确认提示里 */
function waitToolPrompt(sess, toolId, cb, timeoutMs) {
  const deadline = Date.now() + (Number(timeoutMs) || 20000);
  const iv = setInterval(() => {
    if (!sess || !sess.ok) { clearInterval(iv); return cb(false); }
    if (answerConfirmIfNeeded(sess, null)) { /* 先回答确认，继续等提示符 */ }
    const last = sessionTail(sess, 3).trim().split('\n').slice(-1)[0].trim();
    if (PROMPT_RE[toolId] && PROMPT_RE[toolId].test(last)) { clearInterval(iv); return cb(true); }
    if (Date.now() > deadline) { clearInterval(iv); return cb(false); }
  }, 900);
  if (iv.unref) iv.unref();
}
/* 真实进度兜底：hugo/wdckit 不打印百分比 → 用 sg_turs 的 “Progress indication: x%” 取真实进度 */
function probeFormatProgress(dev) {
  if (!dev || !String(dev).startsWith('/dev/')) return { progress: null };
  try {
    const out = execFileSync('bash', ['-lc', 'sg_turs -v ' + rules.shq(String(dev)) + ' 2>&1 || true'], { encoding: 'utf8', timeout: 8000 });
    const txt = String(out);
    const m = txt.match(/Progress indication:\s*([\d.]+)\s*%/);
    if (m) return { progress: Number(m[1]), formatting: true };
    const notReady = /not ready/i.test(txt);
    return { progress: null, formatting: notReady && /format in progress/i.test(txt), notReady };
  } catch (e) { return { progress: null }; }
}
/* 2026-09-20 修复【发现B】：直接运行路径原来是**死超时**（cmdTimeoutSec 默认 3600s），
   而 SAS 全盘格式化要 3-6 小时 → 盘还在格却被判“超时失败”（sdi 当初 12 连失败的疑似真因）。
   现在到点先判断“是不是真的还在格”，是就继续延长；只有确实没进展才判超时。硬上限 24h 防挂死。 */
function shouldExtendJobTimeout(job, now) {
  if (!job || job.endedAt) return false;
  const t = Number(now) || Date.now();
  const started = Number(job.startedAt) || t;
  if (t - started > 24 * 3600 * 1000) return false;                 // 硬上限 24 小时
  const lastAt = Number(job.lastProgressAt) || started;
  if (job.pctSeen && t - lastAt < 30 * 60 * 1000) return true;       // 有百分比且近 30 分钟刷新过
  const dev = (job.devices || [])[0] || job.device;
  try { const r = probeFormatProgress(dev); if (r && (r.progress != null || r.formatting)) return true; } catch (e) {}
  return false;
}
/* 轮询真实进度（只升不降），适用于 hugo / wdckit 这类不输出百分比的工具 */
function startProgressPoller(job) {
  if (job.progressTimer) return;
  const dev = (job.devices || [])[0];
  if (!dev || !String(dev).startsWith('/dev/')) return;
  job.progressTimer = setInterval(() => {
    if (job.endedAt) { clearInterval(job.progressTimer); job.progressTimer = null; return; }
    const r = probeFormatProgress(dev);
    if (r.progress == null) return;
    const p = Math.min(99, Math.max(2, Math.round(r.progress)));
    if (p > (job.progress || 0)) { job.pctSeen = true; job.lastProgressAt = Date.now(); jstate(job, { progress: p, speed: '' }); }
  }, 20000);
  if (job.progressTimer.unref) job.progressTimer.unref();
}
function stopProgressPoller(job) {
  try { if (job.progressTimer) clearInterval(job.progressTimer); } catch (e) {}
  job.progressTimer = null;
}
function getToolSession(toolId) { return toolSessions.get(toolId) || null; }
/* 服务重启后，把已经存在的 tmux 常驻会话重新接管（会话本身已脱离服务 cgroup，不会随重启消失） */
function attachExistingSessions(settings) {
  const out = [];
  if (!hasTmux()) return out;
  for (const toolId of ['hugo', 'wdckit']) {
    const name = 'dw-' + toolId;
    try {
      execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore', timeout: 8000 });
      const lp = sessLogPath(toolId);
      const s = { toolId, mode: 'tmux', name, proc: null, ok: true, ready: true,
        cwd: toolId === 'hugo' ? rules.expandPath((settings.toolPaths || {}).hugo, settings)
          : toolId === 'wdckit' ? rules.expandPath((settings.toolPaths || {}).wdckit, settings) : '',
        bin: rules.toolBin(toolId, settings), logPath: lp, lastUsed: Date.now(), runningJob: null, idleTimer: null, reattached: true };
      toolSessions.set(toolId, s);
      /* 记录 tmux server / pane 的 pid，避免启动清理误伤 */
      try {
        const pane = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim().split('\n')[0];
        if (pane) s.panePid = Number(pane);
        const srv = execFileSync('bash', ['-lc', 'pgrep -f ' + rules.shq('tmux new-session -d -s ' + name) + ' | head -1'], { encoding: 'utf8' }).trim();
        if (srv) s.serverPid = Number(srv);
      } catch (e) {}
      out.push(toolId);
    } catch (e) { /* 没有这个会话 */ }
  }
  return out;
}
function hasTmux() {
  try { execFileSync('which', ['tmux'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
/* 清理“空转的遗留工具会话”：
   2026-09-19 排查发现，script 模式的常驻会话在服务重启后不会被接管，旧实例越堆越多
   （139 上曾 9 个 hugo 空转，各占用 ~60% CPU，load 拉 19），而真正在格盘的进程会有持续磁盘 IO。
   判定：该 hugo/wdckit 进程 stdout 是 PTY（交互会话）、且两次采样 write_bytes 不增长 → 空转 → 结束。
   与当前会话表里的进程、以及任务注册表里还活着的 pid，一律不动。 */
/* 该进程（或其祖先）是不是 tmux 会话里的？tmux 里的 hugo/wdckit 不能当“空转遗留”杀掉，
   否则 pane 退出 → tmux server 退出 → 会话丢失（2026-09-19 踩过）。 */
function underTmux(pid) {
  try {
    let p = Number(pid);
    for (let i = 0; i < 6 && p > 1; i++) {
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').replace(/\0/g, ' ').trim(); } catch (e) { break; }
      if (/\btmux\b/.test(cmd)) return true;
      const st = fs.readFileSync('/proc/' + p + '/stat', 'utf8');
      const rp = st.slice(st.lastIndexOf(')') + 2).split(' ');
      p = Number(rp[1]);   // PPid
    }
  } catch (e) {}
  return false;
}
function reapIdleToolSessions(jobRegistry) {
  const keep = new Set();
  for (const s of toolSessions.values()) {
    if (s && s.proc && s.proc.pid) keep.add(s.proc.pid);
    if (s && s.serverPid) keep.add(s.serverPid);
  }
  for (const r of (jobRegistry || [])) {
    if (r && r.pid && r.status === '运行中') keep.add(Number(r.pid));
  }
  const targets = [];
  for (const toolId of ['hugo', 'wdckit']) {
    let pids = [];
    try { pids = execFileSync('bash', ['-lc', 'pgrep -x ' + toolId + ' || true'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number); } catch (e) {}
    for (const pid of pids) {
      try {
        if (keep.has(pid)) continue;
        if (underTmux(pid)) continue;                       // tmux 会话里的工具不碰
        try {                                                  // 刚启动的（<5 分钟）不碰：可能是刚开始的格式化
          const stt = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
          const fields = stt.slice(stt.lastIndexOf(')') + 2).split(' ');
          const startTicks = Number(fields[19]);
          const upSec = (Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0]) - startTicks / (Number(process.env.CLK_TCK || 100)));
          if (upSec < 300) continue;
        } catch (e) {}
        const out = fs.readlinkSync('/proc/' + pid + '/fd/1');
        if (!/\/dev\/pts\//.test(out)) continue;          // 非交互会话不动
        const io1 = fs.readFileSync('/proc/' + pid + '/io', 'utf8');
        const w1 = Number((io1.match(/write_bytes:\s*(\d+)/) || [])[1] || 0);
        targets.push({ toolId, pid, w1 });
      } catch (e) {}
    }
  }
  if (!targets.length) return [];
  /* 10 秒后二次采样：write_bytes 没涨 = 空转 */
  const timer = setTimeout(() => {
    const killed = [];
    for (const t of targets) {
      try {
        if (!pidAlive(t.pid)) continue;
        const io2 = fs.readFileSync('/proc/' + t.pid + '/io', 'utf8');
        const w2 = Number((io2.match(/write_bytes:\s*(\d+)/) || [])[1] || 0);
        if (w2 - t.w1 <= 4096) {
          try { process.kill(t.pid, 'SIGTERM'); } catch (e) {}
          killed.push(t.pid);
        }
      } catch (e) {}
    }
    if (killed.length) {
      console.log('[disk-webui] 已清理空转的遗留工具会话 ' + killed.length + ' 个：' + killed.join(' '));
      try { appendJSONL('audit.jsonl', { at: Date.now(), kind: 'reap-idle-sessions', pids: killed }); } catch (e) {}
    }
  }, 10000);
  if (timer.unref) timer.unref();
  return targets.map((t) => t.pid);
}
function sessLogPath(toolId) { return path.join(jobLogDir(), 'tool-' + toolId + '.log'); }
/* tmux 会话还在不在 */
function tmuxAlive(name) {
  try { execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore', timeout: 5000 }); return true; } catch (e) { return false; }
}

function ensureToolSession(toolId, settings, cb) {
  let s = toolSessions.get(toolId);
  if (s && s.ok) {
    if (s.mode === 'tmux') {
      try { execFileSync('tmux', ['has-session', '-t', s.name], { stdio: 'ignore' }); return cb(null, s); }
      catch (e) { s.ok = false; toolSessions.delete(toolId); s = null; }
    } else if (s.proc && !s.proc.killed) return cb(null, s);
  }
  const bin = rules.toolBin(toolId, settings);
  const cwd = toolId === 'hugo' ? rules.expandPath((settings.toolPaths || {}).hugo, settings)
    : toolId === 'wdckit' ? rules.expandPath((settings.toolPaths || {}).wdckit, settings) : '';
  const lp = sessLogPath(toolId);
  try { fs.writeFileSync(lp, `--- ${new Date().toLocaleString('zh-CN')} 开始 ${toolId} 常驻会话 ---\n`); } catch (e) {}
  const sess = { toolId, mode: hasTmux() ? 'tmux' : 'script', name: 'dw-' + toolId, proc: null, ok: false, ready: false,
    cwd, bin, logPath: lp, lastUsed: Date.now(), runningJob: null, idleTimer: null, lastErr: '' };
  if (sess.mode === 'tmux') {
    try {
      execFileSync('tmux', ['kill-session', '-t', sess.name], { stdio: 'ignore' });
    } catch (e) {}
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', sess.name, '-c', cwd || '/', bin], { stdio: 'ignore', env: Object.assign({}, process.env, { TERM: 'xterm' }) });
      execFileSync('tmux', ['pipe-pane', '-t', sess.name, '-o', 'cat >> ' + rules.shq(lp)], { stdio: 'ignore' });
      sess.ok = true;
      /* tmux server（及 pane 里的工具）脱离 webui 服务 cgroup：重启服务不会杀掉正在跑的格式化 */
      try {
        const srv = execFileSync('bash', ['-lc', 'pgrep -f ' + rules.shq('tmux new-session -d -s ' + sess.name) + ' | head -1'], { encoding: 'utf8' }).trim();
        if (srv) { sess.serverPid = Number(srv); moveOutOfServiceCgroup(sess.serverPid); }
        const pane = execFileSync('tmux', ['list-panes', '-t', sess.name, '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim().split('\n')[0];
        if (pane) { sess.panePid = Number(pane); moveOutOfServiceCgroup(sess.panePid); }
      } catch (e) {}
    } catch (e) { sess.lastErr = e.message; sess.ok = false; }
  } else {
    try {
      const p = spawn('script', ['-qfc', bin, '/dev/null'], { cwd: cwd || undefined, env: Object.assign({}, process.env, { TERM: 'xterm' }) });
      sess.proc = p;
      sess.ok = true;
      if (p.pid) moveOutOfServiceCgroup(p.pid);   // 脱离服务 cgroup，重启不掉
      const onData = (d) => {
        const txt = String(d);
        try { fs.appendFileSync(lp, txt); } catch (e) {}
        sess.lastOut = (sess.lastOut || '') + txt;
        if (sess.lastOut.length > 200000) sess.lastOut = sess.lastOut.slice(-100000);
        if (sess.onLine) txt.split(/\r?\n/).forEach((l) => { if (l.trim()) sess.onLine(l.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')); });
      };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
      p.on('close', () => { sess.ok = false; });
    } catch (e) { sess.lastErr = e.message; sess.ok = false; }
  }
  toolSessions.set(toolId, sess);
  if (!sess.ok) return cb(new Error(sess.lastErr || '工具会话启动失败'));
  /* 等提示符出现（最多 20 秒） */
  let waited = 0;
  const iv = setInterval(() => {
    waited += 700;
    const txt = sessionText(sess);
    if (PROMPT_RE[toolId].test(txt.trim().split('\n').slice(-1)[0] || '')) {
      sess.ready = true; clearInterval(iv); return cb(null, sess);
    }
    if (waited > 20000) { clearInterval(iv); sess.ready = true; return cb(null, sess); }   // 提示符没识别出来也先放行
  }, 700);
  if (iv.unref) iv.unref();
}
function sessionText(sess) {
  if (!sess) return '';
  if (sess.mode === 'tmux') {
    try { return execFileSync('tmux', ['capture-pane', '-p', '-t', sess.name], { encoding: 'utf8', timeout: 5000 }); }
    catch (e) { return ''; }
  }
  return sess.lastOut || '';
}
function sendToolCmd(sess, text) {
  if (!sess || !sess.ok) return false;
  if (sess.mode === 'tmux') {
    try { execFileSync('tmux', ['send-keys', '-t', sess.name, text, 'Enter'], { timeout: 8000 }); return true; }
    catch (e) { return false; }
  }
  try { sess.proc.stdin.write(text + '\n'); return true; } catch (e) { return false; }
}
/* 退出工具界面：发送 q（hugo/wdckit 的退出命令），然后关闭会话 */
function quitToolSession(toolId, keepLog) {
  const s = toolSessions.get(toolId);
  if (!s) return false;
  try { sendToolCmd(s, 'q'); } catch (e) {}
  setTimeout(() => {
    if (s.mode === 'tmux') { try { execFileSync('tmux', ['kill-session', '-t', s.name], { stdio: 'ignore' }); } catch (e) {} }
    else { try { s.proc.kill('SIGHUP'); } catch (e) {} }
    s.ok = false;
    toolSessions.delete(toolId);
  }, 1200);
  return true;
}
/* 干完活后空闲一段时间自动 q（默认 600s = 10 分钟；设 0 = 一直开着不自动退） */
function scheduleIdleQuit(toolId) {
  const st = load('settings');
  const raw = Number((st.toolSession || {}).idleQuitSec);
  const sec = Number.isFinite(raw) ? raw : 600;
  if (!(sec > 0)) return;
  const s = toolSessions.get(toolId);
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    const hasRun = [...jobs.values()].some((j) => j.toolId === toolId && j.status === '运行中');
    if (hasRun) return;
    quitToolSession(toolId);
    appendJSONL('audit.jsonl', { at: Date.now(), kind: 'tool-session-quit', tool: toolId, reason: '空闲超时自动 q' });
  }, sec * 1000);
  if (s.idleTimer.unref) s.idleTimer.unref();
}
/* 在常驻会话里执行一条 format 命令，靠提示符判断完成 */
function runJobInSession(job, settings) {
  jstate(job, { stage: '调用工具', progress: 2 });
  captureDefectsBefore(job);   // 格式化前缺陷快照
  jlog(job, `在常驻 ${job.toolName} 界面里执行：${job.inToolCommand}`);
  ensureToolSession(job.toolId, settings, (err, sess) => {
    if (err || !sess) {
      jlog(job, '⚠ 常驻工具会话不可用：' + (err ? err.message : '未知') + ' → 回退为单次调用');
      const s2 = Object.assign({}, settings, { toolSession: Object.assign({}, (settings.toolSession || {}), { enabled: false }) });
      return runJob(job, s2);
    }
    /* 2026-09-19 用户明确：**不要排队**。会话忙 / 不在提示符上 → 直接回退为独立进程并行执行 */
    const cur = sess.runningJob ? jobs.get(sess.runningJob) : null;
    const tailLine = sessionTail(sess, 3).trim().split('\n').slice(-1)[0].trim();
    const atPrompt = !!(PROMPT_RE[job.toolId] && PROMPT_RE[job.toolId].test(tailLine));
    if ((cur && cur.id !== job.id && !cur.endedAt) || (!atPrompt && !confirmPending(sess))) {
      jlog(job, 'ℹ 常驻会话忙 → 改为独立进程并行执行（不排队）');
      const s2 = Object.assign({}, settings, { toolSession: Object.assign({}, (settings.toolSession || {}), { enabled: false }) });
      job.status = '运行中';
      job._usedSession = false;
      return runJob(job, s2);
    }
    sess.runningJob = job.id;
    sess.lastUsed = Date.now();
    const before = sessionText(sess).split(/\r?\n/).length;
    let done = false;
    const timeoutSec = Number(settings.cmdTimeoutSec) || 3600;
    const deadline = Date.now() + timeoutSec * 1000;
    const onLine = (line) => {
      if (!line.trim() || done) return;
      jlog(job, line.slice(0, 500));
      if (/already run/i.test(line)) {
        done = true;
        const retry = (load('settings').retryAlreadyRun !== false);
        if (retry) {
          job._retries = (job._retries || 0) + 1;
          if (job._retries > 240) { jlog(job, '✖ 等待工具空闲超过 4 小时，放弃'); }
          else {
            jlog(job, '⏳ 工具单实例：当前已有同一个工具在跑 → ' + 60 + ' 秒后再试（第 ' + job._retries + ' 次）');
            jstate(job, { status: '运行中', stage: '等待工具空闲（工具单实例限制）' });
            setTimeout(() => { if (!job.endedAt) { jstate(job, { status: '运行中', stage: '重试中' }); runJob(job, load('settings')); } }, 60000);
            return;
          }
        }
        jstate(job, { status: '失败', stage: '失败（工具已在运行）', endedAt: Date.now() });
        jlog(job, `✖ ${job.toolName} 报 “already run”：机器上已有另一个 ${job.toolName} 在跑`);
        appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, result: 'already-run' });
        return finishJob(job);
      }
      markPct(job, parsePct(line));
      /* 工具致命错误（wdckit 找不到盘也会返回成功）→ 直接判失败，不再让它进入续格死循环 */
      if (toolFatalLine(line)) {
        done = true;
        jstate(job, { status: '失败', stage: '工具报错（找不到设备/执行失败）', endedAt: Date.now() });
        jlog(job, '✖ ' + String(line).trim());
        appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, serial: job.serial, result: 'tool-fatal-output' });
        try { sess.runningJob = null; } catch (e) {}
        return finishJob(job);
      }
    };
    sess.onLine = onLine;
    /* 会话输出统一走“日志文件”:tmux 的 pipe-pane / script 的落盘都会写进 sess.logPath，
       以前 tmux 模式没人读这个文件 → 任务日志空白、进度卡在 2%（已修） */
    try {
      if (sess.logPath && fs.existsSync(sess.logPath)) {
        if (job.tail && job.tail.timer) clearInterval(job.tail.timer);
        job.tail = tailFile(sess.logPath, onLine);
      }
    } catch (e) {}
    /* 等回到工具提示符再发命令；若卡在 Y/N 确认提示先自动回 Y */
    answerConfirmIfNeeded(sess, job);
    if (!sendToolCmd(sess, job.inToolCommand)) {
      /* 发送失败：常见于会话刚死/被外部关掉 → 重建会话再试一次 */
      jlog(job, '⚠ 命令发送失败，尝试重建会话后重试…');
      try { if (sess.mode === 'tmux') execFileSync('tmux', ['kill-session', '-t', sess.name], { stdio: 'ignore' }); } catch (e) {}
      toolSessions.delete(job.toolId);
      return ensureToolSession(job.toolId, settings, (err2, sess2) => {
        if (err2 || !sess2 || !sendToolCmd(sess2, job.inToolCommand)) {
          jstate(job, { status: '失败', stage: '失败', endedAt: Date.now() });
          jlog(job, '✖ 重建会话后仍无法发送命令：' + ((err2 && err2.message) || '未知'));
          appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, result: 'session-send-fail' });
          return finishJob(job);
        }
        sess2.runningJob = job.id;
        return watchSessionJob(job, sess2, settings, done);
      });
    }
    return watchSessionJob(job, sess, settings, done);
  });
}

/* 盯着会话里的任务：等提示符出现 = 完成；超时则中断会话里的命令并收尾 */
function watchSessionJob(job, sess, settings, doneFlag) {
  let done = !!doneFlag;
  const timeoutSec = Number(settings.cmdTimeoutSec) || 3600;
  const deadline = Date.now() + timeoutSec * 1000;
  sess.runningJob = job.id;
  startProgressPoller(job);   // hugo/wdckit 不输出百分比 → 用 sg_turs 兜底取真实进度
  let answeredOnce = false;
  const iv = setInterval(() => {
    if (done) { clearInterval(iv); return; }
    if (job.endedAt) { clearInterval(iv); done = true; return; }
    /* 卡在 Y/N 确认提示 → 自动回 Y（否则格式化永远起不来） */
    if (answerConfirmIfNeeded(sess, answeredOnce ? null : job)) answeredOnce = true;
    if (Date.now() > deadline) {
      clearInterval(iv); done = true;
      jstate(job, { status: '失败', stage: '超时', endedAt: Date.now() });
      jlog(job, `⚠️ 超过 ${timeoutSec}s 未出现提示符，中断工具界面里的命令`);
      interruptToolSession(job.toolId);
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, result: 'timeout' });
      return finishJob(job);
    }
    const txt = sessionText(sess);
    /* 会话已经丢了（会话老板重启后 tmux 没接管住）→ 别让任务永远挂 2%，直接判失败 */
    if (!sess.ok || (sess.mode === 'tmux' && !tmuxAlive(sess.name))) {
      clearInterval(iv); done = true;
      jstate(job, { status: '失败', stage: '工具会话已丢失', endedAt: Date.now() });
      jlog(job, '✖ 常驻工具会话已不存在（重启/异常退出）→ 本任务终止，请重新提交');
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-fail', jobId: job.id, device: job.device, serial: job.serial, result: 'session-lost' });
      return finishJob(job);
    }
    const last = (txt.split(/\r?\n/).filter((x) => x.trim()).slice(-1)[0] || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (PROMPT_RE[job.toolId] && PROMPT_RE[job.toolId].test(last)) {
      clearInterval(iv); done = true;
      jstate(job, { status: '完成', stage: '完成', progress: 100, endedAt: Date.now() });
      jlog(job, '✔ 完成（工具已回到提示符）');
      appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-done', jobId: job.id, device: job.device, result: 'success' });
      finishJob(job);
    }
  }, 2500);
  if (iv.unref) iv.unref();
  job.sessionWatch = iv;
}

/* 给常驻会话发 Ctrl-C（中断工具界面里正在跑的格式化；与 stopJob 配合） */
function interruptToolSession(toolId) {
  const s = toolSessions.get(toolId);
  if (!s || !s.ok) return false;
  try {
    if (s.mode === 'tmux') execFileSync('tmux', ['send-keys', '-t', s.name, 'C-c'], { timeout: 8000 });
    else if (s.proc && s.proc.stdin) s.proc.stdin.write('\u0003');
    return true;
  } catch (e) { return false; }
}
/* 看门狗：会话回到提示符后，自动开队列里的下一个任务 */
function watchSessionIdle(toolId, sess, settings) {
  if (sess.idleWatch) return;
  sess.idleWatch = setInterval(() => {
    if (!sess || !sess.ok) { clearInterval(sess.idleWatch); sess.idleWatch = null; return; }
    const q = queues.get(toolId) || [];
    if (!q.length) { clearInterval(sess.idleWatch); sess.idleWatch = null; return; }
    if (sess.runningJob) {
      const cur = jobs.get(sess.runningJob);
      if (cur && !cur.endedAt) return;
      sess.runningJob = null;
    }
    const last = sessionTail(sess, 3).trim().split('\n').slice(-1)[0].trim();
    if (!(PROMPT_RE[toolId] && PROMPT_RE[toolId].test(last))) return;
    const next = q.shift();
    if (!next) return;
    next.status = '运行中'; next.stage = '准备';
    jlog(next, '▶ 工具会话已空闲，开始执行');
    runJob(next, load('settings') || settings);
  }, 5000);
  if (sess.idleWatch.unref) sess.idleWatch.unref();
}
function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.timer) clearInterval(job.timer);
  stopProgressPoller(job);
  try { if (job.tail && job.tail.timer) clearInterval(job.tail.timer); } catch (e) {}
  try { if (job.watch) clearInterval(job.watch); } catch (e) {}
  try { if (job.sessionWatch) clearInterval(job.sessionWatch); } catch (e) {}
  /* 常驻会话里跑的任务：没有 child/pid，必须给工具界面发 Ctrl-C，否则盘还在格 */
  if (SERIAL_TOOLS.has(job.toolId) && job.inToolCommand) {
    const ok = interruptToolSession(job.toolId);
    jlog(job, ok ? '⏹ 已向工具界面发送 Ctrl-C 中断' : '⚠ 会话不在，无法向工具界面发送中断（可能它已经退出）');
  }
  if (job.child) { try { job.child.kill('SIGTERM'); } catch (e) {} }
  if (job.pid) {
    /* detached 的子进程自成进程组 → 先按进程组杀（连 sudo 带工具一起），3 秒后没死再 SIGKILL */
    let signalled = false;
    try { process.kill(-job.pid, 'SIGTERM'); signalled = true; } catch (e) { try { process.kill(job.pid, 'SIGTERM'); signalled = true; } catch (e2) {} }
    if (signalled) {
      const t = setTimeout(() => {
        if (pidAlive(job.pid)) {
          try { process.kill(-job.pid, 'SIGKILL'); } catch (e) { try { process.kill(job.pid, 'SIGKILL'); } catch (e2) {} }
          jlog(job, '⚠ 进程未响应 SIGTERM，已强制 SIGKILL');
        }
      }, 3000);
      if (t.unref) t.unref();
    } else {
      jlog(job, '⚠ 未能向进程发送停止信号（可能已自行退出）');
    }
  }
  jstate(job, { status: '已停止', stage: '已停止', endedAt: Date.now() });
  jlog(job, '⏹ 已中断');
  appendJSONL('audit.jsonl', { at: Date.now(), kind: 'format-stop', jobId: job.id, device: job.device });
  finishJob(job, { hook: false });   // 推进排队队列（但不触发“续格”钩子）
  return true;
}

module.exports = { sessions, newSession, getSession, execInSession, stopSession, jobs, newJob, stopJob, pub, checkPolicy, setFinishHook,
  /* 2026-09-17 新增：常驻工具会话 / 任务存盘 / 排对列 */
  toolSessions, getToolSession, ensureToolSession, sendToolCmd, quitToolSession, sessionText, scheduleIdleQuit,
  queues, saveRegistry, loadRegistry, moveOutOfServiceCgroup, pidAlive, JOB_LOG_DIR, sweepJobLogs, JOB_LOG_MAX_BYTES, adoptJobs, attachExistingSessions, interruptToolSession, stopAll,
  watchSessionIdle,
  /* 2026-09-19 新增：确认提示自动回 Y / 真实进度 / 遗留会话清理 */
  answerConfirmIfNeeded, waitToolPrompt, probeFormatProgress, startProgressPoller, stopProgressPoller, reapIdleToolSessions,
  /* 2026-09-20 新增：整棵进程树终止（超时/拔盘时确保真工具被杀） */
  killProcTree, shouldExtendJobTimeout };
