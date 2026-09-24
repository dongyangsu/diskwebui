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
/* 多字段表单弹窗（2026-09-24）：一次弹出所有格子，每格预填当前值，改完保存 */
function askForm(title, fields, okText) {
  return new Promise((resolve) => {
    const m = $('#formModal');
    if (!m) { /* 兵底：无弹窗就逐项用原生 prompt */
      const out = {};
      for (const f of fields) {
        const v = window.prompt(f.label, f.value == null ? '' : String(f.value));
        if (v === null) return resolve(null);
        out[f.key] = v;
      }
      return resolve(out);
    }
    $('#formTitle').textContent = title || '编辑';
    const box = $('#formFields');
    box.innerHTML = '';
    for (const f of fields) {
      const lab = document.createElement('label');
      lab.className = 'f';
      lab.appendChild(document.createTextNode(f.label + ' '));
      const inp = document.createElement('input');
      inp.id = 'ff_' + f.key;
      inp.value = f.value == null ? '' : String(f.value);
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.readonly) inp.readOnly = true;
      lab.appendChild(inp);
      box.appendChild(lab);
    }
    $('#formGo').textContent = okText || '保存';
    const collect = () => { const o = {}; for (const f of fields) o[f.key] = $('#ff_' + f.key).value; return o; };
    const finish = (v) => { m.classList.add('hide'); m.onkeydown = null; resolve(v); };
    $('#formGo').onclick = () => finish(collect());
    $('#formNo').onclick = () => finish(null);
    m.onclick = (e) => { if (e.target === m) finish(null); };
    m.onkeydown = (e) => {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); finish(collect()); }
      else if (e.key === 'Escape') finish(null);
    };
    m.classList.remove('hide');
    const first = box.querySelector('input:not([readonly])') || box.querySelector('input');
    if (first) setTimeout(() => { try { first.focus(); first.select(); } catch (e) {} }, 30);
  });
}
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

const S = { machines: [], machineId: 'local', machineIps: {}, ipExpand: new Set(), sort: [], disks: [], sel: null, settings: null, cfg: {}, tabs: [], activeTab: null, jobES: null, termES: null, me: null, checked: new Set(), termMachine: 'local' };
try { S.sort = JSON.parse(localStorage.getItem('dw_sort') || '[]') || []; } catch (e) { S.sort = []; }

/* ================= 机器列表：排序/筛选/视图/选择/统计/导出（2026-09-24 全面版 v2） ================= */
const COLS = [
  { key: 'name', label: '名称', w: 170, filter: true },
  { key: 'ip', label: 'IP', w: 210, filter: true },
  { key: 'port', label: '端口', w: 70, filter: true },
  { key: 'rack', label: '机房/机架', w: 100, filter: true },
  { key: 'status', label: '状态', w: 90, filter: true },
  { key: 'lastCheck', label: '最后检测', w: 150, filter: false },
  { key: 'note', label: '备注', w: 180, filter: true }
];
const OPS_COL = { key: 'ops', label: '操作', w: 300, filter: false };
const SEL_COL = { key: '__sel', label: '', w: 38, filter: false };
const STATUS_RANK = { online: 0, unknown: 1, offline: 2 };
const STATUS_TEXT = { online: '在线', offline: '离线', unknown: '未知' };
const STATUS_RAW = { '在线': 'online', '离线': 'offline', '未知': 'unknown' };
const TBL_DEFAULT = {
  sort: [], opts: { collation: 'pinyin', caseSensitive: false, blanksLast: true },
  seq: {}, colOrder: COLS.map((c) => c.key), colW: {}, hidden: [], onlineFirst: false,
  filters: {}, q: '', chip: 'all', density: 'cozy', views: {}, defaultView: '', me: '', pageSize: 300, page: 1
};
S.tbl = JSON.parse(JSON.stringify(TBL_DEFAULT));
S.sel = new Set();
S.cursor = null;
try {
  const _l = JSON.parse(localStorage.getItem('dw_tbl') || 'null');
  if (_l) S.tbl = Object.assign(S.tbl, _l);
} catch (e) { S.tbl = JSON.parse(JSON.stringify(TBL_DEFAULT)); }

function colByKey(k) {
  if (k === 'ops') return OPS_COL;
  if (k === '__sel') return SEL_COL;
  return COLS.find((c) => c.key === k) || null;
}
function colOrderFull() {
  const o = (S.tbl.colOrder || []).map(colByKey).filter(Boolean);
  for (const c of COLS) if (o.indexOf(c) < 0) o.push(c);
  o.push(OPS_COL);
  return o;
}
function visibleCols() {
  return [SEL_COL].concat(colOrderFull().filter((c) => c.key === 'ops' || S.tbl.hidden.indexOf(c.key) < 0));
}
function colWidth(c) { return (S.tbl.colW && S.tbl.colW[c.key] ? S.tbl.colW[c.key] : (c.w || 120)) + 'px'; }

/* ---------- 偏好存取（服务端按用户 + 本地兜底） ---------- */
let _tblTimer = null;
function tblSnapshot() {
  return {
    sort: S.tbl.sort, opts: S.tbl.opts, seq: S.tbl.seq, colOrder: S.tbl.colOrder, colW: S.tbl.colW,
    hidden: S.tbl.hidden, onlineFirst: S.tbl.onlineFirst, filters: S.tbl.filters, q: S.tbl.q,
    chip: S.tbl.chip, density: S.tbl.density, views: S.tbl.views, defaultView: S.tbl.defaultView
  };
}
function persistTbl() {
  try { localStorage.setItem('dw_tbl', JSON.stringify(tblSnapshot())); } catch (e) {}
  clearTimeout(_tblTimer);
  _tblTimer = setTimeout(() => { api('/tableprefs', 'PUT', { mine: tblSnapshot() }).catch(() => {}); }, 600);
}
async function loadTblPrefs() {
  try {
    const r = await api('/tableprefs');
    if (r) {
      S.tbl.user = r.user || '';
      const src = r.mine || r.shared || null;
      if (src) {
        S.tbl = Object.assign(JSON.parse(JSON.stringify(TBL_DEFAULT)), src);
        try { localStorage.setItem('dw_tbl', JSON.stringify(tblSnapshot())); } catch (e) {}
      }
      if (src && src.defaultView && src.views && src.views[src.defaultView]) applyView(src.defaultView, false);
    }
  } catch (e) {}
}
function saveSharedTbl() { api('/tableprefs', 'PUT', { shared: tblSnapshot() }).then(() => toast('已把当前设置设为全站默认')).catch(() => {}); }

/* ---------- 取值 / 比较（类型化 + 自定义序列 + 空白置末） ---------- */
function ipToNum(s) { return String(s || '').split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0); }
function rawVal(m, key) {
  if (key === 'ip') return ipToNum(m.ip);
  if (key === 'port') return Number(m.port) || 0;
  if (key === 'lastCheck') return Number(m.lastCheck) || 0;
  if (key === 'status') return STATUS_RANK[m.status] === undefined ? 1 : STATUS_RANK[m.status];
  return String(m[key] === undefined || m[key] === null ? '' : m[key]);
}
function dispVal(m, key) {
  if (key === 'status') return STATUS_TEXT[m.status] || '未知';
  if (key === 'lastCheck') return m.lastCheck ? new Date(m.lastCheck).toLocaleString('zh-CN', { hour12: false }) : '';
  if (key === 'ip') return String(m.ip || '');
  return String(m[key] === undefined || m[key] === null ? '' : m[key]);
}
function isBlank(m, key) {
  if (key === 'lastCheck') return !m.lastCheck;
  if (key === 'ip' || key === 'port' || key === 'status') return false;
  return String(m[key] === undefined || m[key] === null ? '' : m[key]).trim() === '';
}
let _coll = null, _collKey = '';
function getCollator() {
  const o = S.tbl.opts || {};
  const key = (o.collation || 'none') + '|' + (o.caseSensitive ? 1 : 0);
  if (_coll && _collKey === key) return _coll;
  let loc = 'zh-Hans-CN';
  if (o.collation === 'pinyin') loc = 'zh-Hans-CN-u-co-pinyin';
  else if (o.collation === 'stroke') loc = 'zh-Hans-CN-u-co-stroke';
  try { _coll = new Intl.Collator(loc, { numeric: true, sensitivity: o.caseSensitive ? 'variant' : 'base' }); }
  catch (e) { _coll = new Intl.Collator('zh-Hans-CN', { numeric: true }); }
  _collKey = key;
  return _coll;
}
function cmpBy(a, b, s) {
  const o = S.tbl.opts || {};
  const ba = isBlank(a, s.key), bb = isBlank(b, s.key);
  if (o.blanksLast !== false) {
    if (ba && !bb) return 1;
    if (!ba && bb) return -1;
    if (ba && bb) return 0;
  }
  const seq = (S.tbl.seq || {})[s.key];
  if (seq && seq.length) {
    const sv = (m, k) => (k === 'status' ? String(m.status || '') : (k === 'lastCheck' ? String(m.lastCheck || '') : String(m[k] === undefined || m[k] === null ? '' : m[k]).trim()));
    const ia = seq.indexOf(sv(a, s.key));
    const ib = seq.indexOf(sv(b, s.key));
    const ra = ia < 0 ? seq.length + 1 : ia, rb = ib < 0 ? seq.length + 1 : ib;
    if (ra !== rb) return (ra - rb) * s.dir;
    return 0;
  }
  const va = rawVal(a, s.key), vb = rawVal(b, s.key);
  let r;
  if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
  else r = getCollator().compare(String(va), String(vb));
  return r * s.dir;
}

/* ---------- 筛选 / 搜索 / 视图数据 ---------- */
function chipMatch(m) {
  const c = S.tbl.chip || 'all';
  if (c === 'all') return true;
  if (c === 'local') return !!m.local;
  if (c === 'multiip') return ((S.machineIps && S.machineIps[m.id]) || m.ips || []).length > 1;
  return m.status === c;
}
function colFilterMatch(m) {
  const f = S.tbl.filters || {};
  for (const key of Object.keys(f)) {
    const allow = f[key];
    if (!allow || !allow.length) continue;
    const v = key === 'status' ? (STATUS_TEXT[m.status] || '未知') : String(dispVal(m, key));
    if (allow.indexOf(v) < 0) return false;
  }
  return true;
}
function qMatch(m) {
  const q = (S.tbl.q || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [m.name, m.ip, m.rack, m.note, STATUS_TEXT[m.status] || '', m.port].join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}
function filteredMachines() { return S.machines.filter((m) => chipMatch(m) && colFilterMatch(m) && qMatch(m)); }
function viewData() {
  const list = filteredMachines();
  if (S.tbl.onlineFirst) {
    list.sort((x, y) => (STATUS_RANK[x.status] === undefined ? 1 : STATUS_RANK[x.status]) - (STATUS_RANK[y.status] === undefined ? 1 : STATUS_RANK[y.status]));
  }
  if (!S.tbl.sort.length) return list;
  return list.map((m, i) => ({ m, i })).sort((x, y) => {
    for (const s of S.tbl.sort) { const r = cmpBy(x.m, y.m, s); if (r) return r; }
    return x.i - y.i;
  }).map((o) => o.m);
}
function hl(text) {
  const q = (S.tbl.q || '').trim();
  const s = esc(String(text === undefined || text === null ? '' : text));
  if (!q) return s;
  try { return s.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>'); }
  catch (e) { return s; }
}

/* ---------- 排序操作 ---------- */
function sortDesc() {
  return S.tbl.sort.map((s, i) => `${colByKey(s.key) ? colByKey(s.key).label : s.key}${s.dir === 1 ? ' ↑' : ' ↓'}${(S.tbl.seq || {})[s.key] ? '(自定义序列)' : ''}`).join(' → ');
}
function updateSortBar() {
  const bar = $('#sortBar');
  if (!bar) return;
  const bits = [];
  if (S.tbl.sort.length) bits.push('排序：' + sortDesc());
  if (S.tbl.chip && S.tbl.chip !== 'all') bits.push('快速筛选：' + ({ online: '在线', offline: '离线', unknown: '未知', local: '本机', multiip: '多IP' })[S.tbl.chip]);
  const fk = Object.keys(S.tbl.filters || {}).filter((k) => (S.tbl.filters[k] || []).length);
  if (fk.length) bits.push('列筛选：' + fk.map((k) => (colByKey(k) ? colByKey(k).label : k) + '×' + S.tbl.filters[k].length).join('、'));
  if (S.tbl.q) bits.push('搜索：“' + S.tbl.q + '”');
  if (S.tbl.onlineFirst) bits.push('置顶在线');
  bar.textContent = bits.length ? bits.join('　|　') : '未排序（点表头即可排序）';
  bar.style.color = bits.length ? 'var(--blue)' : '';
  const clr = $('#btnClearAll');
  if (clr) clr.classList.toggle('hide', bits.length === 0);
}
function setTblSort(list) { S.tbl.sort = list || []; S.tbl.page = 1; persistTbl(); renderMachineTable(); }
function toggleSort(key, additive) {
  const cur = S.tbl.sort.find((s) => s.key === key);
  if (additive) {
    if (!cur) return setTblSort(S.tbl.sort.concat([{ key, dir: 1 }]));
    return setTblSort(S.tbl.sort.map((s) => (s.key === key ? { key, dir: -s.dir } : s)));
  }
  if (!cur) setTblSort([{ key, dir: 1 }]);
  else if (S.tbl.sort.length === 1 && cur.dir === 1) setTblSort([{ key, dir: -1 }]);
  else if (S.tbl.sort.length === 1 && cur.dir === -1) setTblSort([]);
  else setTblSort(S.tbl.sort.map((s) => (s.key === key ? { key, dir: -s.dir } : s)));
}

/* ---------- IP 单元格（主 IP + N 个 IP 徽标 + 其余折叠，悬停小窗） ---------- */
function ipCell(m) {
  const cached = (S.machineIps && S.machineIps[m.id]) || m.ips || [];
  const ips = cached.length ? cached.slice() : [m.ip];
  if (m.ip && ips.indexOf(m.ip) < 0) ips.unshift(m.ip);
  const main = m.ip || ips[0];
  const extra = ips.filter((x) => x !== main);
  if (!extra.length) return `<span style="font-family:var(--mono)">${hl(main)}</span>`;
  const show = extra.slice(0, 1);
  const more = extra.length - show.length;
  let tail = show.map((x) => hl(x)).join(' ');
  if (more > 0) tail += ` <span class="chip">+${more}</span>`;
  const data = esc(ips.join(','));
  return `<span style="font-family:var(--mono)">${hl(main)}</span> <span class="chip" data-ippop="${data}">${ips.length} 个 IP</span>`
    + `<div class="muted small" data-ippop="${data}" style="line-height:1.3;cursor:help">+ ${tail}</div>`;
}
function showIpPop(el) {
  const pop = $('#ipPop');
  if (!pop) return;
  const ips = (el.dataset.ippop || '').split(',').filter(Boolean);
  if (!ips.length) return;
  pop.innerHTML = `<div class="t">该机器共 ${ips.length} 个 IP（点击复制）</div>` + ips.map((x) => `<div data-copy="${esc(x)}">${esc(x)}</div>`).join('');
  pop.classList.remove('hide');
  pop.style.pointerEvents = 'auto';
  const r = el.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h + 8 > window.innerHeight) top = Math.max(6, r.top - h - 6);
  pop.style.left = Math.max(6, left) + 'px';
  pop.style.top = Math.max(6, top) + 'px';
  $$('#ipPop [data-copy]').forEach((d) => d.onclick = () => { copyText(d.dataset.copy); toast('已复制 ' + d.dataset.copy); });
}
function hideIpPop() { const p = $('#ipPop'); if (p) p.classList.add('hide'); }

/* ---------- 单元格渲染 ---------- */
function cellHtml(m, key) {
  if (key === '__sel') return `<input type="checkbox" class="rowsel" data-id="${m.id}"${S.sel.has(m.id) ? ' checked' : ''}>`;
  if (key === 'name') return `${hl(m.name)}${m.local ? ' <span class="chip sys">本机</span>' : ''}`;
  if (key === 'ip') return ipCell(m);
  if (key === 'port') return hl(m.port === undefined || m.port === null ? '' : m.port);
  if (key === 'rack') return `<span class="muted small">${hl(m.rack || '')}</span>`;
  if (key === 'status') return `<span class="dot ${m.status === 'online' ? 'on' : m.status === 'offline' ? 'off' : ''}"></span> ${STATUS_TEXT[m.status] || '未知'}`;
  if (key === 'lastCheck') return `<span class="muted small">${hl(dispVal(m, 'lastCheck') || '-')}</span>`;
  if (key === 'note') return `<span class="muted small">${hl(m.note || '')}</span>`;
  if (key === 'ops') return `<button class="btn small" data-act="test" data-id="${m.id}">连接测试</button>
      <button class="btn small" data-act="open" data-id="${m.id}">打开页面</button>
      <button class="btn small" data-act="edit" data-id="${m.id}">编辑</button>`;
  return '';
}
function rowClass(m) {
  const c = ['mrow'];
  if (m.local) c.push('row-local');
  if (m.status === 'offline') c.push('row-offline');
  else if (m.status !== 'online') c.push('row-unknown');
  if (S.cursor === m.id) c.push('row-cursor');
  return c.join(' ');
}
function renderMachineTable() {
  renderMachineHead();
  const cols = visibleCols();
  const all = viewData();
  const size = S._printAll ? all.length : (Number(S.tbl.pageSize) > 0 ? Number(S.tbl.pageSize) : all.length);
  const pages = Math.max(1, Math.ceil(all.length / Math.max(1, size)));
  if (!S.tbl.page || S.tbl.page < 1) S.tbl.page = 1;
  if (S.tbl.page > pages) S.tbl.page = pages;
  const start = (S.tbl.page - 1) * size;
  const rows = all.slice(start, start + size);
  $('#machineRows').innerHTML = rows.map((m) => `<tr class="${rowClass(m)}" data-mid="${m.id}">${cols.map((c) => {
    if (c.key === 'ops') return `<td>${cellHtml(m, 'ops')}${m.local ? '' : ` <button class="btn small" data-act="del" data-id="${m.id}">删除</button>`}</td>`;
    return `<td style="width:${colWidth(c)}">${cellHtml(m, c.key)}</td>`;
  }).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted" style="text-align:center;padding:14px">没有符合条件的数据</td></tr>`;
  $$('#machineRows .btn').forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); machineAction(b.dataset.act, b.dataset.id); });
  $$('#machineRows [data-ippop]').forEach((el) => {
    el.onmouseenter = () => showIpPop(el);
    el.onmouseleave = () => { const p = $('#ipPop'); if (p && !p.matches(':hover')) hideIpPop(); };
  });
  $$('#machineRows .rowsel').forEach((c) => c.onclick = (ev) => {
    ev.stopPropagation();
    const id = c.dataset.id;
    if (c.checked) S.sel.add(id); else S.sel.delete(id);
    renderStats();
  });
  const selAllBox = $('#selAll');
  if (selAllBox) selAllBox.onclick = () => {
    if (selAllBox.checked) rows.forEach((m) => S.sel.add(m.id)); else rows.forEach((m) => S.sel.delete(m.id));
    renderMachineTable();
  };
  $$('#machineRows tr[data-mid]').forEach((tr) => {
    tr.onclick = () => { S.cursor = tr.dataset.mid; $$('#machineRows tr').forEach((x) => x.classList.toggle('row-cursor', x === tr)); renderStats(); };
    tr.ondblclick = () => machineAction('open', tr.dataset.mid);
  });
  renderStats();
  renderPager(all.length, pages, start, rows.length);
  updateSortBar();
  if (S._syncOnlineBtn) S._syncOnlineBtn();
  updateSvc();
}
function renderPager(total, pages, start, shown) {
  const el = $('#pager');
  if (!el) return;
  const size = Number(S.tbl.pageSize) > 0 ? Number(S.tbl.pageSize) : total;
  el.classList.toggle('hide', total <= size);
  if (total <= size) { el.innerHTML = ''; return; }
  el.innerHTML = `共 ${total} 条 · 第 ${S.tbl.page}/${pages} 页 · 本页显示 ${start + 1}-${start + shown}　
    <button class="btn small" data-pg="first">⏮ 首页</button>
    <button class="btn small" data-pg="prev">‹ 上一页</button>
    <button class="btn small" data-pg="next">下一页 ›</button>
    <button class="btn small" data-pg="last">尾页 ⏭</button>
    <span class="muted small">每页</span>
    <select id="pgSize" class="pg-sel">${[100, 200, 300, 500, 1000, 0].map((n) => `<option value="${n}"${Number(S.tbl.pageSize) === n ? ' selected' : ''}>${n === 0 ? '全部' : n}</option>`).join('')}</select>`;
  $$('#pager .btn').forEach((b) => b.onclick = () => {
    const a = b.dataset.pg;
    if (a === 'first') S.tbl.page = 1;
    else if (a === 'prev') S.tbl.page = Math.max(1, S.tbl.page - 1);
    else if (a === 'next') S.tbl.page = Math.min(pages, S.tbl.page + 1);
    else if (a === 'last') S.tbl.page = pages;
    const tw = $('.tablewrap'); if (tw) tw.scrollTop = 0;
    renderMachineTable();
  });
  const ps = $('#pgSize');
  if (ps) ps.onchange = () => { S.tbl.pageSize = Number(ps.value); S.tbl.page = 1; persistTbl(); renderMachineTable(); };
}
function renderStats() {
  const el = $('#tblStats');
  if (!el) return;
  const rows = viewData();
  const on = rows.filter((m) => m.status === 'online').length;
  const off = rows.filter((m) => m.status === 'offline').length;
  const un = rows.length - on - off;
  el.innerHTML = `共 <b>${S.machines.length}</b> 台 · 当前显示 <b>${rows.length}</b> · 在线 <b style="color:var(--green)">${on}</b> · 离线 <b style="color:var(--red)">${off}</b> · 未知 <b>${un}</b> ｜ 已选 <b>${S.sel.size}</b>`;
  const bb = $('#batchBar');
  if (bb) bb.classList.toggle('hide', S.sel.size === 0);
}

/* ---------- 表头（排序图标 / 筛选按钮 / 拖拽列序 / 拖拽列宽 / 右键菜单） ---------- */
function renderMachineHead() {
  const tr = $('#machineHead');
  if (!tr) return;
  tr.innerHTML = visibleCols().map((c) => {
    if (c.key === '__sel') return `<th class="selcol"><input type="checkbox" id="selAll" title="全选当前显示的机器"></th>`;
    const sortable = c.key !== 'ops';
    if (!sortable) return `<th data-colkey="ops" style="width:${colWidth(c)}">${c.label}</th>`;
    const idx = S.tbl.sort.findIndex((s) => s.key === c.key);
    const cur = idx >= 0 ? S.tbl.sort[idx] : null;
    const caret = `<span class="caret">${cur ? (cur.dir === 1 ? '▲' : '▼') : '⇅'}</span>`;
    const badge = (S.tbl.sort.length > 1 && idx >= 0) ? `<span class="chip" style="margin-left:2px">${idx + 1}</span>` : '';
    const fActive = (S.tbl.filters && S.tbl.filters[c.key] && S.tbl.filters[c.key].length) ? ' f-on' : '';
    const fbtn = c.filter ? `<button class="fbtn${fActive}" data-fbtn="${c.key}" title="筛选">▾</button>` : '<button class="sortmore" title="自定义排序">▾</button>';
    const tip = '单击排序（升→降→取消）；Shift+单击=追加次要条件；右键=更多';
    return `<th data-colkey="${c.key}" draggable="true" style="width:${colWidth(c)}" title="${tip}">${c.label}${badge}${caret}${fbtn}<span class="rz" data-rz="${c.key}"></span></th>`;
  }).join('');
  $$('#machineHead th[data-colkey]').forEach((th) => {
    const key = th.dataset.colkey;
    if (key === 'ops') return;
    th.onclick = (ev) => {
      if (ev.target && (ev.target.classList.contains('sortmore') || ev.target.classList.contains('fbtn') || ev.target.classList.contains('rz'))) return;
      toggleSort(key, ev.shiftKey);
    };
    th.oncontextmenu = (ev) => { ev.preventDefault(); openThMenu(ev, key); };
    const sm = th.querySelector('.sortmore');
    if (sm) sm.onclick = (ev) => { ev.stopPropagation(); openSortPop(sm); };
    const fb = th.querySelector('.fbtn');
    if (fb) fb.onclick = (ev) => { ev.stopPropagation(); openFilterPop(fb, key); };
    const rz = th.querySelector('.rz');
    if (rz) {
      rz.onmousedown = (ev) => startResize(ev, th, key);
      rz.ondblclick = (ev) => { ev.stopPropagation(); autoFitCol(th, key); };
      rz.onclick = (ev) => ev.stopPropagation();
    }
    th.ondragstart = (ev) => { ev.dataTransfer.setData('text/plain', key); S._dragCol = key; th.classList.add('dragging'); };
    th.ondragend = () => { S._dragCol = null; th.classList.remove('dragging'); };
    th.ondragover = (ev) => { if (!S._dragCol || S._dragCol === key) return; ev.preventDefault(); th.classList.add('dropbefore'); };
    th.ondragleave = () => th.classList.remove('dropbefore');
    th.ondrop = (ev) => {
      ev.preventDefault(); th.classList.remove('dropbefore');
      const from = S._dragCol; if (!from || from === key) return;
      const order = colOrderFull().map((c) => c.key).filter((k) => k !== 'ops' && k !== '__sel');
      const fi = order.indexOf(from), ti = order.indexOf(key);
      if (fi < 0 || ti < 0) return;
      order.splice(fi, 1); order.splice(ti, 0, from);
      S.tbl.colOrder = order; persistTbl(); renderMachineTable();
    };
  });
}
function startResize(ev, th, key) {
  ev.preventDefault();
  const startX = ev.clientX, startW = th.offsetWidth;
  const move = (e) => { th.style.width = Math.max(50, startW + (e.clientX - startX)) + 'px'; };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    S.tbl.colW[key] = parseInt(th.style.width, 10) || th.offsetWidth;
    persistTbl();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
function autoFitCol(th, key) {
  const tbl = $('#machineTable');
  if (!tbl) return;
  let max = th.scrollWidth;
  tbl.querySelectorAll('tbody tr').forEach((r, i) => {
    const cell = r.children[i];
    if (!cell || !cell.innerText) return;
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(cell).font;
    span.textContent = cell.innerText;
    document.body.appendChild(span);
    const w = span.offsetWidth + 26;
    span.remove();
    if (w > max) max = w;
  });
  S.tbl.colW[key] = Math.min(600, Math.max(50, Math.round(max)));
  persistTbl(); renderMachineTable();
}

/* ---------- 表头右键菜单 ---------- */
function openThMenu(ev, key) {
  const menu = $('#thMenu');
  if (!menu) return;
  const label = colByKey(key) ? colByKey(key).label : key;
  menu.innerHTML = `<div data-act="asc">${esc(label)}：升序 ↑</div>
    <div data-act="desc">${esc(label)}：降序 ↓</div>
    <div data-act="add">追加为次要条件</div>
    <div class="sep"></div>
    <div data-act="filter">筛选该列…</div>
    <div data-act="custom">自定义排序…</div>
    <div data-act="clear">清除排序</div>
    <div data-act="clearall">清除全部排序与筛选</div>`;
  menu.classList.remove('hide');
  menu.style.left = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
  $$('#thMenu div[data-act]').forEach((d) => d.onclick = () => {
    const a = d.dataset.act; menu.classList.add('hide');
    if (a === 'asc') setTblSort([{ key, dir: 1 }]);
    else if (a === 'desc') setTblSort([{ key, dir: -1 }]);
    else if (a === 'add') setTblSort(S.tbl.sort.concat([{ key, dir: 1 }]));
    else if (a === 'filter') openFilterPop($('#machineHead .fbtn[data-fbtn="' + key + '"]'), key);
    else if (a === 'custom') openSortPop($('#machineHead th[data-colkey="' + key + '"] .sortmore'));
    else if (a === 'clear') setTblSort([]);
    else if (a === 'clearall') clearAll();
  });
}
document.addEventListener('click', (e) => {
  const m = $('#thMenu');
  if (m && !m.classList.contains('hide') && !m.contains(e.target)) m.classList.add('hide');
});

/* ---------- 自定义排序弹窗 ---------- */
function sortRowHtml(level, s) {
  const names = ['主要关键字', '次要关键字', '第三关键字', '第四关键字', '第五关键字', '第六关键字', '第七关键字'];
  const seq = (S.tbl.seq || {})[s.key] || [];
  const shown = seq.map((v) => (s.key === 'status' ? (STATUS_TEXT[v] || v) : v));
  return `<div class="sp-row" data-lv="${level}">
    <span class="lb">${names[level] || '条件' + (level + 1)}</span>
    <select class="sp-key">${COLS.map((c) => `<option value="${c.key}"${c.key === s.key ? ' selected' : ''}>${c.label}</option>`).join('')}</select>
    <select class="sp-dir"><option value="1"${s.dir === 1 ? ' selected' : ''}>升序</option><option value="-1"${s.dir === -1 ? ' selected' : ''}>降序</option></select>
    <input class="sp-seq" placeholder="自定义序列(可选)" value="${esc(shown.join(','))}" title="逗号分隔，按此顺序排；未列出的排最后。状态可填：在线,离线,未知">
    <button class="btn small sp-del" title="删除该条件">✕</button>
  </div>`;
}
function syncSortOptsToUi() {
  const o = S.tbl.opts || {};
  if ($('#spCollation')) $('#spCollation').value = o.collation || 'pinyin';
  if ($('#spCase')) $('#spCase').checked = !!o.caseSensitive;
  if ($('#spBlank')) $('#spBlank').checked = o.blanksLast !== false;
}
function renderSortRows(list) {
  $('#spRows').innerHTML = list.map((s, i) => sortRowHtml(i, s)).join('');
  $$('#spRows .sp-del').forEach((b) => b.onclick = () => {
    const cur = collectSortPop();
    cur.splice(Number(b.closest('.sp-row').dataset.lv), 1);
    renderSortRows(cur);
  });
}
function collectSortPop() {
  const out = [];
  $$('#spRows .sp-row').forEach((row) => {
    const key = row.querySelector('.sp-key').value;
    out.push({ key, dir: Number(row.querySelector('.sp-dir').value) || 1 });
    const seqTxt = (row.querySelector('.sp-seq') || {}).value || '';
    let seq = seqTxt.split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
    if (key === 'status') seq = seq.map((x) => STATUS_RAW[x] || x);
    S.tbl.seq = S.tbl.seq || {};
    if (seq.length) S.tbl.seq[key] = seq; else delete S.tbl.seq[key];
  });
  const o = S.tbl.opts || {};
  if ($('#spCollation')) o.collation = $('#spCollation').value;
  if ($('#spCase')) o.caseSensitive = $('#spCase').checked;
  if ($('#spBlank')) o.blanksLast = $('#spBlank').checked;
  S.tbl.opts = o;
  return out;
}
function openSortPop(anchor) {
  const pop = $('#sortPop');
  if (!pop) return;
  renderSortRows(S.tbl.sort.length ? S.tbl.sort : [{ key: 'name', dir: 1 }]);
  syncSortOptsToUi();
  pop.classList.remove('hide');
  const r = (anchor || $('#machineHead') || document.body).getBoundingClientRect();
  let left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  let top = r.bottom + 6;
  if (top + pop.offsetHeight + 8 > window.innerHeight) top = Math.max(8, r.top - pop.offsetHeight - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
}
(function bindSortPop() {
  const pop = $('#sortPop');
  if (!pop) return;
  $('#spAdd').onclick = () => {
    const cur = collectSortPop();
    if (cur.length >= COLS.length) return toast('最多 ' + COLS.length + ' 个条件');
    const used = cur.map((s) => s.key);
    const next = COLS.find((c) => used.indexOf(c.key) < 0) || COLS[0];
    cur.push({ key: next.key, dir: 1 });
    renderSortRows(cur);
  };
  $('#spOpt').onclick = () => { const b = $('#spOptBox'); if (b) b.classList.toggle('hide'); };
  $('#spClear').onclick = () => { pop.classList.add('hide'); setTblSort([]); toast('已清除排序'); };
  $('#spOk').onclick = () => { pop.classList.add('hide'); setTblSort(collectSortPop()); toast('排序已应用'); };
  document.addEventListener('click', (e) => {
    if (pop.classList.contains('hide')) return;
    if (pop.contains(e.target) || (e.target.closest && e.target.closest('.sortmore'))) return;
    pop.classList.add('hide');
  });
})();

/* ---------- 列筛选弹窗 ---------- */
function distinctValues(key) {
  const set = new Map();
  for (const m of S.machines) {
    const v = key === 'status' ? (STATUS_TEXT[m.status] || '未知') : String(dispVal(m, key));
    set.set(v, (set.get(v) || 0) + 1);
  }
  return Array.from(set.entries()).sort((a, b) => getCollator().compare(a[0], b[0]));
}
function openFilterPop(anchor, key) {
  const pop = $('#filterPop');
  if (!pop || !anchor) return;
  const cur = (S.tbl.filters || {})[key] || [];
  const vals = distinctValues(key);
  pop.dataset.key = key;
  pop.innerHTML = `<div class="sp-head">筛选：${esc(colByKey(key) ? colByKey(key).label : key)}</div>
    <input id="fpQ" class="fp-q" placeholder="搜索值…">
    <div class="fp-tools"><a id="fpAll">全选</a><a id="fpNone">清空</a><a id="fpInv">反选</a></div>
    <div class="fp-list" id="fpList">${vals.map(([v, n]) => `<label><input type="checkbox" class="fp-cb" value="${esc(v)}"${cur.length === 0 || cur.indexOf(v) >= 0 ? ' checked' : ''}> <span>${esc(v) || '(空)'}</span> <span class="muted small">(${n})</span></label>`).join('')}</div>
    <div class="sp-foot"><button class="btn small" id="fpClear">清除该列筛选</button><span class="spacer"></span><button class="btn small" id="fpCancel">取消</button><button class="btn small primary" id="fpOk">确定</button></div>`;
  pop.classList.remove('hide');
  const r = anchor.getBoundingClientRect();
  let left = Math.min(r.left - 60, window.innerWidth - pop.offsetWidth - 8);
  let top = r.bottom + 6;
  if (top + pop.offsetHeight + 8 > window.innerHeight) top = Math.max(8, r.top - pop.offsetHeight - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
  const cbs = () => $$('#fpList .fp-cb');
  $('#fpQ').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$('#fpList label').forEach((l) => { l.style.display = l.innerText.toLowerCase().indexOf(q) >= 0 ? '' : 'none'; });
  };
  $('#fpAll').onclick = () => cbs().forEach((c) => c.checked = true);
  $('#fpNone').onclick = () => cbs().forEach((c) => c.checked = false);
  $('#fpInv').onclick = () => cbs().forEach((c) => c.checked = !c.checked);
  $('#fpClear').onclick = () => { delete S.tbl.filters[key]; S.tbl.page = 1; pop.classList.add('hide'); persistTbl(); renderMachineTable(); toast('已清除该列筛选'); };
  $('#fpCancel').onclick = () => pop.classList.add('hide');
  $('#fpOk').onclick = () => {
    const all = cbs().length;
    const picked = cbs().filter((c) => c.checked).map((c) => c.value);
    S.tbl.filters = S.tbl.filters || {};
    if (picked.length === all) delete S.tbl.filters[key]; else S.tbl.filters[key] = picked;
    S.tbl.page = 1;
    pop.classList.add('hide'); persistTbl(); renderMachineTable();
    toast(picked.length === all ? '已清除该列筛选' : `筛选 ${colByKey(key).label}：${picked.length} 个值`);
  };
  document.addEventListener('click', function once(e) {
    if (pop.classList.contains('hide')) { document.removeEventListener('click', once); return; }
    if (pop.contains(e.target) || (e.target.closest && e.target.closest('.fbtn'))) return;
    pop.classList.add('hide');
    document.removeEventListener('click', once);
  });
}

/* ---------- 列表设置（列显隐 / 恢复默认） ---------- */
function openColPop(anchor) {
  const pop = $('#colPop');
  if (!pop) return;
  $('#colRows').innerHTML = COLS.map((c) => `<label class="f" style="display:block;margin-bottom:4px"><input type="checkbox" class="col-chk" value="${c.key}"${S.tbl.hidden.indexOf(c.key) < 0 ? ' checked' : ''}> ${c.label}</label>`).join('')
    + '<div class="muted small" style="margin-top:6px">拖动表头可换列序；拖边界改列宽；双击边界=自动宽度</div>';
  pop.classList.remove('hide');
  const r = (anchor || document.body).getBoundingClientRect();
  let left = Math.min(r.left - 200, window.innerWidth - pop.offsetWidth - 8);
  let top = r.bottom + 6;
  if (top + pop.offsetHeight + 8 > window.innerHeight) top = Math.max(8, r.top - pop.offsetHeight - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
}
(function bindColPop() {
  const pop = $('#colPop');
  if (!pop) return;
  $('#colOk').onclick = () => {
    const hidden = [];
    $$('#colRows .col-chk').forEach((c) => { if (!c.checked) hidden.push(c.value); });
    if (hidden.length >= COLS.length) { toast('至少要显示一列'); return; }
    S.tbl.hidden = hidden; pop.classList.add('hide'); persistTbl(); renderMachineTable();
  };
  $('#colReset').onclick = () => {
    S.tbl.hidden = []; S.tbl.colOrder = COLS.map((c) => c.key); S.tbl.colW = {};
    pop.classList.add('hide'); persistTbl(); renderMachineTable(); toast('已恢复默认列设置');
  };
  document.addEventListener('click', (e) => {
    if (pop.classList.contains('hide')) return;
    if (pop.contains(e.target) || (e.target.closest && e.target.closest('#btnCols'))) return;
    pop.classList.add('hide');
  });
})();

/* ---------- 视图（命名视图：排序+筛选+列布局+密度） ---------- */
function viewSnapshot() {
  const t = tblSnapshot();
  delete t.views; delete t.defaultView; delete t.user;   /* 视图快照不能包含 views 自身（否则循环引用 → JSON 序列化报错） */
  return t;
}
function applyView(name, doRender) {
  const v = (S.tbl.views || {})[name];
  if (!v) return toast('视图不存在');
  const clean = {};
  for (const k of ['sort', 'opts', 'seq', 'colOrder', 'colW', 'hidden', 'onlineFirst', 'filters', 'q', 'chip', 'density']) {
    if (v[k] !== undefined) clean[k] = JSON.parse(JSON.stringify(v[k]));
  }
  S.tbl = Object.assign(S.tbl, clean);
  if (doRender !== false) { persistTbl(); renderMachineTable(); toast('已应用视图：' + name); }
}
function openViewPop(anchor) {
  const pop = $('#viewPop');
  if (!pop) return;
  const names = Object.keys(S.tbl.views || {});
  pop.innerHTML = `<div class="sp-head">视图（排序+筛选+列布局 打包保存）</div>
    <div class="sp-row"><input id="vwName" placeholder="视图名称，如：只看在线" style="flex:1"><button class="btn small primary" id="vwSave">保存当前为新视图</button></div>
    <div class="sp-tip muted small">当前默认视图：${esc(S.tbl.defaultView || '（无）')}</div>
    <div class="fp-list">${names.length ? names.map((n) => `<div class="vw-row" data-n="${esc(n)}">
      <span style="flex:1">${esc(n)}${S.tbl.defaultView === n ? ' <span class="chip ok">默认</span>' : ''}</span>
      <button class="btn small" data-vw="apply">应用</button>
      <button class="btn small" data-vw="def">设为默认</button>
      <button class="btn small" data-vw="del">删除</button></div>`).join('') : '<div class="muted small">（还没有视图）</div>'}</div>
    <div class="sp-foot"><button class="btn small" id="vwShared">把当前设置设为全站默认</button><span class="spacer"></span><button class="btn small" id="vwClose">关闭</button></div>`;
  pop.classList.remove('hide');
  const r = (anchor || document.body).getBoundingClientRect();
  let left = Math.min(r.left - 240, window.innerWidth - pop.offsetWidth - 8);
  let top = r.bottom + 6;
  if (top + pop.offsetHeight + 8 > window.innerHeight) top = Math.max(8, r.top - pop.offsetHeight - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
  $('#vwSave').onclick = () => {
    const n = ($('#vwName').value || '').trim();
    if (!n) return toast('请填视图名称');
    S.tbl.views = S.tbl.views || {};
    S.tbl.views[n] = viewSnapshot();
    persistTbl(); openViewPop(anchor); toast('已保存视图：' + n); renderViewSelect();
  };
  $$('#viewPop .vw-row').forEach((row) => {
    const n = row.dataset.n;
    $$('#viewPop .vw-row[data-n="' + n + '"] button').forEach((b) => b.onclick = () => {
      const a = b.dataset.vw;
      if (a === 'apply') { applyView(n); pop.classList.add('hide'); }
      else if (a === 'def') { S.tbl.defaultView = n; persistTbl(); openViewPop(anchor); toast('已设为默认视图：' + n); }
      else if (a === 'del') { delete S.tbl.views[n]; if (S.tbl.defaultView === n) S.tbl.defaultView = ''; persistTbl(); openViewPop(anchor); toast('已删除视图：' + n); renderViewSelect(); }
    });
  });
  $('#vwShared').onclick = () => saveSharedTbl();
  $('#vwClose').onclick = () => pop.classList.add('hide');
  document.addEventListener('click', function once(e) {
    if (pop.classList.contains('hide')) { document.removeEventListener('click', once); return; }
    if (pop.contains(e.target) || (e.target.closest && e.target.closest('#btnViews'))) return;
    pop.classList.add('hide');
    document.removeEventListener('click', once);
  });
}
function renderViewSelect() {
  const sel = $('#viewSel');
  if (!sel) return;
  const names = Object.keys(S.tbl.views || {});
  sel.innerHTML = `<option value="">— 视图 —</option>` + names.map((n) => `<option value="${esc(n)}"${S.tbl.defaultView === n ? ' selected' : ''}>${esc(n)}</option>`).join('');
  sel.onchange = () => { if (sel.value) applyView(sel.value); };
}

/* ---------- 选择 / 批量 / 剪贴板 / 导出 ---------- */
function copyText(t) {
  try { navigator.clipboard.writeText(t); return true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove(); return true;
  }
}
function selectedMachines() { return viewData().filter((m) => S.sel.has(m.id)); }
function exportCsv() {
  const rows = viewData();
  const head = ['名称', 'IP', '端口', '机房/机架', '状态', '最后检测', '备注'];
  const lines = [head.join(',')];
  for (const m of rows) {
    lines.push([m.name, m.ip, m.port, m.rack || '', STATUS_TEXT[m.status] || '未知', dispVal(m, 'lastCheck'), m.note || '']
      .map((x) => '"' + String(x).replace(/"/g, '""') + '"').join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '机器列表_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  toast('已导出 CSV（' + rows.length + ' 行，按当前排序与筛选）');
}
function copyTsv() {
  const list = S.sel.size ? selectedMachines() : viewData();
  const head = ['名称', 'IP', '端口', '机房/机架', '状态', '最后检测', '备注'];
  const lines = [head.join('\t')];
  for (const m of list) lines.push([m.name, m.ip, m.port, m.rack || '', STATUS_TEXT[m.status] || '未知', dispVal(m, 'lastCheck'), m.note || ''].join('\t'));
  copyText(lines.join('\n'));
  toast('已复制 ' + list.length + ' 行（可直接粘进 Excel）');
}
function clearAll() {
  S.tbl.sort = []; S.tbl.filters = {}; S.tbl.q = ''; S.tbl.chip = 'all'; S.tbl.onlineFirst = false; S.tbl.page = 1;
  if ($('#tblQ')) $('#tblQ').value = '';
  $$('.chip-btn').forEach((c) => c.classList.toggle('primary', c.dataset.chip === 'all'));
  persistTbl(); renderMachineTable(); toast('已清除排序与筛选');
}

/* ---------- 工具栏 / 键盘绑定 ---------- */
(function bindToolbar() {
  const ob = $('#btnOnlineFirst');
  if (ob) {
    const sync = () => { ob.classList.toggle('primary', !!S.tbl.onlineFirst); ob.textContent = S.tbl.onlineFirst ? '置顶在线 ✓' : '置顶在线'; };
    S._syncOnlineBtn = sync; sync();
    ob.onclick = () => { S.tbl.onlineFirst = !S.tbl.onlineFirst; persistTbl(); sync(); renderMachineTable(); };
  }
  const cb = $('#btnCols'); if (cb) cb.onclick = () => openColPop(cb);
  const eb = $('#btnCsv'); if (eb) eb.onclick = exportCsv;
  const tb = $('#btnTsv'); if (tb) tb.onclick = copyTsv;
  const vb = $('#btnViews'); if (vb) vb.onclick = () => openViewPop(vb);
  const vsel = $('#viewSel'); if (vsel) renderViewSelect();
  const q = $('#tblQ');
  if (q) {
    q.value = S.tbl.q || '';
    let t = null;
    q.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.tbl.q = q.value; S.tbl.page = 1; persistTbl(); renderMachineTable(); }, 220); };
  }
  $$('.chip-btn').forEach((c) => {
    c.classList.toggle('primary', (S.tbl.chip || 'all') === c.dataset.chip);
    c.onclick = () => {
      S.tbl.chip = c.dataset.chip;
      S.tbl.page = 1;
      $$('.chip-btn').forEach((x) => x.classList.toggle('primary', x === c));
      persistTbl(); renderMachineTable();
    };
  });
  const db = $('#btnDensity');
  if (db) {
    const sync = () => { db.textContent = (S.tbl.density === 'compact') ? '密度：紧凑' : '密度：舒适'; };
    sync();
    db.onclick = () => { S.tbl.density = (S.tbl.density === 'compact') ? 'cozy' : 'compact'; sync(); persistTbl(); applyDensity(); };
  }
  const bc = $('#btnBatchTest'); if (bc) bc.onclick = batchTest;
  const bd = $('#btnBatchDel'); if (bd) bd.onclick = batchDelete;
  const bs = $('#btnBatchSel'); if (bs) bs.onclick = () => { S.sel.clear(); renderMachineTable(); };
  const ca = $('#btnClearAll'); if (ca) ca.onclick = clearAll;
  applyDensity();
})();
function applyDensity() {
  const t = $('#machineTable');
  if (t) t.classList.toggle('compact', S.tbl.density === 'compact');
}
async function batchTest() {
  const list = selectedMachines();
  if (!list.length) return toast('先勾选机器');
  toast('批量连接测试中…（' + list.length + ' 台）');
  let on = 0, off = 0;
  for (const m of list) {
    const r = await api('/machines/' + m.id + '/test', 'POST', {}).catch(() => null);
    if (r && r.online) on++; else off++;
  }
  await loadMachines();
  toast(`批量测试完成：在线 ${on}，失败/离线 ${off}`);
}
async function batchDelete() {
  const list = selectedMachines();
  if (!list.length) return toast('先勾选机器');
  if (!(await askConfirm(`确认从列表移除选中的 ${list.length} 台机器？仅移除记录，不影响目标机器。`))) return;
  for (const m of list) await api('/machines/' + m.id, 'DELETE').catch(() => {});
  S.sel.clear(); await loadMachines(); toast('已移除 ' + list.length + ' 台');
}
document.addEventListener('keydown', (e) => {
  const view = $('#view-machines');
  if (!view || !view.classList.contains('active')) return;
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const rows = viewData();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    let i = rows.findIndex((m) => m.id === S.cursor);
    i = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i <= 0 ? 0 : i - 1);
    S.cursor = rows[i >= 0 ? i : 0].id;
    const size = Number(S.tbl.pageSize) > 0 ? Number(S.tbl.pageSize) : rows.length;
    const wantPage = Math.floor((i >= 0 ? i : 0) / size) + 1;
    if (wantPage !== S.tbl.page) S.tbl.page = wantPage;
    renderMachineTable();
  } else if (e.key === 'Enter' && S.cursor) {
    machineAction('open', S.cursor);
  } else if (e.key === ' ' && S.cursor) {
    e.preventDefault();
    if (S.sel.has(S.cursor)) S.sel.delete(S.cursor); else S.sel.add(S.cursor);
    renderMachineTable();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    copyTsv();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if ($('#tblQ')) $('#tblQ').focus();
  } else if (e.key === 'Escape') {
    clearAll();
  }
});

/* ================= 打印 / 导入导出（多格式；2026-09-24 v3） ================= */
function exportRows() {
  const scope = 'view';
  const rows = scope === 'all' ? S.machines.slice() : viewData();
  return rows;
}
function rowArrays(rows, allCols) {
  const useCols = allCols ? COLS.slice() : COLS.filter((c) => S.tbl.hidden.indexOf(c.key) < 0);
  const head = useCols.map((c) => c.label);
  const body = rows.map((m) => useCols.map((c) => {
    if (c.key === 'status') return STATUS_TEXT[m.status] || '未知';
    if (c.key === 'lastCheck') return dispVal(m, 'lastCheck');
    return dispVal(m, c.key);
  }));
  return { head, body };
}
function escXml(s) { return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function toCsv(a) { return a.map((r) => r.map((x) => '"' + String(x === undefined || x === null ? '' : x).replace(/"/g, '""') + '"').join(',')).join('\r\n'); }
function toTsv(a) { return a.map((r) => r.map((x) => String(x === undefined || x === null ? '' : x).replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n'); }
function toJson(rows, allCols) {
  const useCols = allCols ? COLS.slice() : COLS.filter((c) => S.tbl.hidden.indexOf(c.key) < 0);
  const arr = rows.map((m) => {
    const o = {};
    for (const c of useCols) o[c.key] = (c.key === 'status' ? (STATUS_TEXT[m.status] || '未知') : dispVal(m, c.key));
    o.id = m.id;
    o.online = m.status === 'online';
    return o;
  });
  return JSON.stringify({ exportedAt: new Date().toISOString(), count: arr.length, machines: arr }, null, 2);
}
function toYaml(rows, allCols) {
  const useCols = allCols ? COLS.slice() : COLS.filter((c) => S.tbl.hidden.indexOf(c.key) < 0);
  const q = (v) => {
    const s = String(v === undefined || v === null ? '' : v);
    return /[:#\-\[\]{},"'\n]/.test(s) || s === '' ? '"' + s.replace(/"/g, '\\"') + '"' : s;
  };
  const lines = ['# 机器列表导出 ' + new Date().toLocaleString('zh-CN', { hour12: false }), 'machines:'];
  for (const m of rows) {
    lines.push('  - id: ' + q(m.id));
    for (const c of useCols) lines.push('    ' + c.key + ': ' + q(c.key === 'status' ? (STATUS_TEXT[m.status] || '未知') : dispVal(m, c.key)));
  }
  return lines.join('\n');
}
function toXml(rows, allCols) {
  const { head, body } = rowArrays(rows, allCols);
  const keys = (allCols ? COLS.slice() : COLS.filter((c) => S.tbl.hidden.indexOf(c.key) < 0)).map((c) => c.key);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<machines count="' + rows.length + '">'];
  body.forEach((r, i) => {
    out.push('  <machine id="' + escXml(rows[i].id) + '">');
    r.forEach((v, j) => out.push('    <' + keys[j] + '>' + escXml(v) + '</' + keys[j] + '>'));
    out.push('  </machine>');
  });
  out.push('</machines>');
  return out.join('\n');
}
function toHtml(rows, allCols) {
  const { head, body } = rowArrays(rows, allCols);
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>机器列表</title>' +
    '<style>body{font-family:"Microsoft YaHei",sans-serif;font-size:13px}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 8px}th{background:#f0f0f0}</style></head><body>' +
    '<h3>机器列表（' + rows.length + ' 台）　' + new Date().toLocaleString('zh-CN', { hour12: false }) + '</h3>' +
    '<table><thead><tr>' + head.map((h) => '<th>' + escXml(h) + '</th>').join('') + '</tr></thead><tbody>' +
    body.map((r) => '<tr>' + r.map((v) => '<td>' + escXml(v) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></body></html>';
}
function toMd(rows, allCols) {
  const { head, body } = rowArrays(rows, allCols);
  return ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |']
    .concat(body.map((r) => '| ' + r.map((v) => String(v).replace(/\|/g, '\\|')).join(' | ') + ' |')).join('\n');
}
function toTxt(rows, allCols) {
  const { head, body } = rowArrays(rows, allCols);
  const w = head.map((h, i) => Math.max(h.length * 2, ...body.map((r) => String(r[i] || '').length)));
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  return [head.map((h, i) => pad(h, w[i])).join('  ')].concat(body.map((r) => r.map((v, i) => pad(v, w[i])).join('  '))).join('\n');
}
function fmtText(fmt, rows, allCols) {
  const { head, body } = rowArrays(rows, allCols);
  if (fmt === 'csv') return toCsv([head].concat(body));
  if (fmt === 'tsv') return toTsv([head].concat(body));
  if (fmt === 'json') return toJson(rows, allCols);
  if (fmt === 'yaml') return toYaml(rows, allCols);
  if (fmt === 'xml') return toXml(rows, allCols);
  if (fmt === 'html') return toHtml(rows, allCols);
  if (fmt === 'xls') return toHtml(rows, allCols);
  if (fmt === 'md') return toMd(rows, allCols);
  return toTxt(rows, allCols);
}
function download(name, text, mime) {
  const blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
function exportNow() {
  const fmt = $('#dpFmt').value, scope = $('#dpScope').value, allCols = $('#dpCols').value === 'all';
  let rows = scope === 'all' ? S.machines.slice() : (scope === 'sel' ? selectedMachines() : viewData());
  if (!rows.length) return toast('没有可导出的行');
  const text = fmtText(fmt, rows, allCols);
  const ext = { csv: 'csv', tsv: 'tsv', json: 'json', yaml: 'yaml', xml: 'xml', html: 'html', xls: 'xls', md: 'md', txt: 'txt' }[fmt] || 'txt';
  const mime = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', yaml: 'text/yaml', xml: 'application/xml', html: 'text/html', xls: 'application/vnd.ms-excel', md: 'text/markdown', txt: 'text/plain' }[fmt];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  download('机器列表_' + stamp + '.' + ext, text, mime);
  toast('已导出 ' + rows.length + ' 台为 ' + fmt.toUpperCase());
}
function previewExport() {
  const fmt = $('#dpFmt').value, scope = $('#dpScope').value, allCols = $('#dpCols').value === 'all';
  const rows = scope === 'all' ? S.machines.slice() : (scope === 'sel' ? selectedMachines() : viewData());
  const el = $('#dpPrev');
  if (!el) return;
  const text = fmtText(fmt, rows, allCols);
  el.textContent = text.split('\n').slice(0, 8).join('\n') + (text.split('\n').length > 8 ? '\n…（共 ' + text.split('\n').length + ' 行）' : '');
  const pv = $('#dpPreview');
  if (pv) pv.textContent = rows.length + ' 台 · ' + text.length + ' 字符';
}
/* ---------- 导入解析（自动识别格式） ---------- */
function normIp(s) { return String(s || '').trim(); }
const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
function parseYamlLite(text) {
  const recs = []; let cur = null;
  const clean = (s) => String(s || '').replace(/^["']|["']$/g, '').trim();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t || t.charAt(0) === '#') continue;
    const mItem = line.match(/^\s*-\s*(.*)$/);
    if (mItem) {
      if (cur) recs.push(cur);
      cur = {};
      const kv = mItem[1].match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (kv && cur) cur[kv[1].toLowerCase()] = clean(kv[2]);
      continue;
    }
    if (cur && /^\s+\S/.test(line)) {
      const kv = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (kv) cur[kv[1].toLowerCase()] = clean(kv[2]);
    }
  }
  if (cur) recs.push(cur);
  return recs;
}
function parseImport(text) {
  const out = [], bad = [];
  const t = String(text || '').trim();
  if (!t) return { items: out, bad: bad };
  /* YAML（形如 - ip: 1.2.3.4 换行 name: xx） */
  if (/(^|\n)\s*-\s/.test(t) && /(^|\s)ip\s*:/i.test(t)) {
    for (const r of parseYamlLite(t)) {
      const ip = normIp(r.ip || r.address || '');
      if (!IP_RE.test(ip)) { bad.push(String(r.ip || JSON.stringify(r)).slice(0, 40)); continue; }
      out.push({ ip: ip, name: r.name || r['名称'] || ip, port: Number(r.port || r['端口']) || 8090, rack: r.rack || r['机架'] || '', note: r.note || r['备注'] || '' });
    }
    return { items: out, bad: bad };
  }
  if (/^[\[{]/.test(t)) {
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : (j.machines || []);
      for (const r of arr) {
        const ip = normIp(r.ip || r.IP || r.address);
        if (!IP_RE.test(ip)) { bad.push(JSON.stringify(r).slice(0, 40)); continue; }
        out.push({ ip: ip, name: r.name || r.名称 || ip, port: Number(r.port || r.端口) || 8090, rack: r.rack || r.机架 || '', note: r.note || r.备注 || '' });
      }
      return { items: out, bad: bad };
    } catch (e) { /* 落到文本解析 */ }
  }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let delim = null;
  if (lines.some((l) => l.indexOf('\t') >= 0)) delim = '\t';
  else if (lines.some((l) => l.indexOf(',') >= 0)) delim = ',';
  else if (lines.some((l) => /[;；]/.test(l))) delim = ';';
  let cellsOf = (l) => delim ? l.split(delim).map((x) => x.trim().replace(/^"|"$/g, '')) : l.split(/\s+/).map((x) => x.trim());
  let header = null;
  const first = cellsOf(lines[0] || '');
  const looksHeader = first.some((c) => /^(ip|ip地址|地址|name|名称|port|端口|rack|机架|note|备注)$/i.test(c));
  if (looksHeader) { header = first.map((c) => c.toLowerCase()); lines.shift(); }
  const idx = (names, def) => { if (!header) return def; for (const n of names) { const i = header.findIndex((h) => h === n || h.indexOf(n) === 0); if (i >= 0) return i; } return def; };
  const iIp = idx(['ip', 'ip地址', '地址'], header ? -1 : 0);
  const iName = idx(['name', '名称', '主机'], 0);
  const iPort = idx(['port', '端口'], -1);
  const iRack = idx(['rack', '机架', '机房'], -1);
  const iNote = idx(['note', '备注', '说明'], -1);
  for (const l of lines) {
    let cells = cellsOf(l);
    if (delim === null) {
      if (cells.length === 1) cells = l.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    }
    let ip = '', port = 8090;
    for (const c of cells) {
      const m = c.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?$/);
      if (m) { ip = m[1]; if (m[2]) port = Number(m[2]); break; }
    }
    if (!ip && iIp >= 0) { const m = String(cells[iIp] || '').match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?$/); if (m) { ip = m[1]; if (m[2]) port = Number(m[2]); } }
    if (!IP_RE.test(ip)) { bad.push(l.slice(0, 40)); continue; }
    out.push({
      ip: ip,
      name: (iName >= 0 && cells[iName] && !IP_RE.test(cells[iName])) ? cells[iName] : ip,
      port: iPort >= 0 && cells[iPort] ? (Number(cells[iPort]) || port) : port,
      rack: iRack >= 0 ? (cells[iRack] || '') : '',
      note: iNote >= 0 ? (cells[iNote] || '') : ''
    });
  }
  return { items: out, bad: bad };
}
let _impDraft = null;
function refreshImportPreview() {
  const txt = $('#dpText') ? $('#dpText').value : '';
  const r = parseImport(txt);
  _impDraft = r;
  const box = $('#dpInPrev');
  if (box) {
    const uniq = [], seen = new Set();
    for (const it of r.items) { if (!seen.has(it.ip)) { seen.add(it.ip); uniq.push(it); } }
    _impDraft.items = uniq;
    box.innerHTML = `解析出 <b>${uniq.length}</b> 台` + (r.bad.length ? `，无法识别 <b style="color:var(--red)">${r.bad.length}</b> 行` : '') +
      (uniq.length ? `<div class="muted small" style="margin-top:4px">${uniq.slice(0, 5).map((x) => esc(x.ip + (x.name !== x.ip ? '(' + x.name + ')' : ''))).join('、')}${uniq.length > 5 ? ' …' : ''}</div>` : '');
  }
}
async function doImport() {
  if (!_impDraft || !_impDraft.items.length) return toast('还没有可导入的数据');
  if (!(await askConfirm(`确认导入 ${_impDraft.items.length} 台机器到列表？`))) return;
  let ok = 0, skip = 0;
  for (const it of _impDraft.items) {
    const r = await api('/machines', 'POST', it).catch(() => null);
    if (r && !r.error) ok++; else skip++;
  }
  $('#dataPop').classList.add('hide');
  await loadMachines();
  toast(`导入完成：新增 ${ok} 台` + (skip ? `，跳过 ${skip} 台（重复或格式问题）` : ''));
}
function openDataPop(anchor) {
  const pop = $('#dataPop');
  if (!pop) return;
  pop.innerHTML = `<div class="sp-head">导入 / 导出 / 打印</div>
    <div class="sp-tip muted small">导出多种格式；导入自动识别 CSV / TSV / JSON / YAML / Excel 复制的内容</div>
    <div class="dp-tabs"><button class="btn small primary" data-tab="out">导出</button><button class="btn small" data-tab="in">导入</button><button class="btn small" data-tab="pr">打印</button></div>
    <div id="dpOut">
      <div class="sp-row"><span class="lb">格式</span><select id="dpFmt">
        <option value="csv">CSV（Excel 通用）</option>
        <option value="tsv">TSV（制表符）</option>
        <option value="xls">Excel 表格（.xls）</option>
        <option value="json">JSON</option>
        <option value="yaml">YAML</option>
        <option value="xml">XML</option>
        <option value="html">HTML 网页</option>
        <option value="md">Markdown</option>
        <option value="txt">纯文本对齐表</option>
      </select></div>
      <div class="sp-row"><span class="lb">范围</span><select id="dpScope">
        <option value="view">当前筛选/排序后的结果</option><option value="all">全部机器</option><option value="sel">仅选中的行</option>
      </select></div>
      <div class="sp-row"><span class="lb">列</span><select id="dpCols"><option value="vis">仅可见列</option><option value="all">全部列</option></select>
        <span class="spacer"></span><span id="dpPreview" class="muted small"></span></div>
      <div class="sp-foot"><button class="btn small primary" id="dpDl">下载文件</button><button class="btn small" id="dpCopy">复制到剪贴板</button></div>
      <pre id="dpPrev" class="dp-prev"></pre>
    </div>
    <div id="dpIn" class="hide">
      <textarea id="dpText" class="dp-text" rows="6" placeholder="粘贴内容，例如：&#10;192.168.2.201,机房A,机器A&#10;192.168.2.202&#10;或 CSV/TSV/JSON/YAML 带表头的数据"></textarea>
      <div class="sp-row"><input type="file" id="dpFile" accept=".csv,.tsv,.txt,.json,.yaml,.yml,.xls,.html"><button class="btn small" id="dpParse">解析预览</button></div>
      <div id="dpInPrev" class="muted small"></div>
      <div class="sp-foot"><button class="btn small primary" id="dpImportNow">导入这些机器</button><span class="spacer"></span><button class="btn small" id="dpSample">填示例</button></div>
    </div>
    <div id="dpPr" class="hide">
      <div class="sp-tip muted small">打印当前列表：只打印表格（含标题、时间、当前排序/筛选说明），不打印工具栏和按钮。</div>
      <div class="sp-row"><label class="f"><input type="checkbox" id="dpPrColor" checked> 保留状态底色（离线淡红/未知淡黄）</label></div>
      <div class="sp-foot"><button class="btn small primary" id="dpDoPrint">打印 / 打印预览</button></div>
    </div>`;
  pop.classList.remove('hide');
  const r = (anchor || document.body).getBoundingClientRect();
  let left = Math.min(r.left - 320, window.innerWidth - pop.offsetWidth - 8);
  let top = r.bottom + 6;
  if (top + pop.offsetHeight + 8 > window.innerHeight) top = Math.max(8, r.top - pop.offsetHeight - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = top + 'px';
  const setTab = (t) => {
    $$('#dataPop .dp-tabs button').forEach((b) => b.classList.toggle('primary', b.dataset.tab === t));
    $$('#dataPop #dpOut,#dataPop #dpIn,#dataPop #dpPr').forEach((d) => d.classList.add('hide'));
    ($('#dp' + (t === 'out' ? 'Out' : t === 'in' ? 'In' : 'Pr')) || document.body).classList.remove('hide');
    if (t === 'out') previewExport();
  };
  $$('#dataPop .dp-tabs button').forEach((b) => b.onclick = () => setTab(b.dataset.tab));
  ['#dpFmt', '#dpScope', '#dpCols'].forEach((s) => { const el = $(s); if (el) el.onchange = previewExport; });
  $('#dpDl').onclick = exportNow;
  $('#dpCopy').onclick = () => { copyText(fmtText($('#dpFmt').value, $('#dpScope').value === 'all' ? S.machines : ($('#dpScope').value === 'sel' ? selectedMachines() : viewData()), $('#dpCols').value === 'all')); toast('已复制到剪贴板'); };
  $('#dpText').oninput = () => { clearTimeout(_impDraft && _impDraft._t); refreshImportPreview(); };
  $('#dpParse').onclick = refreshImportPreview;
  $('#dpSample').onclick = () => { $('#dpText').value = 'name,ip,port,rack,note\n机房A机器1,192.168.2.201,8090,A-01,示例\n机房A机器2,192.168.2.202,8090,A-01,示例'; refreshImportPreview(); };
  $('#dpFile').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { $('#dpText').value = String(fr.result || ''); refreshImportPreview(); };
    fr.readAsText(f);
  };
  $('#dpImportNow').onclick = doImport;
  $('#dpDoPrint').onclick = () => { pop.classList.add('hide'); printTable($('#dpPrColor') && $('#dpPrColor').checked); };
  setTab('out');
  document.addEventListener('click', function once(e) {
    if (pop.classList.contains('hide')) { document.removeEventListener('click', once); return; }
    if (pop.contains(e.target) || (e.target.closest && e.target.closest('#btnData'))) return;
    pop.classList.add('hide');
    document.removeEventListener('click', once);
  });
}
/* ---------- 打印 ---------- */
function printTable(keepColor) {
  const rows = viewData();
  const cols = visibleCols().filter((c) => c.key !== '__sel');
  const headHtml = cols.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map((m) => `<tr class="${rowClass(m)}">` + cols.map((c) => `<td>${cellHtml(m, c.key)}</td>`).join('') + '</tr>').join('');
  let box = $('#printTableBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'printTableBox';
    box.className = 'print-only';
    const panel = $('#view-machines .panel');
    const anchor = $('#printHead');
    if (panel) panel.insertBefore(box, anchor ? anchor.nextSibling : panel.firstChild);
    else document.body.appendChild(box);
  }
  box.innerHTML = `<table class="tbl"><thead><tr>${headHtml}</tr></thead><tbody>${body}</tbody></table>`;
  const infoEl = $('#printHead');
  if (infoEl) {
    const fk = Object.keys(S.tbl.filters || {}).filter((k) => (S.tbl.filters[k] || []).length);
    const bits = [];
    if (S.tbl.sort.length) bits.push('排序：' + sortDesc());
    if (fk.length) bits.push('筛选：' + fk.map((k) => (colByKey(k) ? colByKey(k).label : k)).join('、'));
    if (S.tbl.q) bits.push('搜索：“' + S.tbl.q + '”');
    if (S.tbl.chip && S.tbl.chip !== 'all') bits.push('快速筛选：' + S.tbl.chip);
    infoEl.innerHTML = `<div class="ph-title">机器列表　（${rows.length} 台）</div>
      <div class="ph-sub">${new Date().toLocaleString('zh-CN', { hour12: false })}${bits.length ? '　' + esc(bits.join('　|　')) : ''}</div>`;
  }
  document.body.classList.toggle('print-nocolor', !keepColor);
  setTimeout(() => {
    window.print();
    setTimeout(() => document.body.classList.remove('print-nocolor'), 800);
  }, 60);
}
(function bindDataToolbar() {
  const b = $('#btnData'); if (b) b.onclick = () => openDataPop(b);
  const p = $('#btnPrint'); if (p) p.onclick = () => printTable(true);
})();

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
  if (!S._tblPrefsLoaded) { S._tblPrefsLoaded = true; try { await loadTblPrefs(); } catch (e) {} }
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
  renderMachineTable();
  loadMachineIps();
}
/* 每台机器的 IP 列表：后端并行探测（不阻塞列表），拿到后补渲染 */
async function loadMachineIps() {
  const r = await api('/machines/ips');
  if (r && r.ips) { S.machineIps = r.ips; renderMachineTable(); }
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
    /* 2026-09-24：改为一次性小表单（原来要依次回答 4 个 prompt，且没有机房/机架） */
    const v = await askForm('编辑机器 · ' + (m.name || m.ip), [
      { key: 'name', label: '名称', value: m.name || '', placeholder: '机器显示名称' },
      { key: 'ip', label: 'IP', value: m.ip || '', placeholder: '如 192.168.2.130' },
      { key: 'port', label: '端口', value: m.port || 8090 },
      { key: 'rack', label: '机房/机架', value: m.rack || '', placeholder: '如 A-01（可选）' },
      { key: 'note', label: '备注', value: m.note || '', placeholder: '备注（可选）' }
    ]);
    if (v === null) return;
    const r = await api(`/machines/${id}`, 'PATCH', { name: v.name.trim(), ip: v.ip.trim(), port: Number(v.port), rack: v.rack, note: v.note });
    if (r.error) return toast('❌ ' + r.error, 5000);
    toast('✔ 已保存'); loadMachines();
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
  if (!TOKEN) { showLogin(); return; }   /* 没 token：直接到登录页，不再发任何需鉴权的请求（401 噪音清零） */
  const ok = await loadMe();
  if (!ok) { TOKEN = ''; try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} showLogin(); return; }
  hideLogin();
  await loadMachines();
  await loadDisks(true);
  newTab('终端 1');
  pollJobs();
  setInterval(pollJobs, 4000);
  setInterval(async () => { const r = await api('/machines'); if (r.machines) { S.machines = r.machines; updateSvc(); } }, 20000);
}
$('#btnScan').onclick = async () => { toast('扫描中…'); await loadDisks(true); toast('扫描完成'); };
boot();
