'use strict';
/* 硬盘检测：品牌 / 接口 / 逻辑块大小 / 物理块大小 / 序列号 / 缺陷（G-list、SMART 05/196/197） */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

/* 可执行文件解析：优先绝对路径（服务可能跑在 PATH 不含 /usr/sbin 的环境里） */
const BINS = {
  smartctl: ['/usr/sbin/smartctl', '/sbin/smartctl', '/usr/bin/smartctl'],
  sg_inq: ['/usr/bin/sg_inq', '/usr/local/bin/sg_inq'],
  lsscsi: ['/usr/bin/lsscsi', '/usr/local/bin/lsscsi'],
  nvme: ['/usr/sbin/nvme', '/usr/bin/nvme'],
  lsblk: ['/usr/bin/lsblk', '/bin/lsblk'],
  sg_turs: ['/usr/bin/sg_turs', '/usr/local/bin/sg_turs'],
};
const PRIV = { smartctl: true, nvme: true, sg_inq: false };
function resolveBin(name) {
  for (const p of BINS[name] || [name]) { try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p; } catch (e) {} }
  return null;
}
function isRoot() { return typeof process.getuid === 'function' && process.getuid() === 0; }
/* 需要 root 的工具：非 root 时用 sudo -n（免密） */
function argv(name, args) {
  const bin = resolveBin(name);
  if (!bin) return null;
  if (PRIV[name] && !isRoot()) return ['sudo', ['-n', bin].concat(args)];
  return [bin, args];
}
async function runTool(name, args, timeout) {
  const a = argv(name, args);
  if (!a) return { ok: false, stdout: '', stderr: `${name} 未安装`, missing: true };
  return run(a[0], a[1], timeout);
}
async function has(cmd) { return !!resolveBin(cmd); }

const BRANDS = [
  { key: '日立/HGST', re: /(HGST|HITACHI|HTS|HUC|HUH|HUS|HDS|HMS|HSH|HE[0-9]{2}|ULTRASTAR)/i },
  { key: '西数', re: /(WDC|WESTERN DIGITAL|\bWD\d|\bWD[A-Z])/i },
  { key: '希捷', re: /(SEAGATE|\bST\d{4}|ST[0-9]{4,}|EXOS|BARRACUDA|IRONWOLF)/i },
  { key: '东芝', re: /(TOSHIBA|MG0[0-9]|MG[0-9]{2}|AL[0-9]{2}|DT0[0-9])/i },
];

function guessBrand(model, vendor, serial) {
  const s = `${model || ''} ${vendor || ''}`.toUpperCase();
  for (const b of BRANDS) if (b.re.test(s)) return b.key;
  return '其他';
}

function normInterface(tran, name) {
  const t = (tran || '').toLowerCase();
  if (t === 'sas') return 'SAS';
  if (t === 'sata' || t === 'ata') return 'SATA';
  if (t === 'nvme') return 'NVMe';
  if (/^nvme/.test(name || '')) return 'NVMe';
  if (t) return '其他';
  return '其他';
}

/* /dev/sdX -> /dev/sgN */
function sgNode(diskName) {
  try {
    const d = `/sys/block/${diskName}/device/scsi_generic`;
    const entries = fs.readdirSync(d);
    if (entries.length) return '/dev/' + entries[0];
  } catch (e) {}
  return null;
}

function isSystemDisk(disk, mounts) {
  const rootSrc = mounts.root || '';
  return !!rootSrc && disk.children.some((c) => rootSrc.startsWith(c.path) || rootSrc === c.path);
}

async function readMounts() {
  const out = { root: '' };
  try {
    const txt = fs.readFileSync('/proc/mounts', 'utf8');
    for (const line of txt.split('\n')) {
      const [src, mount] = line.split(' ');
      if (mount === '/') out.root = src;
    }
  } catch (e) {}
  return out;
}

/* lsblk -J 解析 */
async function lsblk() {
  const args = ['-J', '-b', '-o', 'NAME,KNAME,TYPE,SIZE,MODEL,SERIAL,VENDOR,TRAN,LOG-SEC,PHY-SEC,MOUNTPOINTS,FSTYPE,ROTA'];
  let r = await runTool('lsblk', args);
  if (!r.ok) r = await runTool('lsblk', ['-J', '-b', '-o', 'NAME,KNAME,TYPE,SIZE,MODEL,SERIAL,VENDOR,TRAN,LOG-SEC,PHY-SEC,MOUNTPOINT,FSTYPE,ROTA']);
  if (!r.ok) return [];
  try { return JSON.parse(r.stdout).blockdevices || []; } catch (e) { return []; }
}

/* smartctl JSON 解析（优先，7.4 支持 -j）：SATA 取 ata_smart_attributes.raw.value，SAS 取 scsi_grown_defect_list */
function parseSmartJson(o) {
  const r = { health: '未知', g_list: null, s05: null, s196: null, s197: null, s198: null, s199: null, nvmeMediaErrors: null };
  if (!o || typeof o !== 'object') return r;
  if (o.smart_status && typeof o.smart_status.passed === 'boolean') r.health = o.smart_status.passed ? '正常' : '警告';
  if (typeof o.scsi_grown_defect_list === 'number') r.g_list = o.scsi_grown_defect_list;
  const t = o.ata_smart_attributes && o.ata_smart_attributes.table;
  if (Array.isArray(t)) {
    for (const a of t) {
      let v = null;
      if (a.raw && typeof a.raw.value === 'number') v = a.raw.value;
      else if (a.raw && typeof a.raw.string === 'string') v = parseInt(a.raw.string, 10);
      if (Number.isNaN(v)) v = null;
      if (a.id === 5) r.s05 = v;
      if (a.id === 196) r.s196 = v;
      if (a.id === 197) r.s197 = v;
      if (a.id === 198) r.s198 = v;   // Offline_Uncorrectable 脱机不可校正扇区
      if (a.id === 199) r.s199 = v;   // UDMA_CRC_Error_Count 接口 CRC 错误
    }
  }
  const n = o.nvme_smart_health_information_log;
  if (n) {
    if (typeof n.media_errors === 'number') r.nvmeMediaErrors = n.media_errors;
    if (typeof n.percentage_used === 'number') r.healthPct = Math.max(0, Math.min(100, 100 - n.percentage_used));  // NVMe：已用寿命 → 剩余
  }
  /* SATA SSD 剩余寿命：231(SSD_Life_Left) / 233(Media_Wearout) / 202(Percent_Lifetime_Remain) */
  if (Array.isArray(t)) {
    for (const a of t) {
      if ([231, 233, 202].indexOf(a.id) >= 0 && a.value !== undefined && a.value !== null) {
        const v = Number(a.value);
        if (!Number.isNaN(v) && v >= 0 && v <= 100) { r.healthPct = v; r.wearAttr = a.id; }
      }
    }
  }
  return r;
}

/* smartctl 文本输出解析（JSON 不可用时的兜底） */
function parseSmart(text) {
  const res = { health: '未知', g_list: null, s05: null, s196: null, s197: null, s198: null, s199: null, raw: {} };
  if (!text) return res;
  const hl = text.match(/SMART overall-health self-assessment test result:\s*(\w+)/i);
  if (hl) res.health = /PASSED/i.test(hl[1]) ? '正常' : '警告';
  if (/SMART Health Status:\s*OK/i.test(text)) res.health = '正常';
  else if (/SMART Health Status:\s*([^\n]+)/i.test(text) && res.health === '未知') res.health = '警告';

  const g = text.match(/Elements in grown defect list:\s*(\d+)/i);
  if (g) res.g_list = parseInt(g[1], 10);

  /* 严格按属性表整行解析：ID NAME FLAG VALUE WORST THRESH TYPE UPDATED WHEN_FAILED RAW_VALUE
     必须取 RAW_VALUE（最后一列），不能用 VALUE 列（旧版 bug：取到 100 这种归一化值） */
  const line = /^\s*(\d{1,3})\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+|[A-Za-z-]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;
  for (const ln of text.split('\n')) {
    const m2 = ln.match(line);
    if (!m2) continue;
    const id = parseInt(m2[1], 10);
    const name = m2[2];
    const rawField = m2[10].trim();
    const rawNum = (/^(\d+)/.exec(rawField) || [])[1];
    const val = rawNum === undefined ? null : parseInt(rawNum, 10);
    if (id === 5 && /Reallocated_Sector/i.test(name)) res.s05 = val;
    if (id === 196 && /Reallocated_Event/i.test(name)) res.s196 = val;
    if (id === 197 && /Current_Pending/i.test(name)) res.s197 = val;
    if (id === 198 && /Uncorrectable|Offline_Uncorrectable/i.test(name)) res.s198 = val;
    if (id === 199 && /UDMA_CRC|CRC_Error/i.test(name)) res.s199 = val;
  }
  return res;
}

/* smartctl -j -i 的 device 信息：接口协议比 lsblk 的 TRAN 更准（例：SAS 背板里插 SATA 盘）*/
function ifaceFromProtocol(proto, type) {
  const p = String(proto || '').toUpperCase();
  const t = String(type || '').toLowerCase();
  if (p === 'ATA' || t === 'ata' || t === 'sat') return 'SATA';
  if (p === 'SCSI' || t === 'scsi') return 'SAS';
  if (p === 'NVME' || t === 'nvme') return 'NVMe';
  return null;
}
function fromSmartInfo(o) {
  if (!o || typeof o !== 'object') return {};
  const r = {};
  const iface = ifaceFromProtocol(o.device && o.device.protocol, o.device && o.device.type);
  if (iface) r.ifaceFromSmart = iface;
  const model = o.product || o.model_name;
  if (model && String(model).trim()) r.smartModel = String(model).trim();
  if (o.vendor && String(o.vendor).trim()) r.smartVendor = String(o.vendor).trim();
  if (o.serial_number && String(o.serial_number).trim()) r.smartSerial = String(o.serial_number).trim();
  if (typeof o.logical_block_size === 'number') r.smartLba = o.logical_block_size;
  if (typeof o.physical_block_size === 'number') r.smartPba = o.physical_block_size;
  if (typeof o.user_capacity === 'number') r.smartCapacity = o.user_capacity;
  if (typeof o.rotation_rate === 'number') r.smartRpm = o.rotation_rate;
  if (o.firmware_version) r.firmware = String(o.firmware_version);
  return r;
}

/* 单块盘检测 */
async function probeDisk(dev, info) {
  const out = info;   // 必须原地写入：scan() 直接使用传入对象
  const sm = await runTool('smartctl', ['-j', '-H', '-A', '-i', dev], 20000);
  let p = null, j = null;
  if (sm.stdout) { try { j = JSON.parse(sm.stdout); p = parseSmartJson(j); } catch (e) { p = null; } }
  const usable = p && (p.health !== '未知' || p.g_list !== null || p.s05 !== null || p.s196 !== null || p.s197 !== null || p.s198 !== null || p.s199 !== null);
  if (!usable) {
    const sm2 = await runTool('smartctl', ['-H', '-A', '-i', dev], 20000);
    if (sm2.stdout) p = parseSmart(sm2.stdout);
    out.smartRaw = (sm2.stdout || sm.stdout || '').slice(0, 4000);
  }
  if (j) Object.assign(out, fromSmartInfo(j));
  if (p && (p.health !== '未知' || p.g_list !== null || p.s05 !== null || p.s196 !== null || p.s197 !== null || p.s198 !== null || p.s199 !== null)) {
    out.smartHealth = p.health;
    out.gList = p.g_list;
    out.smart05 = p.s05;
    out.smart196 = p.s196;
    out.smart197 = p.s197;
    out.smart198 = p.s198;
    out.smart199 = p.s199;
    out.healthPct = (p.healthPct === undefined ? null : p.healthPct);
    out.wearAttr = p.wearAttr || null;
    out.smartSupported = true;
    out.autoDefect = null;
  } else {
    out.smartHealth = '未知';
    out.smartSupported = false;
    out.gList = null; out.smart05 = null; out.smart196 = null; out.smart197 = null; out.smart198 = null; out.smart199 = null;
    out.smartError = sm.missing ? 'smartctl 未安装'
      : (sm.stderr || (sm.err && sm.err.message) || 'smartctl 读取失败').split('\n').filter(Boolean)[0] || 'smartctl 读取失败';
  }
  if (out.interfaceType === 'SAS' && out.sg) {
    const inq = await runTool('sg_inq', [out.sg], 10000);
    if (inq.ok) {
      const m = inq.stdout.match(/Vendor identification:\s*(.+)/i);
      const pm = inq.stdout.match(/Product identification:\s*(.+)/i);
      if (pm) out.sgModel = pm[1].trim();
      if (m && (!out.vendor || out.vendor === '')) out.vendor = m[1].trim();
    }
  }
  return out;
}

async function scan() {
  const [tree, mounts, hasSmart, hasSg, hasLsscsi] = await Promise.all([
    lsblk(), readMounts(), has('smartctl'), has('sg_inq'), has('lsscsi'),
  ]);
  const disks = [];
  for (const d of tree) {
    if (d.type !== 'disk') continue;
    const children = (d.children || []).map((c) => ({ path: '/dev/' + c.name, type: c.type, mount: (c.mountpoints || [c.mountpoint]).filter(Boolean)[0] || '' }));
    const mounted = children.filter((c) => c.mount).map((c) => c.mount);
    const disk = {
      device: '/dev/' + d.name,
      kname: d.kname || d.name,
      sizeBytes: Number(d.size) || 0,
      model: (d.model || '').trim(),
      serial: (d.serial || '').trim(),
      vendor: (d.vendor || '').trim(),
      tran: d.tran || '',
      logicalBlockSize: Number(d['log-sec']) || null,
      physicalBlockSize: Number(d['phy-sec']) || null,
      rotational: d.rota === true || d.rota === '1',
      parts: children,
      mounted: mounted,
      isMounted: mounted.length > 0,
      format512e4kn: (Number(d['log-sec']) === 512 && Number(d['phy-sec']) === 4096) ? '512e' : (Number(d['log-sec']) === 4096 ? '4Kn' : ''),
    };
    disk.sg = sgNode(d.kname || d.name);
    disk.autoBrand = guessBrand(disk.model, disk.vendor, disk.serial);
    disk.brand = disk.autoBrand;
    disk.interfaceType = normInterface(disk.tran, d.name);
    disk.autoInterface = disk.interfaceType;
    disk.isSystemDisk = isSystemDisk({ children: [{ path: '/dev/' + d.name, mount: '' }].concat(children) }, mounts) || children.some((c) => mounts.root && (mounts.root === c.path));
    if (disk.sg) d.sg = disk.sg;
    disks.push(disk);
  }
  for (let i = 0; i < disks.length; i++) disks[i] = await probeDisk(disks[i].device, disks[i]);
  /* 用 smartctl 的结果补全/纠正：接口协议、型号、序列号、容量、块大小 */
  for (const d of disks) {
    if (d.ifaceFromSmart && d.ifaceFromSmart !== d.interfaceType) {
      d.ifaceByLsblk = d.interfaceType;
      d.interfaceType = d.ifaceFromSmart;
      d.autoInterface = d.ifaceFromSmart;
    }
    if (d.smartModel && (!d.model || d.model.length < d.smartModel.length)) d.model = d.smartModel;
    if (d.smartVendor && !d.vendor) d.vendor = d.smartVendor;
    if (d.smartSerial && !d.serial) d.serial = d.smartSerial;
    if (d.smartLba) d.logicalBlockSize = d.smartLba;
    if (d.smartPba) d.physicalBlockSize = d.smartPba;
    if (d.smartCapacity && d.sizeBytes < d.smartCapacity) d.sizeBytes = d.smartCapacity;
    if (!d.autoBrand || d.autoBrand === '其他') {
      const b = guessBrand(d.model, d.vendor, d.serial);
      if (b !== '其他') { d.autoBrand = b; d.brand = b; }
    }
    d.id = d.serial || d.device;
  }
  return { disks, tools: { smartctl: hasSmart, sg_inq: hasSg, lsscsi: hasLsscsi }, scannedAt: Date.now() };
}

module.exports = { scan, run, runTool, resolveBin, has, guessBrand, normInterface, ifaceFromProtocol, parseSmart, parseSmartJson, probeDisk };
