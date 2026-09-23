'use strict';
/* 前端逻辑：仪表盘 / 机器管理 / 命令行 / 日志 / 设置 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const TOKEN_KEY = 'dw_token';
let TOKEN = localStorage.getItem(TOKEN_KEY) || '';
/* 2026-09-22：机器作用域 —— 除了全局接口，其余请求一律带上「当前选中的机器」，
   保证「选中哪台，页面上的数据/操作就是哪台」。
   全局接口：登录、机器列表/同步、本机版本与健康、改自己密码。 */
const GLOBAL_API = ['/login', '/logout', '/me', '/password', '/machines', '/version', '/health', '/bundle', '/terminal'];
function scopedPath(path) {
  if (!path.startsWith('/') || path.startsWith('/machines')) return path;
  const seg = '/' + (path.split('?')[0].split('/')[1] || '');
  if (GLOBAL_API.indexOf(seg) >= 0) return path;
  return `/machines/${S.machineId || 'local'}${path}`;
}
const api = async (path, method = 'GET', body) => {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h['x-token'] = TOKEN;
  const r = await fetch('/api/v1' + scopedPath(path), { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) showLogin();
  if (r.status === 403) toast('⛔ ' + (j.error || '权限不足'), 5000);
  return j;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* 缺陷快照展示（格式化前/后各查一遍）：SMART 05/196/197/198/199 或 SAS G-list */
function fmtDefectSnap(tag, d) {
  if (!d) return '';
  const v = (x) => (x === null || x === undefined ? '-' : x);
  return `<div class="muted small">${tag}：健康 ${esc(d.health || '未知')} · 05=${v(d.s05)} · 196=${v(d.s196)} · 197=${v(d.s197)} · 198=${v(d.s198)} · 199=${v(d.s199)} · G-list=${v(d.gList)}${d.error ? ' · ⚠ ' + esc(d.error) : ''}</div>`;
}
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
/* SMART 属性行：0 绿色 / >0 橙色 / 读取失败灰色 */
const smartRow = (label, v) => `<div class="k">${esc(label)}</div><div class="v">${(v === null || v === undefined) ? '<span class="muted">读取失败</span>' : `<b style="color:${Number(v) > 0 ? '#b45309' : '#16a34a'}">${esc(v)}</b>`}</div>`;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hide');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hide'), ms);
}

/* ---------- 通用确认/输入弹窗（替代原生 confirm()/prompt()）----------
   2026-09-20 用户反馈：「不再续格」「清空历史/日志」点完整页卡住。
   根因：原生 confirm()/prompt() 会**同步阻塞整个页面**，在远程控制台/嵌入式浏览器里
   甚至不渲染弹窗 → 表现就是“整个网页卡住”（刷新后自然什么也没变）。
   改用网页自制弹窗（非阻塞 Promise）。 */
let _askCb = null;
function askModal(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const m = $('#askModal');
    if (!m) { resolve(opts.input ? window.prompt(opts.msg, opts.def || '') : window.confirm(opts.msg)); return; }
    $('#askTitle').textContent = opts.title || '确认';
    $('#askMsg').textContent = String(opts.msg || '');
    const wrap = $('#askInputWrap');
    if (opts.input) { wrap.classList.remove('hide'); $('#askInput').value = (opts.def == null ? '' : String(opts.def)); }
    else { wrap.classList.add('hide'); $('#askInput').value = ''; }
    $('#askYes').textContent = opts.okText || '确定';
    m.classList.remove('hide');
    _askCb = resolve;
    if (opts.input) setTimeout(() => { try { $('#askInput').focus(); $('#askInput').select(); } catch (e) {} }, 30);
  });
}
const askConfirm = (msg, okText) => askModal({ msg, okText });
const askPrompt = (msg, def) => askModal({ msg, def, input: true });
(function bindAskModal() {
  const m = $('#askModal');
  if (!m) return;
  const done = (v) => { m.classList.add('hide'); const cb = _askCb; _askCb = null; if (cb) cb(v); };
  $('#askYes').onclick = () => {
    const isInput = !$('#askInputWrap').classList.contains('hide');
    done(isInput ? $('#askInput').value : true);
  };
  $('#askNo').onclick = () => done($('#askInputWrap').classList.contains('hide') ? false : null);
  m.onclick = (e) => { if (e.target === m) done($('#askInputWrap').classList.contains('hide') ? false : null); };
})();

const S = { machines: [], machineId: 'local', disks: [], sel: null, settings: null, cfg: {}, tabs: [], activeTab: null, jobES: null, termES: null, me: null, checked: new Set(), termMachine: 'local' };

/* ---------------- 登录 / 权限 ---------------- */
function showLogin() {
  document.body.classList.add('logged-out');
  const m = document.getElementById('loginModal'); if (m) m.classList.add('hide');
  const u = document.getElementById('lgUser2'); if (u && !u.value) u.focus();
}
function hideLogin() {
  document.body.classList.remove('logged-out');
  const m = document.getElementById('loginModal'); if (m) m.classList.add('hide');
}
async function doLogin() {
  const u = document.getElementById('lgUser2') || document.getElementById('lgUser');
  const p = document.getElementById('lgPass2') || document.getElementById('lgPass');
  const err = document.getElementById('lgErr2') || document.getElementById('lgErr');
  const body = { user: (u.value || '').trim(), pass: p.value };
  const btn0 = document.getElementById('lgGo2');
  if (btn0) { btn0.disabled = true; btn0.textContent = '登录中…'; }
  const r = await fetch('/api/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const btn = document.getElementById('lgGo2');
  if (!j.token) { err.textContent = j.error || '登录失败'; err.classList.remove('hide'); if (btn) { btn.disabled = false; btn.textContent = '登 录'; } return; }
  TOKEN = j.token; localStorage.setItem(TOKEN_KEY, TOKEN);
  err.classList.add('hide');
  hideLogin(); toast(`已登录：${j.user}（${j.role}）`);
  await loadMe(); await loadMachines(); await loadDisks(false);
}
$('#lgGo').onclick = doLogin;
$('#lgPass').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
if ($('#lgGo2')) $('#lgGo2').onclick = doLogin;
if ($('#lgPass2')) $('#lgPass2').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
if ($('#lgEye')) $('#lgEye').onclick = () => {
  const p = $('#lgPass2'); p.type = p.type === 'password' ? 'text' : 'password'; p.focus();
};
function fillLoginHost(h) {
  const el = document.getElementById('loginHost');
  if (!el || !h) return;
  const ips = (h.ips || []).map((i) => i.ip).slice(0, 2).join(' / ');
  el.textContent = `${h.hostname || ''} ｜ ${ips}:${h.port || 8090} ｜ v${h.version || ''}${h.build ? ' (' + h.build + ')' : ''}`;
}
$('#btnLogout').onclick = async () => {
  await api('/logout', 'POST', {});
  TOKEN = ''; localStorage.removeItem(TOKEN_KEY); S.me = null;
  applyPermissions(); showLogin(); toast('已退出');
};
async function loadMe() {
  const r = await api('/me');
  if (r.needLogin || r.error) { S.me = null; applyPermissions(); return false; }
  S.me = r; applyPermissions(); return true;
}
function can(what) {
  if (!S.me) return false;
  const p = S.me.permissions || {};
  return !!p[what];
}
function applyPermissions() {
  const p = (S.me && S.me.permissions) || {};
  $('#userBadge').textContent = S.me ? `${S.me.user} · ${S.me.role}` : '未登录';
  $('#btnLogout').style.display = S.me ? '' : 'none';
  const show = (sel, on) => { const el = $(sel); if (el) el.style.display = on ? '' : 'none'; };
  show('.tab[data-view="terminal"]', !!p.terminal);
  show('.tab[data-view="settings"]', !!p.terminal);
  show('.tab[data-view="machines"]', !!p.terminal);
  show('.tab[data-view="logs"]', !!p.view);
  show('#btnBatchFormat', !!p.format);
  show('#btnBatchCfg', !!p.format);
  show('#dock', true);
  if (!p.terminal) { const d = $('#dock'); if (d) d.classList.add('collapsed'); }
  if (S.disks && S.disks.length) renderDiskList();
  if (S.sel) renderDetail(S.sel);
}

/* ---------------- 视图切换 ---------------- */
$$('.tab').forEach((b) => b.onclick = () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + b.dataset.view).classList.add('active');
  if (b.dataset.view === 'logs') loadLogs();
  if (b.dataset.view === 'settings') { loadSettings(); loadHistory(); }
  if (b.dataset.view === 'machines') loadMachines();
});

/* ---------------- 机器 ---------------- */
async function loadMachines() {
  const r = await api('/machines');
  S.machines = r.machines || [];
  const sel = $('#machineSelect');
  sel.innerHTML = S.machines.map((m) => `<option value="${m.id}">${esc(m.name)} · ${esc(m.ip)}:${m.port}</option>`).join('');
  if (!S.machines.some((m) => m.id === S.machineId)) S.machineId = S.machines[0] && S.machines[0].id;
  sel.value = S.machineId;
  const tm = $('#termMachine');
  if (tm) {
    tm.innerHTML = S.machines.map((m) => `<option value="${m.id}">${esc(m.name)} · ${esc(m.ip)}</option>`).join('');
    tm.value = S.termMachine;
    tm.onchange = () => {
      S.termMachine = tm.value;
      toast('命令行目标机器：' + (S.machines.find((m) => m.id === S.termMachine) || {}).name);
      if (S.activeTab) activateTab(S.activeTab);
    };
  }
  $('#machineRows').innerHTML = S.machines.map((m) => `<tr>
    <td>${esc(m.name)}${m.local ? ' <span class="chip sys">本机</span>' : ''}</td>
    <td style="font-family:var(--mono)">${esc(m.ip)}</td><td>${m.port}</td>
    <td><span class="dot ${m.status === 'online' ? 'on' : m.status === 'offline' ? 'off' : ''}"></span> ${m.status === 'online' ? '在线' : m.status === 'offline' ? '离线' : '未知'}</td>
    <td class="muted small">${m.lastCheck ? new Date(m.lastCheck).toLocaleString('zh-CN', { hour12: false }) : '-'}</td>
    <td class="muted small">${esc(m.note || '')}</td>
    <td>
      <button class="btn small" data-act="test" data-id="${m.id}">连接测试</button>
      <button class="btn small" data-act="open" data-id="${m.id}">打开页面</button>
      <button class="btn small" data-act="edit" data-id="${m.id}">编辑</button>
      ${m.local ? '' : `<button class="btn small" data-act="del" data-id="${m.id}">删除</button>`}
    </td></tr>`).join('');
  $$('#machineRows .btn').forEach((b) => b.onclick = () => machineAction(b.dataset.act, b.dataset.id));
  updateSvc();
}
function curMachine() { return S.machines.find((m) => m.id === S.machineId) || S.machines[0]; }
function updateSvc() {
  const m = curMachine();
  if (!m) return;
  const hp = (S.health && S.health.httpsPort) || 8443;
  const httpsOn = !S.health || S.health.httpsEnabled !== false;
  $('#curUrl').innerHTML = `http://${esc(m.ip)}:${m.port}` + (httpsOn ? `<a href="https://${esc(m.ip)}:${hp}" target="_blank">https://${esc(m.ip)}:${hp}</a>` : '');
  $('#svcStatus').className = 'dot ' + (m.local || m.status === 'online' ? 'on' : m.status === 'offline' ? 'off' : '');
  $('#svcText').textContent = m.local ? '本机服务运行中' : (m.status === 'online' ? '在线' : m.status === 'offline' ? '离线' : '未知');
}
async function machineAction(act, id) {
  const m = S.machines.find((x) => x.id === id);
  if (act === 'test') {
    toast('正在连接测试…');
    const r = await api(`/machines/${id}/test`, 'POST', {});
    toast(r.online ? `✔ 在线（${r.ms}ms）` : `✘ 不可达：${r.error || ''}`);
    loadMachines();
  } else if (act === 'open') {
    const r = await api(`/machines/${id}/connect`, 'POST', {});
    if (r.url) window.open(r.url, '_blank');
    else toast(r.error || '无法打开');
  } else if (act === 'edit') {
    const name = await askPrompt('名称', m.name); if (name === null) return;
    const ip = await askPrompt('IP', m.ip); if (ip === null) return;
    const port = await askPrompt('端口', m.port); if (port === null) return;
    const note = await askPrompt('备注', m.note || ''); if (note === null) return;
    const r = await api(`/machines/${id}`, 'PATCH', { name, ip, port: Number(port), note });
    if (r.error) return toast('❌ ' + r.error, 5000);
    loadMachines();
  } else if (act === 'del') {
    if (!(await askConfirm(`确认从列表移除 ${m.name}（${m.ip}）？仅移除记录，不影响目标机器。`))) return;
    await api(`/machines/${id}`, 'DELETE');
    loadMachines();
  }
}
$('#btnAdd').onclick = async () => {
  const ip = $('#mIp').value.trim();
  if (!ip) return toast('请填 IP');
  const r = await api('/machines', 'POST', { name: $('#mName').value.trim() || ip, ip, port: Number($('#mPort').value) || 8090, rack: $('#mRack').value, note: $('#mNote').value });
  if (r.error) return toast('❌ ' + r.error, 5000);
  $('#mIp').value = $('#mName').value = $('#mNote').value = $('#mRack').value = '';
  toast('已新增'); loadMachines();
};
$('#btnBulk').onclick = () => $('#bulkBox').classList.toggle('hide');
$('#btnBulkCancel').onclick = () => $('#bulkBox').classList.add('hide');
$('#btnBulkGo').onclick = async () => {
  const r = await api('/machines', 'POST', { bulk: $('#bulkText').value, port: Number($('#mPort').value) || 8090 });
  if (r.error) return toast('❌ ' + r.error);
  toast(`导入完成：新增 ${r.added} 台` + ((r.skipped && r.skipped.length) ? `，跳过 ${r.skipped.length} 条（${r.skipped.slice(0, 3).join('、')}${r.skipped.length > 3 ? '…' : ''}）` : ''), 6000);
  $('#bulkBox').classList.add('hide'); $('#bulkText').value = ''; loadMachines();
};


/* ---------- 自动续格截停 ---------- */
/* 自动续格的控制接口要跟着「当前选中的机器」走（2026-09-20 修复：原来只会打到页面所在那台机器，
   在别的机器页面里选中远端机器时会标错机器 → 表现为“点了没反应/什么也没变”） */
function afPath(action) {
  const mid = S.machineId || 'local';
  return mid === 'local' ? `/autoformat/${action}` : `/machines/${mid}/autoformat/${action}`;
}
async function loadAF() {
  const r = await api(afPath('status'));
  if (!r || r.error) { $('#btnPauseAF').style.display = 'none'; return; }
  S.af = r;
  const b = $('#btnPauseAF');
  b.style.display = r.continueOnDefect ? '' : 'none';
  if (r.paused) { b.textContent = '▶ 恢复自动续格'; b.className = 'btn small danger'; }
  else { b.textContent = '⏸ 暂停自动续格'; b.className = 'btn small'; }
  /* 全局续格状态变了 → 立刻让队列里的单盘按钮跟着变（用户 2026-09-20 指出） */
  try { renderJobList(); } catch (e) {}
}
/* 全局按钮：作用于**当前下拉选中的那台机器**（用户 2026-09-20 强调）
   点全局暂停 → 该机器单盘全部暂停；点全局续格 → 该机器单盘全部续格（清空单盘停止标记） */
$('#btnPauseAF').onclick = async () => {
  const mid = S.machineId || 'local';
  const cur = await api(afPath('status'));           // 以服务器当前状态为准，避免用到切机器前的旧值
  if (!cur || cur.error) return toast('❌ 取不到当前续格状态' + ((cur && cur.error) ? '：' + cur.error : ''));
  const paused = !cur.paused;
  if (!paused) {
    const n = ((cur.stopSerials) || []).length;
    const who = (S.machines.find((m) => m.id === mid) || {}).name || mid;
    const msg = `把【${who}】全部改为“续格”？` + (n ? `\n这会同时清掉该机器上 ${n} 块盘的「不再续格」标记。` : '\n（该机器当前没有单盘停止标记）');
    if (!(await askConfirm(msg))) return;
  }
  const r = await api(afPath('pause'), 'POST', { paused });
  if (r.error) return toast('❌ ' + r.error);
  toast(paused ? '已全局暂停：该机器所有盘都不再自动续格' : '已全部续格：单盘停止标记已清空', 5000);
  pollJobs();
};
async function stopSerial(serial, device, action) {
  if (!serial) return toast('该盘没有序列号，无法标记');
  const act = ['remove', 'allow', 'unallow'].indexOf(action) >= 0 ? action : 'add';
  const MSG = {
    add: `标记「${device}（SN ${serial}）」不再自动续格？`,
    remove: `恢复「${device}（SN ${serial}）」的自动续格？`,
    allow: `当前是全局暂停。只让「${device}（SN ${serial}）」这一块盘继续自动续格？`,
    unallow: `取消「${device}（SN ${serial}）」的单独放行（回到全局暂停状态）？`,
  };
  if (!(await askConfirm(MSG[act]))) return;
  const r = await api(afPath('stop-serial'), 'POST', { serial, action: act });
  if (r.error) return toast('❌ ' + r.error);
  toast((act === 'remove' || act === 'allow') ? '该盘已恢复自动续格' : '该盘已设为不再自动续格');
  pollJobs();
}

$('#btnSync').onclick = async () => {
  toast('正在与各节点同步…');
  const r = await api('/machines/sync', 'POST', {});
  if (r.error) return toast('❌ ' + r.error);
  toast(`同步完成：共 ${r.total} 台（新增 ${r.added}，更新 ${r.updated}）` + ((r.errors && r.errors.length) ? `，${r.errors.length} 台不可达` : ''), 6000);
  loadMachines();
};
$('#machineSelect').onchange = () => {
  S.machineId = $('#machineSelect').value;
  S.sel = null; S.af = null;            // 换机器：先丢掉旧机器的续格状态，避免全局按钮显示错状态
  updateSvc(); loadDisks(true); loadAF();   // 立即刷新顶部「暂停/恢复自动续格」按钮
  renderJobList();
};

/* ---------------- 硬盘 ---------------- */
async function loadDisks(force) {
  const mid = S.machineId || 'local';
  const r = await api(`/machines/${mid}/disks${force ? '?scan=1' : ''}`);
  if (r.error) { toast('扫描失败：' + r.error); return; }
  S.disks = r.disks || [];
  $('#diskCount').textContent = `${S.disks.length} 块`;
  renderDiskList();
  if (S.sel) { const d = S.disks.find((x) => x.id === S.sel.id); if (d) renderDetail(d); }
  const tools = r.tools || {};
  const missing = Object.keys(tools).filter((k) => !tools[k]);
  if (missing.length) toast('提示：本机缺少工具 ' + missing.join('、') + '，相关字段显示为「未知」（默认禁止格式化，可人工确认覆盖）', 6000);
}
/* ---------- 列表筛选（只看有缺陷 / 空闲 / 品牌 / 关键字） ---------- */
function filterState() {
  const v = (id, def) => { const e = document.getElementById(id); return e ? e.value : (def || ''); };
  return { q: String(v('fSearch')).trim().toLowerCase(), defect: v('fDefect'), brand: v('fBrand'), state: v('fState') };
}
function visibleDisks() {
  const f = filterState();
  return S.disks.filter((d) => {
    if (f.q) {
      const t = [d.device, d.serial, d.model, d.brand, d.interfaceType].join(' ').toLowerCase();
      if (t.indexOf(f.q) < 0) return false;
    }
    if (f.defect && String(d.defectStatus || '') !== f.defect) return false;
    if (f.brand && String(d.brand || '') !== f.brand) return false;
    if (f.state === 'busy' && !findFmt(d)) return false;
    if (f.state === 'idle' && findFmt(d)) return false;
    if (f.state === 'sys' && !d.isSystemDisk) return false;
    return true;
  });
}
function refreshBrandFilter() {
  const sel = document.getElementById('fBrand');
  if (!sel) return;
  const cur = sel.value;
  const brands = Array.from(new Set(S.disks.map((d) => d.brand).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">全部品牌</option>' + brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  if (brands.indexOf(cur) >= 0) sel.value = cur;
}
function bindFilters() {
  ['fSearch', 'fDefect', 'fBrand', 'fState'].forEach((id) => {
    const e = document.getElementById(id);
    if (e) { e.onchange = () => renderDiskList(); if (e.tagName === 'INPUT') e.oninput = () => renderDiskList(); }
  });
  const r = document.getElementById('btnFilterReset');
  if (r) r.onclick = () => {
    ['fSearch', 'fDefect', 'fBrand', 'fState'].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ''; });
    renderDiskList();
  };
}

function renderDiskList() {
  refreshBrandFilter();
  const list = visibleDisks();
  if ($('#diskCount')) $('#diskCount').textContent = (list.length === S.disks.length ? (S.disks.length + ' 块') : (list.length + '/' + S.disks.length + ' 块'));
  $('#diskList').innerHTML = list.map((d) => `<div class="diskc" data-id="${esc(d.id)}"></div>`).join('');
  const els = $$('#diskList .diskc');
  els.forEach((el) => {
    const d = list[els.indexOf(el)];
    if (!d) return;
    const def = d.defectStatus === '有' ? '<span class="chip warn">缺陷：有</span>' : d.defectStatus === '无' ? '<span class="chip ok">缺陷：无</span>' : '<span class="chip">缺陷：未知</span>';
    const snapChip = d.defectSnapshot === 'before' ? '<span class="chip">格前快照</span>' : '';
    el.className = 'diskc diskcard' + (S.sel && S.sel.id === d.id ? ' sel' : '');
    const canFmt = can('format');
    el.innerHTML = `
      ${canFmt ? `<input type="checkbox" class="dchk" data-id="${esc(d.id)}" ${S.checked.has(d.id) ? 'checked' : ''}>` : ''}
      <div style="flex:1">
        <div class="dev">${esc(d.device)} <span class="muted small">${esc(d.sizeText)}</span></div>
        <div class="meta">${esc(d.brand)} · ${esc(d.interfaceType)} · ${esc(d.model || '-')}</div>
        <div class="meta">SN: ${esc(d.serial || '-')}</div>
        <div class="chips">
          <span class="chip">LBA ${d.logicalBlockSize || '?'}B</span>
          <span class="chip">PBA ${d.physicalBlockSize || '?'}B</span>
          ${def}
          ${snapChip}
          ${d.isSystemDisk ? '<span class="chip sys">系统盘</span>' : ''}
          ${d.isMounted ? '<span class="chip bad">已挂载</span>' : ''}
          ${d.hasOverride ? '<span class="chip warn">人工修正</span>' : ''}
          ${d.allowFormat ? '' : '<span class="chip bad">禁止格式化</span>'}
        </div>
      </div>`;
    el.onclick = () => { S.sel = d; renderDiskList(); renderDetail(d); renderDiskProgress(); };
    const ck = el.querySelector('.dchk');
    if (ck) ck.onclick = (e) => {
      e.stopPropagation();
      if (e.target.checked) S.checked.add(d.id); else S.checked.delete(d.id);
      updateSelCount();
    };
  });
  updateSelCount();
}
function updateSelCount() {
  const n = S.checked.size;
  $('#selCount').textContent = `已选 ${n}`;
  const sel = S.disks.filter((d) => S.checked.has(d.id));
  const blocked = sel.filter((d) => !d.allowFormat && d.defectStatus !== '未知').length;
  $('#btnBatchFormat').textContent = n ? `批量格式化 (${n})` : '批量格式化';
}
$('#chkAll').onchange = (e) => {
  S.checked.clear();
  if (e.target.checked) S.disks.forEach((d) => S.checked.add(d.id));
  renderDiskList();
};
$('#btnBatchCfg').onclick = () => {
  if (!S.checked.size) return toast('先勾选硬盘');
  toast(`已勾选 ${S.checked.size} 块，批量配置将用到单盘详情页里的工具/模式/逻辑块大小`);
  $('#view-dash').scrollIntoView();
};
$('#btnBatchFormat').onclick = () => {
  const sel = S.disks.filter((d) => S.checked.has(d.id));
  if (!sel.length) return toast('先勾选硬盘');
  if (!can('format')) return toast('当前权限不能格式化');
  openBatchConfirm(sel);
};
function openBatchConfirm(list) {
  const div = document.createElement('div');
  div.className = 'modal'; div.id = 'batchModal';
  div.innerHTML = `<div class="dialog">
    <div class="row"><h2 style="margin:0">⚠️ 批量格式化确认</h2><div class="spacer"></div><button class="btn" id="bClose">✕ 关闭</button></div>
    <p class="muted small">勾选/取消硬盘，下面的命令会**自动加减**；单块显示单盘命令，多块显示批量命令。</p>
    <table class="tbl small"><thead><tr><th>选</th><th>设备</th><th>型号</th><th>序列号</th><th>品牌</th><th>接口</th><th>规则</th></tr></thead><tbody>
      ${list.map((d) => `<tr>
        <td><input type="checkbox" class="bchk" data-id="${esc(d.id)}" checked></td>
        <td>${esc(d.device)}</td><td style="font-family:var(--mono)">${esc(d.model || '-')}</td>
        <td style="font-family:var(--mono)">${esc(d.serial || '-')}</td><td>${esc(d.brand)}</td><td>${esc(d.interfaceType)}</td>
        <td>${d.allowFormat ? '✔ 允许' : '⛔ ' + esc(d.blockReason || '')}</td></tr>`).join('')}
    </tbody></table>
    <h3>将要执行的命令（随勾选自动变化）</h3>
    <div id="bCmds" class="cmdpreview"><div class="muted small">加载中…</div></div>
    <label class="check big"><input type="checkbox" id="bConfirm"> 我确认将擦除以上硬盘的数据，并可能导致硬盘不可用</label>
    <div class="row right"><button class="btn" id="bCancel">取消</button><button class="btn danger" id="bGo" disabled>开始格式化</button></div>
    <pre id="bResult" class="log" style="height:150px"></pre></div>`;
  document.body.appendChild(div);
  const ids = () => Array.from(div.querySelectorAll('.bchk')).filter((c) => c.checked).map((c) => c.dataset.id);
  let tm = null;
  const refresh = () => {
    clearTimeout(tm);
    tm = setTimeout(async () => {
      const sel = ids();
      if (!sel.length) { $('#bCmds').innerHTML = '<div class="muted small">（没有勾选任何硬盘）</div>'; $('#bGo').disabled = true; return; }
      const r = await api(`/machines/${S.machineId}/disks/batch-preview`, 'POST', { ids: sel, cfg: S.cfg });
      if (r.error) { $('#bCmds').innerHTML = '<div class="muted small">' + esc(r.error) + '</div>'; return; }
      const gs = r.groups || [];
      $('#bCmds').innerHTML = gs.map((g) => `
        <div style="margin-bottom:8px">
          <div class="muted small">${g.isBatch ? '【批量】' : '【单盘】'} ${esc(g.toolName)} · ${g.count} 块 · 逻辑块大小 ${g.lunSize}B</div>
          <pre>${esc(g.command)}</pre>
          ${g.cwd ? `<div class="muted small">执行目录：${esc(g.cwd)}</div>` : ''}
          ${g.inToolCommand && (g.toolId === 'hugo' || g.toolId === 'wdckit') ? `<div class="muted small">在工具界面里输入：<code>${esc(g.inToolCommand)}</code></div>` : ''}
          ${(g.warnings || []).map((w) => `<div class="muted small" style="color:#b45309">${esc(w)}</div>`).join('')}
        </div>`).join('') || '<div class="muted small">无可执行命令</div>';
      $('#bGo').disabled = !($('#bConfirm').checked && sel.length);
    }, 250);
  };
  div.querySelectorAll('.bchk').forEach((c) => c.onchange = refresh);
  $('#bConfirm').onchange = () => { $('#bGo').disabled = !($('#bConfirm').checked && ids().length); };
  $('#bClose').onclick = () => div.remove();
  $('#bCancel').onclick = () => div.remove();
  $('#bGo').onclick = async () => {
    $('#bGo').disabled = true;
    const r = await api(`/machines/${S.machineId}/disks/batch-format`, 'POST', { ids: ids(), cfg: S.cfg, confirm: true });
    if (r.error) { $('#bResult').textContent = '失败：' + r.error; $('#bGo').disabled = false; return; }
    $('#bResult').textContent = (r.results || []).map((x) => (x.ok ? '✔ ' + x.device + ' → 已启动 ' + x.jobId + '\n   ' + x.command : '✖ ' + x.device + ' ' + x.error)).join('\n');
    toast('批量任务已提交');
    if ((r.results || []).some((x) => x.ok)) watchJob(r.results.find((x) => x.ok).jobId, S.machineId);
    pollJobs();
  };
  refresh();
}
function renderDetail(d) {
  S.cfg = S.cfg[d.id] || { toolId: d.recommendedTool || '', mode: '', lunSize: d.lunSizeOverride || 512, customCommand: '' };
  const brandOpts = ['日立/HGST', '西数', '希捷', '东芝', '其他'].map((b) => `<option ${d.brand === b ? 'selected' : ''}>${b}</option>`).join('');
  const itOpts = ['SAS', 'SATA', 'NVMe', '其他'].map((b) => `<option ${d.interfaceType === b ? 'selected' : ''}>${b}</option>`).join('');
  const stOpts = ['有', '无', '未知'].map((b) => `<option ${d.defectStatus === b ? 'selected' : ''}>${b}</option>`).join('');
  $('#detail').className = 'detail';
  $('#detail').innerHTML = `
    <h2>${esc(d.device)} <span class="muted small">${esc(d.sizeText)}</span></h2>
    <div class="muted small">型号 ${esc(d.model || '-')} · 序列号 ${esc(d.serial || '-')} ${d.hasOverride ? '<span class="tag">已应用人工修正</span>' : ''}</div>

    <div class="sect">
      <div class="kv">
        <div class="k">自动识别品牌</div><div class="v">${esc(d.autoBrand)}</div>
        <div class="k">当前采用品牌</div><div class="v"><select id="eBrand">${brandOpts}</select></div>
        <div class="k">自动识别接口</div><div class="v">${esc(d.autoInterface)} <span class="muted small">(TRAN=${esc(d.tran || '-')})</span></div>
        <div class="k">当前采用接口</div><div class="v"><select id="eIt">${itOpts}</select></div>
        <div class="k">逻辑块大小</div><div class="v">${d.logicalBlockSize || '?'} B</div>
        <div class="k">物理块大小</div><div class="v">${d.physicalBlockSize || '?'} B ${d.format512e4kn ? '<span class="tag">' + d.format512e4kn + '</span>' : ''}</div>
        <div class="k">容量</div><div class="v">${esc(d.sizeText)}</div>
        <div class="k">SMART 健康</div><div class="v">${esc(d.smartHealth || '未知')}${d.healthPct != null ? ` <b style="color:${d.healthPct >= 80 ? '#16a34a' : d.healthPct >= 50 ? '#b45309' : '#dc2626'}">（健康度 ${d.healthPct}%）</b>` : ''}</div>
        ${(d.interfaceType || d.autoInterface) === 'SATA' ? [
          smartRow('05 重映射扇区数', d.smart05),
          smartRow('196 重映射事件数', d.smart196),
          smartRow('197 待映射扇区数', d.smart197),
          smartRow('198 脱机不可校正扇区', d.smart198),
          smartRow('199 UDMA CRC 错误数', d.smart199),
        ].join('') : ''}
        ${d.interfaceType === 'SAS' ? `<div class="k">G-list 值大小</div><div class="v">${d.gList == null ? '<span class="muted">读取失败</span>' : `<b style="color:${d.gList > 0 ? '#b45309' : '#16a34a'}">${d.gList}</b>`}</div>` : ''}
        <div class="k">是否系统盘</div><div class="v">${d.isSystemDisk ? '是' : '否'}</div>
        <div class="k">是否挂载</div><div class="v">${d.isMounted ? '已挂载 ' + esc((d.mounted || []).join(',')) : '未挂载'}</div>
      </div>
      <div class="row"><button class="btn small" id="btnSaveBI">保存品牌/接口修正</button><span class="muted small">按序列号持久化，人工修正优先</span></div>
    </div>

    <div class="sect">
      <h3>缺陷判断（${esc(d.defectMethod)}）：<b style="color:${d.defectStatus === '有' ? '#b45309' : d.defectStatus === '无' ? '#16a34a' : '#dc2626'}">${esc(d.defectStatus)}</b>
        ${d.defectSnapshot === 'before' ? '<span class="muted small">（该盘正在格式化，SMART 暂时读不到 → 显示格式化前的快照值）</span>' : ''}</h3>
      <div class="row">
        <button class="btn" id="btnDefect">⚠ 缺陷判断…</button>
        <b>${d.allowFormat ? '✔ 允许继续格式化' : '⛔ 禁止格式化'}</b>
        ${d.allowFormat ? '' : `<span class="muted small">${esc(d.blockReason)}</span>`}
      </div>
    </div>

    <div class="sect">
      <div class="row">
        <button class="btn primary" id="btnConfig">⚙ 格式化配置…</button>
        <span class="muted small" id="cfgPre"></span>
        <div class="spacer"></div>
        <button class="btn danger" id="btnFormat" ${d.allowFormat ? '' : 'disabled title="被规则拦截"'}>开始格式化</button>
      </div>
    </div>`;

  $('#btnDefect').onclick = () => openDefectConfig(d);
  /* 2026-09-20 静态测试清理：删掉了对某个 index.html 里并不存在的 id 的死引用（旧功能遗留） */
  $('#btnSaveBI').onclick = async () => {
    const r = await api(`/machines/${S.machineId}/disks/${encodeURIComponent(d.id)}/override`, 'PATCH', { brand: $('#eBrand').value, interfaceType: $('#eIt').value });
    if (r.error) return toast('❌ ' + r.error);
    S.sel = r; toast('品牌/接口修正已保存（按序列号持久化）'); loadDisks(false);
  };
  $('#btnConfig').onclick = () => openFmtConfig(d);
  $('#btnFormat').onclick = () => openConfirm(d);
  renderCfgSummary(d);
}


/* ---------- 缺陷判断弹窗（关闭 / 取消 / 保存人工修正）---------- */
function openDefectConfig(d) {
  const div = document.createElement('div');
  div.className = 'modal'; div.id = 'defectModal';
  const stOpts = ['有', '无', '未知'].map((x) => `<option ${d.defectStatus === x ? 'selected' : ''}>${x}</option>`).join('');
  const vals = Object.entries(d.defectValues || {}).map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${(v === null || v === undefined) ? '<span class="muted">读取失败</span>' : esc(v)}</div>`).join('');
  div.innerHTML = `<div class="dialog" style="width:640px">
    <div class="row"><h2 style="margin:0">⚠ 缺陷判断 · ${esc(d.device)}</h2><div class="spacer"></div><button class="btn" id="dfX">✕ 关闭</button></div>
    <div class="muted small">判断方式：<b>${esc(d.defectMethod)}</b> ｜ ${esc(d.brand)} · ${esc(d.interfaceType)} · SN ${esc(d.serial || '-')}</div>
    <div class="kv">
      <div class="k">自动识别缺陷状态</div><div class="v">${esc(d.autoDefectStatus)}</div>
      <div class="k">当前采用缺陷状态</div><div class="v"><select id="eDef">${stOpts}</select> <span class="muted small">人工修正优先于自动识别</span></div>
      ${vals}
    </div>
    ${d.defectReason ? `<div class="warnbox">${esc(d.defectReason)}</div>` : ''}
    <div class="row"><span class="muted small">当前结论：</span><b>${d.allowFormat ? '✔ 允许继续格式化' : '⛔ 禁止格式化'}</b>${d.allowFormat ? '' : `<span class="muted small">${esc(d.blockReason)}</span>`}</div>
    <div class="muted small">保存后按序列号持久化，下次插入同一块盘优先采用人工修正结果。</div>
    <div class="row right"><button class="btn" id="dfCancel">取消</button><button class="btn primary" id="dfSave">保存人工修正</button></div>
  </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  div.querySelector('#dfX').onclick = close;
  div.querySelector('#dfCancel').onclick = close;
  div.querySelector('#dfSave').onclick = async () => {
    const r = await api(`/machines/${S.machineId}/disks/${encodeURIComponent(d.id)}/override`, 'PATCH', { defectStatus: div.querySelector('#eDef').value });
    if (r.error) return toast('❌ ' + r.error);
    S.sel = r; close(); toast('缺陷判断人工修正已保存（按序列号持久化）'); loadDisks(false);
  };
}

/* ---------- 格式化配置弹窗（关闭 / 取消 / 保存）---------- */
function cfgSummaryText(d) {
  const c = S.cfg || {};
  const toolId = c.toolId || '';
  const toolName = toolId ? toolId : ('自动推荐（' + (d.recommendedTool || '无') + '）');
  return { tool: toolName, mode: c.mode || '默认', size: (Number(c.lunSize) || 512) + ' B' };
}
function renderCfgSummary(d) {
  /* 详情页已不再显示配置摘要（收进弹窗），这里保留空实现以便兼容 */
}
function openFmtConfig(d) {
  const snapshot = Object.assign({}, S.cfg);
  const div = document.createElement('div');
  div.className = 'modal'; div.id = 'fmtCfgModal';
  div.innerHTML = `<div class="dialog" style="width:760px">
    <div class="row"><h2 style="margin:0">⚙ 格式化配置 · ${esc(d.device)}</h2><div class="spacer"></div><button class="btn" id="fcX">✕ 关闭</button></div>
    <div class="muted small">只改变逻辑块大小，不涉及文件系统/分区表；${esc(d.brand)} · ${esc(d.interfaceType)} · ${esc(d.sizeText || '')}</div>
    <div class="muted small" id="fcCur" style="margin:6px 0">当前配置：—</div>
    <div class="kv">
      <div class="k">格式化工具</div><div class="v"><select id="cTool"><option value="">自动推荐（${esc(d.recommendedTool || '无')}）</option></select></div>
      <div class="k">格式化模式</div><div class="v"><select id="cMode"></select></div>
      <div class="k">格式化逻辑块大小</div><div class="v"><select id="cSize"><option>512</option><option>520</option><option>4096</option><option>4160</option></select>
        <input id="cSizeCustom" placeholder="或手动输入" style="max-width:130px;margin-left:6px"></div>
      <div class="k">是否保留数据</div><div class="v">否（格式化会擦除数据）</div>
    </div>
    <div class="cmdpreview"><div class="muted small">命令预览 <label class="small" style="margin-left:8px"><input type="checkbox" id="cmdManual"> 手动编辑命令（高级）</label></div>
      <pre id="cmdPreview">—</pre><textarea id="cmdEdit" class="hide" rows="3" style="width:100%;font-family:var(--mono)"></textarea>
      <div class="muted small" id="cmdCwd"></div><div class="muted small" id="cmdPre"></div></div>
    <div class="row">
      <select id="tplPick"><option value="">应用已存模板…</option></select><button class="btn" id="btnApplyTpl">应用模板</button>
      <button class="btn" id="btnSaveTpl">保存为模板</button>
    </div>
    <div class="row right"><button class="btn" id="fcCancel">取消</button><button class="btn primary" id="fcSave">保存</button></div>
  </div>`;
  document.body.appendChild(div);
  const _t = cfgSummaryText(d);
  div.querySelector('#fcCur').innerHTML = '当前配置：<b>' + esc(_t.tool) + '</b> ｜ <b>' + esc(_t.mode) + '</b> ｜ <b>' + esc(_t.size) + '</b>';

  const toolSel = div.querySelector('#cTool');
  api('/tools').then((r) => {
    (r.tools || []).forEach((t) => toolSel.insertAdjacentHTML('beforeend', `<option value="${t.id}">${esc(t.name)}（${esc(t.brand)} / ${esc(t.interfaceType)}）</option>`));
    if (S.cfg.toolId) toolSel.value = S.cfg.toolId;
    div.querySelector('#cSize').value = String(S.cfg.lunSize || 512);
    fillModes();
  });
  function fillModes() {
    const tid = toolSel.value || d.recommendedTool;
    api('/tools').then((r) => {
      const t = (r.tools || []).find((x) => x.id === tid);
      const ms = t ? Object.keys(t.modes) : ['默认'];
      div.querySelector('#cMode').innerHTML = ms.map((x) => `<option>${esc(x)}</option>`).join('');
      if (S.cfg.mode && ms.indexOf(S.cfg.mode) >= 0) div.querySelector('#cMode').value = S.cfg.mode;
      previewCmd();
    });
  }
  toolSel.onchange = fillModes;
  div.querySelector('#cMode').onchange = previewCmd;
  div.querySelector('#cSize').onchange = previewCmd;
  div.querySelector('#cSizeCustom').oninput = previewCmd;
  div.querySelector('#cmdManual').onchange = (e) => {
    const on = e.target.checked;
    div.querySelector('#cmdEdit').classList.toggle('hide', !on);
    div.querySelector('#cmdPreview').classList.toggle('hide', on);
    if (on) { div.querySelector('#cmdEdit').value = (div.querySelector('#cmdPreview').textContent || '').split('\n').filter((l) => l && !l.startsWith('#')).join('\n'); div.querySelector('#cmdEdit').focus(); }
    previewCmd();
  };
  div.querySelector('#cmdEdit').oninput = () => previewCmd();
  api('/templates').then((r) => {
    div.querySelector('#tplPick').innerHTML = '<option value="">应用已存模板…</option>' + (r.templates || []).map((t) => `<option value="${t.id}">${esc(t.brand || '*')}/${esc(t.interfaceType || '*')} · ${esc(t.toolId)} · ${esc(t.mode || '')} · ${t.lunSize}B</option>`).join('');
  });
  div.querySelector('#btnApplyTpl').onclick = () => {
    const id = div.querySelector('#tplPick').value;
    if (!id) return toast('先选一个模板');
    api('/templates').then((r) => {
      const t = (r.templates || []).find((x) => x.id === id);
      if (!t) return toast('模板不存在');
      div.querySelector('#cTool').value = t.toolId || '';
      fillModes();
      setTimeout(() => { div.querySelector('#cSize').value = String(t.lunSize || 512); previewCmd(); }, 300);
      toast('已套用模板（点「保存」生效）');
    });
  };
  div.querySelector('#btnSaveTpl').onclick = async () => {
    const r = await api('/templates', 'POST', { brand: d.brand, interfaceType: d.interfaceType, toolId: toolSel.value || d.recommendedTool, mode: div.querySelector('#cMode').value, lunSize: Number(div.querySelector('#cSize').value) });
    if (r.duplicated) return toast('ℹ️ ' + (r.error || '模板已存在，未重复添加'), 4500);
    if (r.error) return toast('❌ ' + r.error);
    toast('模板已保存（不含文件系统/分区表）');
  };
  const close = () => div.remove();
  const cancel = () => { S.cfg = snapshot; div.remove(); renderCfgSummary(d); toast('已取消（未保存修改）'); };
  div.querySelector('#fcX').onclick = cancel;
  div.querySelector('#fcCancel').onclick = cancel;
  div.querySelector('#fcSave').onclick = async () => {
    const manual = div.querySelector('#cmdManual').checked;
    S.cfg = Object.assign(S.cfg, {
      toolId: manual ? 'custom' : (toolSel.value || d.recommendedTool),
      mode: manual ? '自定义' : div.querySelector('#cMode').value,
      lunSize: Number(div.querySelector('#cSizeCustom').value || div.querySelector('#cSize').value) || 512,
      customCommand: manual ? div.querySelector('#cmdEdit').value : (S.cfg.customCommand || ''),
    });
    div.remove(); renderCfgSummary(d);
    toast('配置已保存：' + (S.cfg.toolId || '自动') + ' / ' + (S.cfg.mode || '默认') + ' / ' + S.cfg.lunSize + 'B', 4500);
  };
  fillModes();
}
async function previewCmd() {
  const d = S.sel; if (!d) return;
  const manual = $('#cmdManual') && $('#cmdManual').checked;
  const cfg = {
    toolId: manual ? 'custom' : ($('#cTool').value || d.recommendedTool),
    mode: manual ? '自定义' : $('#cMode').value,
    lunSize: Number($('#cSizeCustom').value || $('#cSize').value) || 512,
    customCommand: manual ? $('#cmdEdit').value : (S.cfg.customCommand || ''),
    manualEdit: !!manual,
  };
  S.cfg = Object.assign(S.cfg, cfg);
  const r = await api(`/machines/${S.machineId}/disks/${encodeURIComponent(d.id)}/preview`, 'POST', cfg);
  if (r.error) { $('#cmdPreview').textContent = r.error; return; }
  const rd = r.rendered;
  if (!manual) $('#cmdPreview').textContent = (rd.command || '') + (rd.supported === 'no' ? `\n⚠️ 该工具不支持逻辑块大小 ${rd.lunSize}B` : '') + (rd.note ? '\n# ' + rd.note : '');
  $('#cmdCwd').textContent = rd.cwd ? '执行目录：' + rd.cwd : '';
  const pf = r.preflight || { problems: [], warnings: [] };
  $('#cmdPre').innerHTML = (pf.ok ? '' : '<span style="color:#dc2626">✖ 禁止执行：' + esc(pf.problems.join('；')) + '</span><br>')
    + (pf.warnings || []).map((w) => '<span style="color:#b45309">⚠ ' + esc(w) + '</span>').join('<br>');
}

/* ---------------- 格式化确认 ---------------- */
function openConfirm(d) {
  const cfg = S.cfg;
  const r = api(`/machines/${S.machineId}/disks/${encodeURIComponent(d.id)}/preview`, 'POST', cfg);
  r.then((res) => {
    const rd = res.rendered || {};
    $('#confirmTable').innerHTML = [
      ['设备名', d.device], ['序列号', d.serial], ['容量', d.sizeText], ['品牌', d.brand], ['接口', d.interfaceType],
      ['格式化逻辑块大小', rd.lunSize + 'B'], ['工具', rd.toolName], ['模式', rd.mode], ['缺陷状态', d.defectStatus],
    ].map(([k, v]) => `<tr><td class="muted">${k}</td><td style="font-family:var(--mono)">${esc(v)}</td></tr>`).join('');
    $('#confirmCmd').textContent = rd.command || '';
    $('#confirmCwd').textContent = rd.cwd ? '工作目录：' + rd.cwd : '';
    $('#confirmWarn').className = 'warnbox' + (d.defectStatus === '未知' ? '' : ' hide');
    $('#confirmWarn').textContent = d.defectStatus === '未知' ? '⚠️ 该硬盘缺陷状态为「未知」，属于默认禁止场景，需人工确认覆盖。' : '';
    $('#confirmChk').checked = false; $('#confirmGo').disabled = true;
    $('#confirmModal').classList.remove('hide');
  });
}
$('#confirmChk').onchange = (e) => { $('#confirmGo').disabled = !e.target.checked; };
$('#confirmX').onclick = () => $('#confirmModal').classList.add('hide');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const m = $('#confirmModal'); if (m) m.classList.add('hide'); } });
$('#confirmCancel').onclick = () => $('#confirmModal').classList.add('hide');
$('#confirmGo').onclick = async () => {
  const d = S.sel;
  $('#confirmModal').classList.add('hide');
  const r = await api(`/machines/${S.machineId}/disks/${encodeURIComponent(d.id)}/format`, 'POST', Object.assign({}, S.cfg, { confirm: true }));
  if (r.error) return toast('失败：' + r.error);
  toast('任务已启动' + (r.job && r.job.dryRun ? '（dryRun 演示模式）' : ''));
  watchJob(r.job.id, S.machineId);
};
function watchJob(jobId, mid) {
  const jm = mid || S.machineId || 'local';
  if (S.jobES) S.jobES.close();
  const es = new EventSource(`/api/v1/machines/${jm}/jobs/${jobId}/stream?token=${encodeURIComponent(TOKEN)}`);
  S.jobES = es;
  es.onmessage = (ev) => {
    const o = JSON.parse(ev.data);
    if (o.type === 'log') { appendJobLog(o.line); return; }
    const st = o.state; if (!st || !st.id) return;
    $('#progressBox').className = 'progressbox';
    $('#progressBox').innerHTML = `
      <div><b>${esc(st.device)}</b> · ${esc(st.brand)} · 逻辑块大小 ${st.lunSize}B · ${esc(st.toolName)}</div>
      <div class="muted small">阶段：${esc(st.stage)} | 状态：${esc(st.status)} ${st.speed ? '| ' + esc(st.speed) : ''}</div>
      <div class="bar"><i style="width:${st.progress}%"></i></div>
      <div class="muted small">${st.progress}% | 已用 ${st.elapsedSec || 0}s${st.etaSec != null ? ' | 预计剩余 ' + st.etaSec + 's' : ''}
        ${st.status === '运行中' ? `<button class="btn small" id="btnStopJob" style="margin-left:8px">停止</button>` : ''}
        <button class="btn small" id="btnJobLog" style="margin-left:6px">下载完整日志</button></div>
      ${fmtDefectSnap('📋 格式化前缺陷', st.defectBefore)}
      ${fmtDefectSnap('📋 格式化后缺陷', st.defectAfter)}`;
    const bl = $('#btnJobLog');
    if (bl) bl.onclick = () => window.open(`/api/v1/machines/${jm}/jobs/${jobId}/log?token=${encodeURIComponent(TOKEN)}`, '_blank');
    const b = $('#btnStopJob');
    if (b) b.onclick = async () => {
      if (!(await askConfirm('停止格式化需二次确认，确认停止？'))) return;
      await api(`/machines/${S.machineId}/disks/${encodeURIComponent(S.sel.id)}/stop`, 'POST', { jobId });
      toast('已请求停止');
    };
    if (st.status !== '运行中' && st.logTail) { S.lastLog = st.logTail; renderJobLog(); if (st.status === '完成') { toast('✔ 格式化完成'); es.close(); loadDisks(true); } }
    if (st.status === '失败' || st.status === '已停止') { es.close(); loadDisks(true); }
  };
  es.onerror = () => {};
}
let jobLog = [];
let JOBS = [];
function appendJobLog(line) { jobLog.push(line); if (jobLog.length > 100) jobLog.shift(); renderJobLog(); }
function renderJobLog() { $('#liveLog').textContent = jobLog.join('\n') || '等待操作…'; $('#logCount').textContent = jobLog.length + ' 行'; }

/* ---------- 任务轮询：本机在格盘总览（含终端/脚本发起的）+ 选中盘进度 ---------- */
let FORMATTING = [];
async function pollJobs() {
  const mid = S.machineId || 'local';
  const r = await api(mid === 'local' ? '/formatting' : `/machines/${mid}/formatting`);
  if (r.error) return;
  FORMATTING = r.formatting || [];
  renderJobList();
  renderDiskProgress();
  loadAF();
}
function renderJobList() {
  const running = FORMATTING.filter((j) => (j.status || '') !== '排队');
  const queued = FORMATTING.filter((j) => (j.status || '') === '排队');
  $('#jobCount').textContent = running.length ? `${running.length} 个进行中` : '';
  if (!running.length) { $('#jobList').className = 'joblist muted small'; $('#jobList').textContent = '当前没有正在格式化的盘'; }
  else {
    $('#jobList').className = 'joblist';
    /* 2026-09-20 修复（用户指出）：全局暂停与单盘截停必须**联动显示**——
       ① 点了「暂停自动续格」→ 队列里每个单盘按钮都应跟着变成「▶ 恢复续格」（因为实际上都不会再续了）
       ② 但点单盘按钮**不能**反过来改全局按钮（单盘只影响那一块盘） */
    const afS = S.af || {};
    const afPaused = !!afS.paused;
    const afStops = afS.stopSerials || [];
    const afAllows = afS.allowSerials || [];
    $('#jobList').innerHTML = running.map((j) => {
      const inStop = !!(j.serial && afStops.indexOf(j.serial) >= 0);
      const inAllow = !!(j.serial && afAllows.indexOf(j.serial) >= 0);
      /* 全局暂停时：单盘的"续格"只看它是否被单独放行；未暂停时：只看它是否在 stopSerials */
      const continuing = afPaused ? inAllow : !inStop;
      const act = continuing ? (afPaused ? 'unallow' : 'add') : (afPaused ? 'allow' : 'remove');
      const label = continuing ? '⏹ 不再续格' : ('▶ 恢复续格' + (afPaused ? '（仅此盘）' : ''));
      const tip = afPaused
        ? (inAllow ? '已单独放行（忽略全局暂停）；点此取消放行' : '全局暂停中；点此只让这一块盘继续')
        : (inStop ? '这块盘已被标记不再续格，点此恢复' : '只影响这一块盘，不动全局设置');
      const tag = afPaused ? (inAllow ? '<span class="chip ok">已单独放行</span>' : '<span class="chip">全局暂停中</span>') : '';
      const btn = !j.serial ? '' : `<button class="btn small${continuing ? '' : ' danger'}" data-nostop="${esc(j.serial)}" data-dev="${esc(j.device)}" data-act="${act}" style="margin-left:6px" title="${tip}">${label}</button>`;
      return `
    <div class="jobrow on" data-dev="${esc(j.device)}" style="cursor:pointer">
      <div><b>${esc(j.device)}</b> <span class="muted small">${esc(j.brand || '')} ${esc(j.serial || '')}${j.lunSize ? ' · ' + j.lunSize + 'B' : ''}</span> <span class="chip warn">${esc(j.status || '运行中')}</span>${j.adopted ? '<span class="chip">重启接管</span>' : ''}${tag}</div>
      <div class="bar"><i style="width:${j.progress == null ? 100 : j.progress}%"></i></div>
      <div class="muted small">${esc(j.stage || '')}${j.progress != null ? ' · ' + j.progress + '%' : ''}${j.source === 'disk' ? ' · 外部命令发起' : ''}${j.round > 1 ? ' · 第' + j.round + '轮' : ''}
        ${btn}</div>
      ${fmtDefectSnap('📋 格前缺陷', j.defectBefore)}
      ${fmtDefectSnap('📋 格后缺陷', j.defectAfter)}
    </div>`;
    }).join('');
    $$('#jobList .btn[data-nostop]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); stopSerial(b.dataset.nostop, b.dataset.dev, b.dataset.act); });
    $$('#jobList .jobrow').forEach((el) => el.onclick = () => {
      const d = S.disks.find((x) => x.device === el.dataset.dev);
      if (d) { S.sel = d; renderDiskList(); renderDetail(d); renderDiskProgress(); }
    });
  }
  /* 排队队列 */
  const qh = document.getElementById('queueHead'), ql = document.getElementById('queueList');
  if (qh && ql) {
    if (queued.length) {
      qh.style.display = '';
      ql.className = 'joblist';
      ql.innerHTML = queued.map((j) => `<div class="jobrow" style="opacity:.85">
        <div><b>${esc(j.device)}</b> <span class="muted small">${esc(j.serial || '')}</span> <span class="chip">排队 #${j.queuePos || ''}</span></div>
        <div class="muted small">${esc(j.stage || '排队中')}${j.tool ? ' · ' + esc(j.tool) : ''}</div>
      </div>`).join('');
    } else { qh.style.display = 'none'; ql.innerHTML = ''; }
  }
}
function findFmt(d) {
  if (!d) return null;
  return FORMATTING.find((x) => x.device === d.device) || FORMATTING.find((x) => x.serial && x.serial === d.serial) || null;
}
/* 选中哪块盘就显示哪块盘的进度 */
function renderDiskProgress() {
  const d = S.sel, box = $('#progressBox');
  if (!d) { box.className = 'progressbox muted'; box.textContent = '← 左侧选择一块硬盘'; return; }
  const st = findFmt(d);
  if (!st) { box.className = 'progressbox muted'; box.innerHTML = `<b>${esc(d.device)}</b>（${esc(d.serial || '-')}）当前没有进行中的格式化`; return; }
  box.className = 'progressbox';
  box.innerHTML = `
    <div><b>${esc(st.device)}</b> · ${esc(st.brand || '')}${st.lunSize ? ' · 逻辑块大小 ' + st.lunSize + 'B' : ''}${st.tool ? ' · ' + esc(st.tool) : ''}</div>
    <div class="muted small">阶段：${esc(st.stage || '')} | 状态：${esc(st.status || '运行中')}</div>
    <div class="bar"><i style="width:${st.progress == null ? 100 : st.progress}%"></i></div>
    <div class="muted small">${st.progress == null ? '进度未知（外部命令发起，盘处于忙状态）' : st.progress + '%'}
      ${st.jobId ? `<button class="btn small" id="btnJobLog" style="margin-left:8px">下载完整日志</button>` : ''}</div>`;
  const b2 = document.getElementById('btnJobLog');   /* 2026-09-20 静态测试清理：去掉一个不存在的 id 死引用 */
  if (b2 && st.jobId) b2.onclick = () => window.open('/api/v1/machines/' + (S.machineId || 'local') + '/jobs/' + st.jobId + '/log?token=' + encodeURIComponent(TOKEN), '_blank');
}

/* ---------------- 命令行（多开/多标签） ---------------- */
function newTab(name) {
  const id = 'c_' + Math.random().toString(36).slice(2, 8);
  const t = { id, name: name || '终端 ' + (S.tabs.length + 1), buf: [] };
  S.tabs.push(t); activateTab(t.id);
  return t;
}
function activateTab(id) {
  S.activeTab = id;
  renderTabBars();
  const t = S.tabs.find((x) => x.id === id); if (!t) return;
  if (S.termES) S.termES.close();
  const tmid = S.termMachine || 'local';
  const url = tmid === 'local' ? `/api/v1/terminal/${id}/stream?token=${encodeURIComponent(TOKEN)}` : `/api/v1/machines/${tmid}/terminal/${id}/stream?token=${encodeURIComponent(TOKEN)}`;
  const es = new EventSource(url);
  S.termES = es;
  es.onmessage = (ev) => {
    const o = JSON.parse(ev.data);
    t.buf.push(stripAnsi(o.line));
    if (t.buf.length > 1000) t.buf.splice(0, t.buf.length - 1000);
    if (S.activeTab === id) paintTerm();
  };
  paintTerm();
  $('#termCwd').value = t.cwd || '';
}
function paintTerm() {
  const t = S.tabs.find((x) => x.id === S.activeTab); if (!t) return;
  const txt = t.buf.join('');
  for (const sel of ['#termOut', '#dockOut']) { const el = $(sel); if (el) el.textContent = txt; el.scrollTop = el.scrollHeight; }
  if (t.cwd) $('#termCwd').value = t.cwd;
}
function renderTabBars() {
  const html = S.tabs.map((t) => `<span class="ttab ${t.id === S.activeTab ? 'active' : ''}" data-id="${t.id}">${esc(t.name)} ✕</span>`).join('');
  $('#termTabBar').innerHTML = html;
  $('#dockTabs').innerHTML = html;
  $$('.ttab').forEach((el) => el.onclick = (e) => {
    const id = el.dataset.id;
    if (/✕/.test(e.target.textContent) && e.offsetX > el.offsetWidth - 18) { closeTab(id); return; }
    activateTab(id);
  });
}
function closeTab(id) {
  S.tabs = S.tabs.filter((t) => t.id !== id);
  if (S.activeTab === id) { S.activeTab = S.tabs[0] ? S.tabs[0].id : null; if (S.activeTab) activateTab(S.activeTab); }
  renderTabBars();
}
async function runCmd(cmd, inputEl) {
  if (!cmd.trim()) return;
  let t = S.tabs.find((x) => x.id === S.activeTab) || newTab();
  const cwd = $('#termCwd').value.trim();
  inputEl.value = '';
  const tmid = S.termMachine || 'local';
  const path = tmid === 'local' ? '/terminal/exec' : `/machines/${tmid}/terminal/exec`;
  const r = await api(path, 'POST', { sessionId: t.id, cmd, cwd: cwd || undefined });
  if (!t.hist) t.hist = [];
  if (t.hist[0] !== cmd) { t.hist.unshift(cmd); t.hist = t.hist.slice(0, 200); }
  inputEl._histIdx = undefined;
  if (r.error) toast(r.error);
  else if (r.blocked) toast('命令被拦截：' + r.blocked, 5000);
  else if (r.needConfirm) {
    if (await askConfirm('⚠ 该命令会改动/擦除硬盘数据，确认执行？\n\n' + cmd)) {
      const r2 = await api(path, 'POST', { sessionId: t.id, cmd, cwd: cwd || undefined, confirm: true });
      if (r2.error) toast(r2.error);
      else if (r2.blocked) toast('命令被拦截：' + r2.blocked, 5000);
    } else toast('已取消执行（未确认）');
  }
}
$('#btnNewTab').onclick = () => newTab();
$('#btnRun').onclick = () => runCmd($('#termInput').value, $('#termInput'));
$('#termInput').onkeydown = (e) => {
  if (histKey(e, $('#termInput'))) return;
  if (e.key === 'Enter') runCmd(e.target.value, e.target);
};
$('#dockInput').onkeydown = (e) => {
  if (histKey(e, $('#dockInput'))) return;
  if (e.key === 'Enter') runCmd(e.target.value, e.target);
};
/* 命令历史：↑/↓ 调用（第 5.1 章） */
function histKey(e, input) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  const t = S.tabs.find((x) => x.id === S.activeTab);
  const h = (t && t.hist) || [];
  if (!h.length) return false;
  const idxKey = '_histIdx';
  if (e.key === 'ArrowUp') input[idxKey] = Math.min(h.length - 1, (input[idxKey] === undefined ? -1 : input[idxKey]) + 1);
  else input[idxKey] = Math.max(-1, (input[idxKey] === undefined ? h.length : input[idxKey]) - 1);
  input.value = input[idxKey] === -1 ? '' : h[input[idxKey]];
  e.preventDefault();
  return true;
}
$('#btnTermStop').onclick = async () => { const t = S.tabs.find((x) => x.id === S.activeTab); if (t) { const tmid1 = S.termMachine || 'local'; await api(tmid1 === 'local' ? `/terminal/${t.id}/stop` : `/machines/${tmid1}/terminal/${t.id}/stop`, 'POST', {}); toast('已发送中断'); } };
$('#btnSetCwd').onclick = async () => {
  const t = S.tabs.find((x) => x.id === S.activeTab) || newTab();
  const tmid2 = S.termMachine || 'local';
  const r = await api(tmid2 === 'local' ? `/terminal/${t.id}/cwd` : `/machines/${tmid2}/terminal/${t.id}/cwd`, 'POST', { cwd: $('#termCwd').value.trim() });
  t.cwd = r.cwd; toast('工作目录：' + r.cwd);
};
$$('.quick').forEach((b) => b.onclick = () => { $('#termInput').value = b.dataset.cmd; $('#termInput').focus(); });
$('#dockRun').onclick = () => runCmd($('#dockInput').value, $('#dockInput'));
$('#dockToggle').onclick = (e) => {
  e.stopPropagation();
  const d = $('#dock'); d.classList.toggle('collapsed');
  $('#dockToggle').textContent = d.classList.contains('collapsed') ? '展开 ▲' : '收起 ▼';
};
$('#dockHead').onclick = () => $('#dockToggle').click();

/* ---------------- 日志 ---------------- */
async function loadLogs() {
  const r = await api('/logs?limit=200');
  $('#logRows').innerHTML = (r.logs || []).map((l) => {
    let detail = '';
    if (l.kind === 'format') detail = `${l.device} SN:${l.serial} ${l.brand} ${l.lunSize}B ${l.tool} ${l.dryRun ? '(dryRun)' : ''}<br><code>${esc(l.command)}</code>`;
    else if (l.kind === 'override') detail = `自动：${esc(JSON.stringify(l.auto))} → 人工：${esc(JSON.stringify(l.manual))}`;
    else detail = `<code>${esc(l.cmd || JSON.stringify(l.patch || ''))}</code>`;
    const typeMap = { format: '格式化', 'format-done': '格式化完成', 'format-stop': '格式化停止', terminal: '命令执行', 'terminal-dryrun': '命令(dryRun)', override: '人工修正', settings: '设置变更', 'tool-config': '工具配置' };
    return `<tr>
      <td class="muted small">${new Date(l.at).toLocaleString('zh-CN', { hour12: false })}</td>
      <td>${typeMap[l.kind] || esc(l.kind)}</td>
      <td class="small">${esc(l.device || l.serial || l.tool || '')}</td>
      <td>${l.exit === 0 ? '<span class="chip ok">成功</span>' : l.exit != null ? '<span class="chip bad">退出码 ' + l.exit + '</span>' : l.result === 'success' ? '<span class="chip ok">成功</span>' : ''}</td>
      <td class="small">${detail}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">暂无日志</td></tr>';
}
$('#btnLogsRefresh').onclick = loadLogs;
$('#btnLogsClear').onclick = async () => {
  const mode = $('#logClearMode').value;
  const msg = mode === 'archive' ? '确认把当前审计日志「归档」并清空列表？（旧日志会保留成文件）' : '确认「直接清空」审计日志？此操作不可恢复！';
  if (!(await askConfirm(msg))) return;
  const r = await api('/logs/clear', 'POST', { mode });
  if (r.error) return toast('❌ ' + r.error);
  toast(`已清理日志（${mode === 'archive' ? '归档' : '清空'}），释放 ${r.freedMB} MB`);
  loadLogs();
};
$('#btnLogsExport').onclick = async () => {
  const r = await api('/logs?limit=2000');
  const blob = new Blob([JSON.stringify(r.logs, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'audit-logs.json'; a.click();
};

/* ---------------- 设置 ---------------- */
async function loadSettings() {
  const s = await api('/settings');
  S.settings = s;
  $('#sPort').value = s.nodePort; $('#sLun').value = s.defaultLunSize; $('#sDry').checked = !!s.dryRun;
  $('#sSys').checked = !!s.protect.blockSystemDisk; $('#sMnt').checked = !!s.protect.blockMountedDisk; $('#sUnk').checked = !!s.protect.blockUnknown;
  $('#sHugo').value = s.toolPaths.hugo || ''; $('#sWdckit').value = s.toolPaths.wdckit || ''; $('#sSea').value = s.toolPaths.seachest || '';
  const bins = s.toolBins || {};
  $('#sHugoBin').value = bins.hugo || ''; $('#sWdckitBin').value = bins.wdckit || ''; $('#sSeaBin').value = bins.seachest || '';
  $('#sConfirm').checked = !!s.terminal.needConfirm; $('#sBlack').value = (s.terminal.blacklist || []).join(',');
  const c = s.clean || {};
  $('#cEnabled').checked = c.enabled !== false;
  setEvery('cN', 'cU', c.every, 30, 'minute');
  $('#cMode').value = c.mode || 'truncate';
  $('#cPatterns').value = (c.patterns || ['wdckit.txt', 'wdckit-trace.txt']).join(',');
  loadClean();
  updateDryBadge(s.dryRun);
  initUnitSelects();
  $('#syEnabled').checked = s.syncEnabled !== false;
  setEvery('syN', 'syU', s.syncEvery, 1, 'week');
  const dsk = s.disks || {};
  $('#drEnabled').checked = dsk.autoRefresh !== false;
  setEvery('drN', 'drU', dsk.every, 6, 'hour');
  const hpk = s.hotplug || {};
  $('#hpEnabled').checked = hpk.enabled !== false;
  setEvery('hpN', 'hpU', hpk.every, 5, 'second');
  $('#drInfo').innerHTML = '上次自动刷新：' + (dsk.lastAutoAt ? new Date(dsk.lastAutoAt).toLocaleString('zh-CN', { hour12: false }) : '—');
  api('/machines/sync').then((r) => { if (r && !r.error) $('#syInfo').innerHTML = `共 <b>${r.total}</b> 台｜上次同步：${r.lastSyncAt ? new Date(r.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '—'}｜自动同步：${r.enabled ? '开' : '关'}（${r.intervalSec}s）`; });
  const af = s.autoFormat || {};
  $('#afEnabled').checked = !!af.enabled;
  $('#afOnlyDefect').checked = af.onlyWithDefect !== false;
  setEvery('afN', 'afU', af.every, 1, 'minute');
  setEvery('afCN', 'afCU', af.cooldownEvery, 5, 'minute');
  $('#afLun').value = af.lunSize || '';
  $('#afInfo').innerHTML = af.enabled ? '<span style="color:#16a34a">已开启：每 ' + (af.intervalSec || 60) + 's 扫一次，新插入的有缺陷盘会自动排队格式化</span>' : '未开启（开启后：新插入的盘会被自动检测，<b>有缺陷记录</b>的盘自动排队格式化）';
  /* 版本同步 */
  const au = s.autoUpdate || {};
  if ($('#auEnabled')) {
    $('#auEnabled').checked = au.enabled !== false;
    $('#auIdle').checked = au.onlyWhenIdle !== false;
    const ve = au.every && au.every.n ? au.every : { n: 5, unit: 'minute' };
    $('#auN').value = ve.n; $('#auU').value = ve.unit;
    $('#auInfo').innerHTML = '主服务器：<b>' + esc(((s.syncSeeds || [])[0]) || '192.168.2.139') + '</b>'
      + ' ｜ 本地构建：<code>' + esc((S.health && S.health.build) || '-') + '</code>'
      + (au.lastMasterBuild ? ' ｜ 主服务器：<code>' + esc(au.lastMasterBuild) + '</code>' : '')
      + (au.lastCheck ? '<br>上次检查：' + new Date(au.lastCheck).toLocaleString('zh-CN', { hour12: false }) + ' → ' + esc(au.lastResult || '-') : '');
  }
  /* 高级设置（工具/会话/保护/清理/打印） */
  if ($('#sHugoPick')) {
    $('#sHugoPick').value = s.hugoPick || 'serial';
    $('#sSgConc').value = Number.isFinite(Number(s.sgConcurrency)) ? Number(s.sgConcurrency) : 0;
    if ($('#sSerialize')) $('#sSerialize').checked = s.serializeTools === true;
    if ($('#sRetryRun')) $('#sRetryRun').checked = s.retryAlreadyRun !== false;
    const ts = s.toolSession || {};
    $('#sSessOn').checked = ts.enabled !== false;
    $('#sSessIdle').value = Number.isFinite(Number(ts.idleQuitSec)) ? Number(ts.idleQuitSec) : 600;
    $('#sCmdTo').value = Number(s.cmdTimeoutSec) || 3600;
    $('#sMinPct').value = Number.isFinite(Number((s.protect || {}).minFreePct)) ? Number(s.protect.minFreePct) : 5;
    $('#sMinMB').value = Number.isFinite(Number((s.protect || {}).minFreeMB)) ? Number(s.protect.minFreeMB) : 2048;
    const cl = s.clean || {};
    $('#cSysLog').checked = cl.systemLogs !== false;
    $('#cSysMB').value = Number.isFinite(Number(cl.sysLogMaxMB)) ? Number(cl.sysLogMaxMB) : 512;
    $('#sLogKeep').value = Number.isFinite(Number(cl.jobLogKeep)) ? Number(cl.jobLogKeep) : 80;
    $('#sPrinter').value = s.printerName || 'HP_M1522nf';
    $('#sLabelDir').value = s.labelDir || '';
    api('/space').then((sp) => {
      if (sp && !sp.error) $('#advInfo').innerHTML = '当前盘：剩 <b>' + sp.freePct + '%</b> / ' + sp.freeMB + ' MB（低于阈值会暂停新任务）';
    });
    api('/ops/status').then((o) => {
      if (o && !o.error) $('#advInfo').innerHTML += ' ｜ 证书剩余 <b>' + (o.certDaysLeft == null ? '?' : o.certDaysLeft) + '</b> 天 ｜ 最近备份：' + esc(o.lastBackup || '无');
    });
  }
  const t = await api('/tools');
  $('#toolRows').innerHTML = t.tools.map((x) => `<tr>
    <td>${esc(x.name)}</td><td>${esc(x.brand)}</td><td>${esc(x.interfaceType)}</td>
    <td><code>${esc(Object.values(x.modes).join('<br>'))}</code></td>
    <td>${x.supports.length ? x.supports.join(' / ') : '—'}</td>
    <td class="small muted">${esc(x.note || '')}</td></tr>`).join('');
  await loadTemplates();
  await loadUsers();
}
async function loadUsers() {
  const q = ($('#uq') && $('#uq').value.trim()) || '';
  const role = ($('#uRoleFilter') && $('#uRoleFilter').value) || '';
  const r = await api(`/users?q=${encodeURIComponent(q)}&role=${encodeURIComponent(role)}`);
  if (!r.users) return;
  const me = r.current || (S.me && S.me.user);
  $('#userCount').textContent = `${r.users.length} / ${r.total} 个账号`;
  $('#userRows').innerHTML = r.users.map((u) => `<tr>
    <td>${esc(u.user)}${me === u.user ? ' <span class="chip">当前登录</span>' : ''}</td>
    <td>${esc(u.role)}</td>
    <td><button class="btn small" data-act="edit" data-u="${esc(u.user)}">编辑</button>
        ${me === u.user ? '<span class="muted small">—</span>' : `<button class="btn small" data-act="del" data-u="${esc(u.user)}">删除</button>`}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">没有匹配的账号</td></tr>';
  $$('#userRows .btn').forEach((b) => b.onclick = () => {
    if (b.dataset.act === 'edit') openUserEdit(b.dataset.u, r.users.find((x) => x.user === b.dataset.u));
    else openUserDelete(b.dataset.u);
  });
}
/* 改：弹窗编辑用户名 / 角色 / 重置密码 */
function openUserEdit(name, info) {
  const div = document.createElement('div');
  div.className = 'modal';
  div.innerHTML = `<div class="dialog" style="width:520px">
    <h2>编辑账号</h2>
    <label class="f">用户名 <input id="edName" value="${esc(name)}"></label>
    <label class="f">角色 <select id="edRole">
      <option value="viewer" ${info && info.role === 'viewer' ? 'selected' : ''}>viewer（只看）</option>
      <option value="operator" ${info && info.role === 'operator' ? 'selected' : ''}>operator（可格式化）</option>
      <option value="admin" ${info && info.role === 'admin' ? 'selected' : ''}>admin（全部）</option></select></label>
    <label class="f">重置密码（留空则不改） <input id="edPass" type="password" placeholder="≥４位"></label>
    <div class="row right"><button class="btn" id="edCancel">取消</button><button class="btn primary" id="edSave">保存</button></div>
    <div id="edMsg" class="warnbox hide"></div></div>`;
  document.body.appendChild(div);
  div.querySelector('#edCancel').onclick = () => div.remove();
  div.querySelector('#edSave').onclick = async () => {
    const body = { newUser: div.querySelector('#edName').value.trim(), role: div.querySelector('#edRole').value };
    const pw = div.querySelector('#edPass').value;
    if (pw) body.pass = pw;
    const r = await api(`/users/${encodeURIComponent(name)}`, 'PATCH', body);
    if (r.error) { div.querySelector('#edMsg').textContent = r.error; div.querySelector('#edMsg').classList.remove('hide'); return; }
    div.remove(); toast('已保存'); loadUsers();
  };
}
/* 删：二次确认 */
function openUserDelete(name) {
  const div = document.createElement('div');
  div.className = 'modal';
  div.innerHTML = `<div class="dialog" style="width:460px">
    <h2>删除账号</h2>
    <p>确认删除账号 <b>${esc(name)}</b> ？该账号将立即失效（已登录的凭证一并作废）。</p>
    <label class="check big"><input type="checkbox" id="delChk"> 我确认删除该账号</label>
    <div class="row right"><button class="btn" id="delCancel">取消</button>
      <button class="btn danger" id="delGo" disabled>删除</button></div>
    <div id="delMsg" class="warnbox hide"></div></div>`;
  document.body.appendChild(div);
  div.querySelector('#delChk').onchange = (e) => { div.querySelector('#delGo').disabled = !e.target.checked; };
  div.querySelector('#delCancel').onclick = () => div.remove();
  div.querySelector('#delGo').onclick = async () => {
    const r = await api(`/users/${encodeURIComponent(name)}`, 'DELETE');
    if (r.error) { div.querySelector('#delMsg').textContent = r.error; div.querySelector('#delMsg').classList.remove('hide'); return; }
    div.remove(); toast(`已删除账号 ${name}`); loadUsers();
  };
}
async function loadTemplates() {
  const r = await api('/templates');
  const list = r.templates || [];
  $('#tplRows').innerHTML = list.map((x) => `<tr>
    <td>${esc(x.brand || '-')}</td><td>${esc(x.interfaceType || '-')}</td><td>${esc(x.toolId || '-')}</td>
    <td>${esc(x.mode || '-')}</td><td>${x.lunSize || '-'} B</td>
    <td class="muted small">${x.at ? new Date(x.at).toLocaleString('zh-CN', { hour12: false }) : '-'}</td>
    <td><button class="btn small" data-act="use" data-id="${x.id}">应用到当前盘</button>
        <button class="btn small" data-act="del" data-id="${x.id}">删除</button></td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">暂无模板</td></tr>';
  $$('#tplRows .btn').forEach((b) => b.onclick = async () => {
    const id = b.dataset.id;
    const t = list.find((x) => x.id === id);
    if (b.dataset.act === 'del') {
      if (!(await askConfirm(`删除模板 ${t.toolId} / ${t.mode} / ${t.lunSize}B ？`))) return;
      await api(`/templates/${id}`, 'DELETE'); toast('已删除'); loadTemplates(); return;
    }
    if (!S.sel) return toast('先在硬盘页选一块盘');
    S.cfg = Object.assign(S.cfg, { toolId: t.toolId, mode: t.mode, lunSize: t.lunSize });
    renderDetail(S.sel); toast('已应用模板到当前盘');
  });
}
function updateDryBadge(dry) {
  $('#dryBadge').textContent = dry ? 'dryRun 演示' : '⚠ 真实执行';
  $('#dryBadge').className = 'badge ' + (dry ? 'warn' : 'ok');
}
$('#btnUserSearch').onclick = () => loadUsers();
$('#btnUserReset').onclick = () => { $('#uq').value = ''; $('#uRoleFilter').value = ''; loadUsers(); };
$('#uq').onkeydown = (e) => { if (e.key === 'Enter') loadUsers(); };
$('#uRoleFilter').onchange = () => loadUsers();
$('#btnAddUser').onclick = async () => {
  const r = await api('/users', 'POST', { user: $('#uName').value.trim(), pass: $('#uPass').value, role: $('#uRole').value });
  if (r.error) return toast(r.error);
  toast('账号已新增'); $('#uName').value = ''; $('#uPass').value = ''; loadUsers();
};
$('#btnChangePw').onclick = async () => {
  const r = await api('/password', 'POST', { old: $('#pwOld').value, new: $('#pwNew').value });
  if (r.error) return toast(r.error);
  toast('密码已修改'); $('#pwOld').value = ''; $('#pwNew').value = '';
};

/* ---------- 图形化目录选择器（设置页改工具路径用）---------- */
function pickInput(tool) { return tool === 'hugo' ? $('#sHugo') : tool === 'wdckit' ? $('#sWdckit') : $('#sSea'); }
function pickBinInput(tool) { return tool === 'hugo' ? $('#sHugoBin') : tool === 'wdckit' ? $('#sWdckitBin') : $('#sSeaBin'); }
async function openDirPicker(tool) {
  const cur = (pickInput(tool).value || '').trim();
  const start = cur || '';
  let curPath = start;
  const div = document.createElement('div');
  div.className = 'modal';
  div.innerHTML = `<div class="dialog" style="width:720px">
    <div class="row"><h2 style="margin:0">📁 选择 ${esc(tool)} 工具目录</h2><div class="spacer"></div><button class="btn" id="pkClose">✕ 关闭</button></div>
    <div class="row"><button class="btn small" id="pkUp">⬆ 上级</button><input id="pkPath" style="flex:1;font-family:var(--mono)" placeholder="/home/admin1/..."><button class="btn small" id="pkGo">前往</button></div>
    <div class="muted small" id="pkCand">候选：加载中…</div>
    <div id="pkList" class="joblist" style="max-height:46vh;overflow:auto">加载中…</div>
    <div class="row right"><button class="btn" id="pkCancel">取消</button><button class="btn primary" id="pkOk">✔ 选定此目录</button></div></div>`;
  document.body.appendChild(div);

  const load = async (pathStr) => {
    const r = await api('/fs/list' + (pathStr ? '?path=' + encodeURIComponent(pathStr) : ''));
    if (r.error) { $('#pkList').innerHTML = '<div class="muted small">' + esc(r.error) + '</div>'; return; }
    curPath = r.path;
    $('#pkPath').value = r.path;
    const rows = (r.dirs || []).map((d) => `<div class="jobrow" style="cursor:pointer" data-p="${esc(d.path)}">
        <div>${d.tool ? '⭐ ' : '📁 '}<b>${esc(d.name)}</b>
          ${d.tool ? `<span class="chip ok">${esc(d.tool)}</span>` : ''}
          ${d.bin ? `<span class="chip">含 ${esc(d.bin)}</span>` : ''}</div></div>`).join('');
    $('#pkList').innerHTML = (r.parent ? `<div class="jobrow" style="cursor:pointer" data-p="${esc(r.parent)}"><div>⬆ .. （上级目录）</div></div>` : '') + (rows || '<div class="muted small">（没有子目录）</div>');
    $$('#pkList .jobrow').forEach((el) => el.onclick = () => load(el.dataset.p));
  };

  /* 候选列表（自动检测到的、符合文档形式的目录） */
  api('/fs/candidates').then((r) => {
    const list = (r[tool] || []);
    $('#pkCand').innerHTML = list.length
      ? '检测到的候选（点一下直接选）：' + list.map((x) => `<button class="btn small" data-cp="${esc(x.path)}" data-cb="${esc(x.bin)}" style="margin-left:4px">${esc(x.path)}</button>`).join('')
      : '本机没有自动检测到符合文档形式的 ' + esc(tool) + ' 目录';
    $$('#pkCand .btn').forEach((b) => b.onclick = () => {
      pickInput(tool).value = b.dataset.cp; pickBinInput(tool).value = b.dataset.cb;
      div.remove(); toast('已选择：' + b.dataset.cp);
    });
  }).catch(() => {});

  $('#pkClose').onclick = () => div.remove();
  $('#pkCancel').onclick = () => div.remove();
  $('#pkUp').onclick = () => load(curPath ? curPath.replace(/\/[^\/]+\/?$/, '') || '/' : '/');
  $('#pkGo').onclick = () => load($('#pkPath').value.trim());
  $('#pkOk').onclick = () => {
    pickInput(tool).value = curPath + (curPath.endsWith('/') ? '' : '/');
    const guess = tool === 'hugo' ? 'hugo' : tool === 'wdckit' ? 'wdckit' : (pickBinInput(tool).value || '');
    if (guess) pickBinInput(tool).value = guess;
    div.remove(); toast('已选择目录：' + curPath);
  };
  load(start);
}
$$('[data-pick]').forEach((b) => b.onclick = () => openDirPicker(b.dataset.pick));

/* ---------- 周期字段（每 [n] [单位]）---------- */
const UNIT_LABEL = { second: '秒', minute: '分', hour: '时', day: '天', week: '周', month: '月', quarter: '季度', year: '年' };
const UNIT_SEC = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, quarter: 7776000, year: 31536000 };
function initUnitSelects() {
  $$('select.everyunit').forEach((sel) => {
    if (sel.options.length) return;
    sel.innerHTML = Object.keys(UNIT_LABEL).map((u) => `<option value="${u}">${UNIT_LABEL[u]}</option>`).join('');
  });
}
function setEvery(nId, uId, obj, defN, defU) {
  const o = obj && obj.n ? obj : { n: defN, unit: defU };
  $('#' + nId).value = o.n;
  $('#' + uId).value = o.unit || defU;
}
function getEvery(nId, uId, defN, defU) {
  const n = Number($('#' + nId).value) || defN;
  const unit = $('#' + uId).value || defU;
  return { n, unit, sec: n * (UNIT_SEC[unit] || 1) };
}

$('#btnDetectTools').onclick = async () => {
  $('#detectInfo').textContent = '检测中…';
  const r = await api('/tools/detect');
  if (r.error) { $('#detectInfo').textContent = r.error; return; }
  const s = r.detected || {};
  const miss = ['hugo', 'wdckit', 'seachest'].filter((k) => !s[k]);
  $('#detectInfo').innerHTML = '检测到：' + ['hugo', 'wdckit', 'seachest'].map((k) => `<b>${k}</b> ${s[k] || '<span style="color:#dc2626">未找到</span>'}`).join(' ｜ ');
  if (miss.length) toast('本机未找到：' + miss.join('、') + '（其余已应用）', 5000);
  const r2 = await api('/tools/detect', 'POST', {});
  if (r2.error) return toast('❌ ' + r2.error);
  toast('已自动应用本机工具路径');
  loadSettings();
};
$('#btnCleanNow').onclick = async () => {
  $('#cleanInfo').textContent = '清理中…';
  const r = await api('/clean/now', 'POST', {});
  if (r.error) { $('#cleanInfo').textContent = r.error; return; }
  $('#cleanInfo').innerHTML = `已清理 <b>${(r.files || []).length}</b> 个文件，释放 <b>${r.freedMB} MB</b>` + ((r.errors && r.errors.length) ? `（${r.errors.length} 个失败）` : '');
  toast(`清理完成：释放 ${r.freedMB} MB`);
  loadClean();
};
async function loadClean() {
  const r = await api('/clean');
  if (!r.settings) return;
  const c = r.settings;
  const list = (r.matched || []);
  const total = list.reduce((a, b) => a + (b.sizeMB || 0), 0);
  $('#cleanInfo').innerHTML = `命中 <b>${list.length}</b> 个文件，共 <b>${total.toFixed(2)} MB</b>`
    + (c.lastRun ? `｜上次清理 ${new Date(c.lastRun).toLocaleString('zh-CN', { hour12: false })}，释放 ${(c.lastFreed / 1048576).toFixed(2)} MB` : '')
    + (list.length ? '<br>' + list.slice(0, 3).map((f) => esc(f.path) + ' (' + f.sizeMB + 'MB)').join('<br>') : '');
}
$('#btnSaveSettings').onclick = async () => {
  const body = {
    nodePort: Number($('#sPort').value), defaultLunSize: Number($('#sLun').value), dryRun: $('#sDry').checked,
    toolPaths: { hugo: $('#sHugo').value, wdckit: $('#sWdckit').value, seachest: $('#sSea').value },
    toolBins: { hugo: $('#sHugoBin').value.trim(), wdckit: $('#sWdckitBin').value.trim(), seachest: $('#sSeaBin').value.trim() },
    terminal: { needConfirm: $('#sConfirm').checked, blacklist: $('#sBlack').value.split(',').map((x) => x.trim()).filter(Boolean) },
    clean: { enabled: $('#cEnabled').checked, every: getEvery('cN', 'cU', 30, 'minute'), mode: $('#cMode').value, patterns: $('#cPatterns').value.split(',').map((x) => x.trim()).filter(Boolean), systemLogs: $('#cSysLog') ? $('#cSysLog').checked : true, sysLogMaxMB: $('#cSysMB') ? (Number($('#cSysMB').value) || 512) : 512, jobLogKeep: $('#sLogKeep') ? (Number($('#sLogKeep').value) || 80) : 80 },
    syncEnabled: $('#syEnabled').checked, syncEvery: getEvery('syN', 'syU', 1, 'week'),
    disks: Object.assign({}, S.settings && S.settings.disks, { autoRefresh: $('#drEnabled').checked, every: getEvery('drN', 'drU', 6, 'hour') }),
    hotplug: { enabled: $('#hpEnabled').checked, every: getEvery('hpN', 'hpU', 5, 'second') },
    autoFormat: { enabled: $('#afEnabled').checked, onlyWithDefect: $('#afOnlyDefect').checked, every: getEvery('afN', 'afU', 1, 'minute'), cooldownEvery: getEvery('afCN', 'afCU', 5, 'minute'), lunSize: Number($('#afLun').value) || 0 },
    autoUpdate: { enabled: $('#auEnabled') ? $('#auEnabled').checked : true, onlyWhenIdle: $('#auIdle') ? $('#auIdle').checked : true, syncTime: $('#auTime') ? $('#auTime').checked : true, every: getEvery('auN', 'auU', 5, 'minute') },
    hugoPick: $('#sHugoPick') ? $('#sHugoPick').value : 'serial',
    sgConcurrency: $('#sSgConc') ? (Number($('#sSgConc').value) || 0) : 0,
    serializeTools: $('#sSerialize') ? $('#sSerialize').checked : false,
    retryAlreadyRun: $('#sRetryRun') ? $('#sRetryRun').checked : true,
    toolSession: { enabled: $('#sSessOn') ? $('#sSessOn').checked : true, idleQuitSec: $('#sSessIdle') ? (Number($('#sSessIdle').value) || 0) : 600 },
    cmdTimeoutSec: $('#sCmdTo') ? (Number($('#sCmdTo').value) || 3600) : 3600,
    printerName: $('#sPrinter') ? $('#sPrinter').value.trim() : 'HP_M1522nf',
    labelDir: $('#sLabelDir') ? $('#sLabelDir').value.trim() : '',
    protect: { blockSystemDisk: $('#sSys').checked, blockMountedDisk: $('#sMnt').checked, blockUnknown: $('#sUnk').checked },
  };
  const r = await api('/settings', 'PATCH', body);
  updateDryBadge(r.dryRun); $('#saveInfo').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  toast('设置已保存');
};
/* 版本同步：立即检查更新 */
const btnAu = $('#btnAuCheck');
if (btnAu) btnAu.onclick = async () => {
  $('#auResult').textContent = '检查中…';
  btnAu.disabled = true;
  const r = await api('/autoupdate/check', 'POST', {});
  btnAu.disabled = false;
  const txt = r.updated ? ('已更新：' + r.updated.from + ' → ' + r.updated.to + '（服务即将重启）')
    : r.upToDate ? '已是最新' : (r.error || r.skipped || '未知结果');
  $('#auResult').textContent = txt;
  toast('同步检查：' + txt);
  loadSettings();
};
/* 运维按钮：全部停止 / 备份 / 恢复 / 证书 */
async function opsCall(path, okMsg, confirmMsg) {
  if (confirmMsg && !(await askConfirm(confirmMsg))) return;
  const r = await api(path, 'POST', {});
  const el = document.getElementById('opsResult');
  const txt = r.error ? ('❌ ' + r.error) : (r.message || okMsg);
  if (el) el.textContent = txt;
  toast(txt);
  if (r && r.ok) loadSettings();
}
const _bs = document.getElementById('btnStopAll');
if (_bs) _bs.onclick = () => opsCall('/ops/stop-all', '已停止全部任务', '确认停止本机所有正在跑/排队的格式化任务？');
const _bb = document.getElementById('btnBackup');
if (_bb) _bb.onclick = () => opsCall('/ops/backup', '备份完成');
const _br = document.getElementById('btnRestore');
if (_br) _br.onclick = () => opsCall('/ops/restore', '已恢复最近备份', '确认用最近一次备份覆盖当前配置数据（settings/overrides/machines）？');
const _bc = document.getElementById('btnCert');
if (_bc) _bc.onclick = () => opsCall('/ops/cert', '证书检查/续期完成', '检查 HTTPS 自签证书，过期或快到期就重新生成？');
const _bp = document.getElementById('btnPurge');
if (_bp) _bp.onclick = () => opsCall('/ops/purge-logs', '已清空历史/日志', '确认清空审计日志和格式化历史（保留正在跑的任务日志）？');

/* 右栏三个区块：可折叠（状态记 localStorage） */
function initPanes() {
  const key = 'dw_panes';
  let st = {}; try { st = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
  $$('.pane').forEach((p) => {
    const id = p.dataset.pane || '';
    if (st[id]) p.classList.add('collapsed');
    const h = p.querySelector('.panehead');
    if (h) h.onclick = () => {
      p.classList.toggle('collapsed');
      st[id] = p.classList.contains('collapsed') ? 1 : 0;
      try { localStorage.setItem(key, JSON.stringify(st)); } catch (e) {}
    };
  });
}

/* ---------------- 盘位标签：生成预览 → 用户确认后再打印 ---------------- */
async function openLabelPreview(ids) {
  if (!ids || !ids.length) return toast('先选硬盘（左侧勾选或选中一块）');
  toast('正在生成标签…');
  const r = await api('/labels', 'POST', { ids });
  if (r.error || !r.files) return toast('❌ ' + (r.error || '生成失败'));
  const ok = r.files.filter((f) => f.file);
  const bad = r.files.filter((f) => f.error);
  if (!ok.length) return toast('❌ 生成失败：' + (bad[0] && bad[0].error ? bad[0].error : '未知'));
  const div = document.createElement('div');
  div.className = 'modal';
  div.innerHTML = `<div class="dialog" style="width:900px">
    <div class="row"><h2 style="margin:0">🏷 盘位标签预览（${ok.length} 张）</h2><div class="spacer"></div><button class="btn" id="lbX">✕ 关闭</button></div>
    <div class="muted small">⚠ 请先确认标签内容无误，再点「打印」（打印机会按 A4 纵向、顶满纸宽出图）</div>
    <div class="lbpreview">${ok.map((f) => `<div><img src="${f.url}?token=${encodeURIComponent(TOKEN)}" alt="label"><div class="muted small">${esc(f.device)} · SN ${esc(f.serial || '-')}</div></div>`).join('')}</div>
    ${bad.length ? `<div class="muted small" style="color:#b45309">有 ${bad.length} 张生成失败：${bad.map((b) => esc(b.device + ' ' + b.error)).join('；')}</div>` : ''}
    <div class="row right"><button class="btn" id="lbCancel">取消</button><button class="btn primary" id="lbPrint">🖨 打印这 ${ok.length} 张</button></div>
  </div>`;
  document.body.appendChild(div);
  const close = () => div.remove();
  div.querySelector('#lbX').onclick = close;
  div.querySelector('#lbCancel').onclick = close;
  div.querySelector('#lbPrint').onclick = async () => {
    if (!(await askConfirm(`确认打印这 ${ok.length} 张标签？`))) return;
    const rr = await api('/labels/print', 'POST', { files: ok.map((f) => f.file) });
    const done = (rr.results || []).filter((x) => x.ok).length;
    toast(done ? `已提交打印 ${done} 张` : '❌ 打印提交失败');
    close();
  };
}

/* ---------------- 格式化历史 ---------------- */
/* 格式化历史：刷新 / 导出 CSV / 清空历史（用户 2026-09-22 要求加「清空历史」按钮）
   注：原来这三个按钮的绑定写在“保存设置”的 onclick 里 → 不点保存就不生效，一并修正。 */
function wireHistButtons() {
  const bh = document.getElementById('btnHistRefresh');
  if (bh) bh.onclick = () => loadHistory();
  const bc = document.getElementById('btnHistCsv');
  if (bc) bc.onclick = () => window.open('/api/v1/machines/' + (S.machineId || 'local') + '/history.csv?token=' + encodeURIComponent(TOKEN), '_blank');
  const bcl = document.getElementById('btnHistClear');
  if (bcl) bcl.onclick = async () => {
    if (!(await askConfirm('确定清空「格式化历史」？清空后不可恢复（审计日志会留一条记录）。'))) return;
    const r = await api('/history/clear', 'POST', {});
    if (r.error) return toast('清空失败：' + r.error);
    toast('已清空 ' + (r.cleared || 0) + ' 条格式化历史');
    loadHistory();
  };
}
wireHistButtons();

async function loadHistory() {
  const tb = document.getElementById('histRows');
  if (!tb) return;
  const r = await api('/history?limit=200');
  const list = (r.history || []);
  if (document.getElementById('histInfo')) document.getElementById('histInfo').textContent = `共 ${r.total || list.length} 条，显示最近 ${list.length} 条`;
  tb.innerHTML = list.map((h) => `<tr>
    <td class="muted small">${new Date(h.at).toLocaleString('zh-CN', { hour12: false })}</td>
    <td>${esc(h.device)}</td>
    <td class="muted small">${esc(h.serial || '-')}</td>
    <td>${esc(h.brand || '-')}</td>
    <td>${esc(h.toolName || h.toolId || '-')}</td>
    <td>${esc(h.lunSize || '-')}</td>
    <td>${esc(h.round || 1)}</td>
    <td>${h.result === 'success' ? '<span class="chip ok">' + esc(h.status || '完成') + '</span>' : (h.result === 'fail' ? '<span class="chip bad">' + esc(h.status || '失败') + '</span>' : '<span class="chip">' + esc(h.status || '-') + '</span>')}</td>
    <td class="muted small">${h.elapsedSec != null ? h.elapsedSec + 's' : '-'}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="muted">暂无历史</td></tr>';
}

/* ---------------- 磁盘空间保护提示 ---------------- */
async function loadSpace() {
  const r = await api('/space');
  if (!r || r.error) return;
  if (!r.ok) toast('⛔ ' + (r.reason || '磁盘空间不足'), 8000);
}

/* ---------------- 启动 ---------------- */
async function boot() {
  initPanes();
  bindFilters();
  refreshBrandFilter();
  /* 已登录（localStorage 里有 token）就直接显示主页面，不再要求重新登录；没 token 才显示登录页 */
  if (TOKEN) hideLogin(); else showLogin();
  const h = await api('/health');
  S.health = h;
  fillLoginHost(h);
  toast(`服务已连接：${h.hostname} · ${h.ips.map((i) => i.ip).join(' / ')}:${h.port}`, 4000);
  updateDryBadge(h.dryRun);
  const ok = await loadMe();
  if (!ok) { showLogin(); } else { hideLogin(); }
  await loadMachines();
  await loadDisks(true);
  newTab('终端 1');
  pollJobs();
  setInterval(pollJobs, 4000);
  setInterval(async () => { const r = await api('/machines'); if (r.machines) { S.machines = r.machines; updateSvc(); } }, 20000);
}
$('#btnScan').onclick = async () => { toast('扫描中…'); await loadDisks(true); toast('扫描完成'); };
boot();
