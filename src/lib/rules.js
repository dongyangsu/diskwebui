'use strict';
/* 规则引擎 + 工具适配器 + 命令模板（第 6、7 章） */

const TOOLS = [
  {
    id: 'hugo', name: 'hugo 工具包内 format', brand: '日立/HGST', interfaceType: 'SAS',
    pkg: 'hugo', bin: 'format',
    modes: {
      慢格: 'format -m {model} --merge -b {size}',
      快格: 'format -m {model} --merge --fastformat -b {size}',
    },
    supports: [512, 520, 4096, 4160],
    note: 'format 不是系统命令，是工具包内部命令，需 cd 到工具包目录执行；-m 按型号选盘',
  },
  {
    id: 'wdckit', name: 'wdckit 工具包内 format', brand: '西数', interfaceType: 'SAS',
    pkg: 'wdckit', bin: 'format',
    modes: {
      慢格: 'format {device} --merge --progress-bar -b {size}',
      快格: 'format {device} --merge --fastformat --progress-bar -b {size}',
    },
    supports: [512, 520, 4096, 4160],
    note: 'format 不是系统命令，是工具包内部命令，需 cd 到工具包目录执行',
  },
  {
    id: 'sg_format', name: 'sg_format（系统 sg3_utils）', brand: '希捷', interfaceType: 'SAS',
    modes: {
      单个: 'sg_format -v --format --size={size} {sgdevice}',
      批量: 'seq {start} {end} | xargs -I{} -P 0 sudo sg_format -v --format --size={size} /dev/sg{}',
    },
    supports: [512, 520, 4096, 4160],
    note: '希捷 SAS 用系统命令 sg_format；批量用 /dev/sgN 序号区间',
  },
  {
    id: 'seachest', name: 'SeaChest_Format', brand: '希捷', interfaceType: 'SAS/SATA',
    pkg: 'seachest', bin: 'SeaChest_Format_linux_x86_64',
    modes: {
      批量: 'SeaChest_Format_linux_x86_64 {dArgs} --setSectorSize {size} --confirm this-will-erase-data-and-may-render-the-drive-inoperable',
    },
    supports: [512, 520, 4096, 4160],
    note: '一条命令多个 -d 批量处理；需 sudo',
  },
  {
    id: 'toshiba_sas', name: 'sg_format（东芝 SAS）', brand: '东芝', interfaceType: 'SAS',
    modes: { 单个: 'sg_format -v --format --size={size} {sgdevice}' },
    supports: [512, 520, 4096, 4160],
    note: '东芝 SAS 走 sg_format',
  },
  {
    id: 'dd', name: 'dd 擦除（东芝 SATA）', brand: '东芝', interfaceType: 'SATA',
    modes: { 擦除: 'dd if=/dev/zero of={device} bs=24M status=progress' },
    supports: [],
    note: '⚠️ dd 只能全盘写零，不能改变逻辑块大小；与“格式化只改变逻辑块大小”的原则冲突',
  },
  {
    id: 'custom', name: '自定义命令', brand: '*', interfaceType: '*',
    modes: { 自定义: '{custom}' }, supports: [512, 520, 4096, 4160],
    note: '人工确认后执行',
  },
];

function recommendTool(disk, settings) {
  const brand = disk.brand || disk.autoBrand;
  const it = disk.interfaceType || disk.autoInterface;
  const byBrand = TOOLS.filter((t) => t.brand === brand && t.id !== 'custom');
  if (!byBrand.length) return null;
  const exact = byBrand.find((t) => t.interfaceType && t.interfaceType.includes(it) && !t.interfaceType.includes('/'));
  if (exact) return exact.id;
  if (brand === '希捷') return it === 'SAS' ? 'sg_format' : 'seachest';
  return byBrand[0].id;
}

function fmtGB(bytes) {
  if (!bytes) return '-';
  const gb = bytes / 1024 ** 3;
  return gb >= 1000 ? (gb / 1000).toFixed(2) + ' TB' : gb.toFixed(0) + ' GB';
}

function evaluateDefect(disk, settings) {
  const it = disk.interfaceType || disk.autoInterface;
  let method, autoStatus = '未知', values = {}, reason = '';
  if (it === 'SAS') {
    method = 'G-list';
    if (disk.gList === null || disk.gList === undefined) { autoStatus = '未知'; reason = 'G-list 读取失败' + (disk.smartError ? '：' + disk.smartError : ''); }
    else { values['G-list 值'] = disk.gList; autoStatus = disk.gList > 0 ? '有' : '无'; }
  } else if (it === 'SATA') {
    method = 'SMART 05/196/197';
    const a = disk.smart05, b = disk.smart196, c = disk.smart197;
    values = { '05 重映射扇区': a, '196 重映射事件': b, '197 待映射扇区': c };
    if (a === null && b === null && c === null) { autoStatus = '未知'; reason = 'SMART 读取失败' + (disk.smartError ? '：' + disk.smartError : ''); }
    else if ([a, b, c].some((v) => (v || 0) > 0)) { autoStatus = '有'; if ((c || 0) > 0) reason = '⚠️ 197 待映射扇区非 0，格式化不一定能修复'; }
    else autoStatus = '无';
  } else {
    method = '不适用';
    autoStatus = '未知';
    reason = `${it} 接口无对应缺陷判断规则（SAS 看 G-list，SATA 看 05/196/197）`;
  }
  const status = disk.defectStatusOverride || autoStatus;
  let allow = false, blocked = '';
  const p = settings.protect;
  if (disk.isSystemDisk && p.blockSystemDisk) { blocked = '系统盘/启动盘，默认拦截'; }
  else if (disk.isMounted && p.blockMountedDisk) { blocked = '已挂载盘，默认拦截'; }
  else if (status === '有') allow = true;
  else if (status === '无') { blocked = '无缺陷记录 → 按规则停止下一次格式化'; }
  else if (status === '未知') { blocked = p.blockUnknown ? '缺陷状态未知 → 默认禁止（可人工确认覆盖）' : ''; allow = !p.blockUnknown; }
  return { method, autoStatus, status, values, reason, allow, blocked };
}


/* ---------- 命令生成（2026-09-16 用户确认的规则） ----------
   · 日立/HGST → hugo：单盘/多盘都用 -m <型号>（多盘就写多个 -m）
   · 西数 → wdckit：单盘优先 --model（型号含空格则用 --serial），多盘用设备列表
   · 希捷/东芝SAS/其他SAS → sg_format：单盘一条；多盘连续用 seq+xargs，不连续用 for 循环
   · 东芝 SATA → dd
   · 不用 --danger-zone / --simple-progress（用户明确说没必要）
---------------------------------------------------------------- */
function shq(v) {
  const t = String(v == null ? '' : v);
  if (t === '') return "''";
  return /[\s"'$`\\|&;<>()*?\[\]{}]/.test(t) ? "'" + t.replace(/'/g, "'\\''") + "'" : t;
}
function homeOf(settings) { return (settings && settings.homeDir) || process.env.HOME || '/root'; }
function expandPath(p, settings) { return String(p || '').replace(/^~(?=\/|$)/, homeOf(settings)); }
function toolBin(toolId, settings) {
  const st = settings || {};
  const bins = st.toolBins || {};
  if (toolId === 'hugo') return require('path').join(expandPath(st.toolPaths && st.toolPaths.hugo, st), bins.hugo || 'hugo');
  if (toolId === 'wdckit') return require('path').join(expandPath(st.toolPaths && st.toolPaths.wdckit, st), bins.wdckit || 'wdckit');
  if (toolId === 'seachest') return require('path').join(expandPath(st.toolPaths && st.toolPaths.seachest, st), bins.seachest || 'SeaChest_Format_linux_x86_64');
  return null;
}
/* 单盘命令 */
function renderCommand(disk, cfg, settings) {
  cfg = cfg || {};
  const size = Number(cfg.lunSize) || Number(settings.defaultLunSize) || 512;
  const toolId = cfg.toolId || recommendTool(disk, settings) || 'custom';
  const tool = TOOLS.find((t) => t.id === toolId);
  const bin = toolBin(toolId, settings);
  const cwd = (toolId === 'hugo') ? expandPath((settings.toolPaths || {}).hugo, settings)
    : (toolId === 'wdckit') ? expandPath((settings.toolPaths || {}).wdckit, settings)
    : (toolId === 'seachest') ? expandPath((settings.toolPaths || {}).seachest, settings) : '';
  let inner = '', cmd = '', warn = [];
  const model = disk.model || '', serial = disk.serial || '', dev = disk.device || '', sg = disk.sg || disk.device;

  if (toolId === 'hugo') {
    /* 用户 2026-09-17：优先按序列号精确指定单盘（-s），避免 -m 按型号把同型号所有盘一起格 */
    const useSerial = ((settings.hugoPick || 'serial') === 'serial') && serial;
    if (useSerial) {
      inner = `format -s ${shq(serial)} --merge -b ${size}`;
      warn.push('按序列号精确指定（-s），不会误伤同型号其它盘');
    } else {
      inner = `format -m ${shq(model)} --merge -b ${size}`;
      warn.push('hugo 的 -m 是按型号匹配：本机所有同型号的盘都会被格式化（不只是这一块）');
    }
    cmd = `sudo ${bin} ${inner}`;
  } else if (toolId === 'wdckit') {
    /* 2026-09-19 真机实测发现的坑：`--model` 会按型号匹配，本机同型号的盘会被一起格
       （139 上 HUS728T8TALN600 有两块，一条命令把两块都点了）→ 默认优先 --serial 精确指定单盘。 */
    if (serial && (settings.wdckitPick || 'serial') === 'serial') {
      inner = `format --serial ${shq(serial)} --merge -b ${size}`;
      warn.push('按序列号精确指定（--serial），不会误伤同型号其它盘');
    } else if (model && !/\s/.test(model)) {
      inner = `format --model ${shq(model)} --merge -b ${size}`;
      warn.push('wdckit 的 --model 是按型号匹配：本机所有同型号的盘都会被格式化（不只是这一块）');
    } else if (serial) {
      inner = `format --serial ${shq(serial)} --merge -b ${size}`;
      warn.push('该盘型号含空格/为空 → 自动改用 --serial');
    } else {
      inner = `format ${shq(dev)} --merge -b ${size}`;
      warn.push('该盘无型号/序列号 → 自动改用设备名');
    }
    cmd = `sudo ${bin} ${inner}`;
  } else if (toolId === 'sg_format') {
    inner = `sg_format -v --format --size=${size} ${sg}`;
    cmd = `sudo ${inner}`;
  } else if (toolId === 'toshiba_sas') {
    inner = `sg_format -v --format --size=${size} ${sg}`;
    cmd = `sudo ${inner}`;
  } else if (toolId === 'dd') {
    inner = `dd if=/dev/zero of=${dev} bs=24M status=progress`;
    cmd = `sudo ${inner}`;
  } else if (toolId === 'seachest') {
    /* 实际可执行文件名各机不同（SeaChest_Format / SeaChest_Format_linux_x86_64）→ 必须用配置值 */
    const seaName = require('path').basename(bin || 'SeaChest_Format_linux_x86_64');
    inner = `${seaName} -d ${sg} --setSectorSize ${size} --confirm this-will-erase-data-and-may-render-the-drive-inoperable`;
    cmd = `sudo ${inner}`;
  } else {  // custom
    inner = cfg.customCommand || '';
    cmd = inner;
  }
  return {
    toolId, toolName: tool ? tool.name : '自定义命令', mode: cfg.mode || '', lunSize: size,
    template: inner, inToolCommand: inner, command: cmd, cwd, binPath: bin,
    note: tool ? tool.note : '', warnings: warn,
    supported: [512, 520, 4096, 4160].includes(Number(size)) ? 'yes' : 'no',
    isBatch: false,
  };
}
/* 批量：按工具分组，生成"一条命令覆盖多盘"的批量命令 */
function renderBatch(disks, cfg, settings) {
  cfg = cfg || {};
  const list = (disks || []).filter(Boolean);
  if (!list.length) return [];
  const size = Number(cfg.lunSize) || Number(settings.defaultLunSize) || 512;
  const groups = new Map();
  for (const d of list) {
    const tid = cfg.toolId || recommendTool(d, settings) || 'custom';
    if (!groups.has(tid)) groups.set(tid, []);
    groups.get(tid).push(d);
  }
  const out = [];
  for (const [tid, ds] of groups) {
    const tool = TOOLS.find((t) => t.id === tid);
    const bin = toolBin(tid, settings);
    const cwd = (tid === 'hugo') ? expandPath((settings.toolPaths || {}).hugo, settings)
      : (tid === 'wdckit') ? expandPath((settings.toolPaths || {}).wdckit, settings) : '';
    const devices = ds.map((x) => ({ id: x.id, device: x.device, sg: x.sg, model: x.model || '', serial: x.serial || '', brand: x.brand, interfaceType: x.interfaceType }));
    const warns = [];
    let inner = '', cmd = '';

    if (tid === 'hugo') {
      const useSerial = ((settings.hugoPick || 'serial') === 'serial') && ds.every((d) => d.serial);
      if (useSerial) {
        inner = 'format ' + ds.map((d) => `-s ${shq(d.serial)}`).join(' ') + ` --merge -b ${size}`;
        warns.push('按序列号精确指定（-s）：只格你勾的这几块');
      } else {
        const models = [];
        for (const d of ds) { const m = d.model || ''; if (m && !models.includes(m)) models.push(m); }
        const dupes = ds.length - models.length;
        inner = 'format ' + models.map((m) => `-m ${shq(m)}`).join(' ') + ` --merge -b ${size}`;
        cmd = `sudo ${bin} ${inner}`;
        warns.push('⚠️ -m 按型号匹配：本机所有同型号的盘都会被格式化（不只你勾的这些）');
        if (dupes > 0) warns.push(`其中有 ${dupes} 块与其它盘同型号，-m 会合并处理`);
      }
      cmd = `sudo ${bin} ${inner}`;
    } else if (tid === 'seachest') {
      const seaName = require('path').basename(bin || 'SeaChest_Format_linux_x86_64');
      const dArgs = ds.map((d) => `-d ${d.sg || d.device}`).join(' ');
      inner = `${seaName} ${dArgs} --setSectorSize ${size} --confirm this-will-erase-data-and-may-render-the-drive-inoperable`;
      cmd = `sudo ${inner}`;
      warns.push('SeaChest 一条命令处理多块盘（--confirm = 确认擦除数据）');
    } else if (tid === 'wdckit') {
      /* 默认用 --model（用户推荐）；型号含空格/缺失的盘自动改用 --serial，都没有再用设备名 */
      const byModel = [], bySerial = [], byDevice = [];
      for (const d of ds) {
        const m = d.model || '';
        if (m && !/\s/.test(m)) byModel.push(d);
        else if (d.serial) bySerial.push(d);
        else byDevice.push(d);
      }
      const emit = (list, kind, extraWarn) => {
        if (!list.length) return;
        let i2 = '', c2 = '';
        const names = [];
        if (kind === 'model') {
          const ms = [];
          for (const d of list) if (!ms.includes(d.model)) ms.push(d.model);
          i2 = 'format ' + ms.map((m) => `--model ${shq(m)}`).join(' ') + ` --merge -b ${size}`;
          names.push('⚠️ --model 按型号匹配：本机所有同型号的盘都会被格式化');
        } else if (kind === 'serial') {
          i2 = 'format ' + list.map((d) => `--serial ${shq(d.serial)}`).join(' ') + ` --merge -b ${size}`;
          names.push('这些盘型号含空格/为空 → 自动改用 --serial');
        } else {
          i2 = 'format ' + list.map((d) => shq(d.device)).join(' ') + ` --merge -b ${size}`;
          names.push('这些盘无型号/序列号 → 自动改用设备名');
        }
        if (extraWarn) names.push(extraWarn);
        out.push({
          toolId: 'wdckit', toolName: tool ? tool.name : 'wdckit', devices: list.map((x) => ({ id: x.id, device: x.device, sg: x.sg, model: x.model || '', serial: x.serial || '', brand: x.brand, interfaceType: x.interfaceType })),
          count: list.length, lunSize: size, inToolCommand: i2, command: `sudo ${bin} ${i2}`, cwd, binPath: bin,
          warnings: names, isBatch: list.length > 1,
        });
      };
      emit(byModel, 'model');
      emit(bySerial, 'serial');
      emit(byDevice, 'device');
      continue;
    } else if (tid === 'sg_format' || tid === 'toshiba_sas') {
      const nums = ds.map((d) => { const m = String(d.sg || '').match(/\/dev\/sg(\d+)$/); return m ? Number(m[1]) : null; });
      const contiguous = nums.every((n) => n !== null) && (Math.max(...nums) - Math.min(...nums) + 1 === nums.length);
      if (contiguous && nums.length > 1) {
        const par = Number.isFinite(Number(settings.sgConcurrency)) ? Number(settings.sgConcurrency) : 0;
        inner = `seq ${Math.min(...nums)} ${Math.max(...nums)} | xargs -I{} -P ${par} sudo sg_format -v --format --size=${size} /dev/sg{}`;
        cmd = inner;
        if (par === 0 && nums.length > 4) warns.push(`⚠ -P 0 = 不限并发：${nums.length} 块盘会同时格式化（担心 HBA/盘压力可在设置里限制并发，建议 2~4）`);
      } else if (nums.length === 1) {
        inner = `sg_format -v --format --size=${size} ${ds[0].sg}`;
        cmd = `sudo ${inner}`;
      } else {
        inner = 'for d in ' + ds.map((d) => d.sg).join(' ') + `; do sudo sg_format -v --format --size=${size} $d; done`;
        cmd = inner;
      }
    } else if (tid === 'dd') {
      inner = ds.map((d) => `dd if=/dev/zero of=${d.device} bs=24M status=progress`).join(' && ');
      cmd = `sudo sh -c ${shq(inner)}`;
    } else {
      inner = cfg.customCommand || '';
      cmd = inner;
      if (!inner) {
        warns.push('⛔ 未匹配到工具：该盘的品牌/接口不在工具映射表里（如“其他”），请先手动指定工具或写自定义命令');
      } else {
        warns.push('自定义命令：请自行确认能覆盖所选的多块盘');
      }
    }
    out.push({
      toolId: tid, toolName: tool ? tool.name : '自定义命令', devices,
      count: devices.length, lunSize: size, inToolCommand: inner, command: cmd, cwd, binPath: bin,
      warnings: warns, isBatch: devices.length > 1,
    });
  }
  return out;
}

/* 执行前校验（第十一章：工具包目录/命令/设备/逻辑块大小/挂载 校验） */
function preflight(disk, cfg, settings, rendered) {
  const fs = require('fs');
  const path = require('path');
  const problems = [];
  const warnings = [];
  const home = (settings && settings.homeDir) || process.env.HOME || '/root';
  const expand = (p) => String(p || '').replace(/^~/, home);

  if (!disk || !disk.device) problems.push('硬盘设备信息缺失');
  else if (!fs.existsSync(disk.device)) problems.push(`设备不存在或已拔除：${disk.device}`);
  if (disk && disk.sg && !fs.existsSync(disk.sg)) warnings.push(`SG 设备不存在：${disk.sg}（部分工具需要 /dev/sgN）`);
  if (disk && disk.isMounted && settings.protect.blockMountedDisk) problems.push('已挂载盘，禁止直接格式化');
  if (disk && disk.isSystemDisk && settings.protect.blockSystemDisk) problems.push('系统盘/启动盘，禁止直接格式化');

  const tool = TOOLS.find((t) => t.id === (rendered && rendered.toolId));
  if (!tool) problems.push('未找到对应格式化工具');
  if (tool && tool.pkg) {
    const pkgPath = expand(settings.toolPaths[tool.pkg]);
    const binName = (settings.toolBins && settings.toolBins[tool.pkg]) || tool.bin;
    if (!pkgPath) problems.push(`未配置 ${tool.pkg} 工具包路径`);
    else if (!fs.existsSync(pkgPath)) problems.push(`工具包目录不存在：${pkgPath}（可在设置页点“自动检测工具路径”）`);
    else if (binName && !fs.existsSync(path.join(pkgPath, binName))) problems.push(`工具包内未找到命令：${path.join(pkgPath, binName)}（实际可执行文件名可能不同，请在设置里改或自动检测）`);
  }
  if (tool && Array.isArray(tool.supports) && tool.supports.length > 0 && !tool.supports.includes(Number(rendered.lunSize))) {
    problems.push(`该工具不支持逻辑块大小 ${rendered.lunSize}B（支持：${tool.supports.join(' / ')}）`);
  }
  /* 用户 2026-09-17：其它工具/命令可能的错误也要卡住 */
  const lun = Number(rendered && rendered.lunSize);
  if (!Number.isFinite(lun) || lun < 512 || lun > 65536) problems.push(`逻辑块大小非法：${(rendered && rendered.lunSize)}（应在 512~65536 之间）`);
  const tid = (rendered && rendered.toolId) || '';
  if (tid === 'custom' && !String((rendered && rendered.command) || '').trim()) problems.push('自定义命令为空');
  if ((tid === 'hugo' || tid === 'wdckit') && !fs.existsSync(String(rendered.binPath || ''))) problems.push(`工具可执行文件不存在：${rendered.binPath}`);
  if (tid === 'sg_format' || tid === 'toshiba_sas') {
    try { require('child_process').execFileSync('bash', ['-lc', 'command -v sg_format'], { timeout: 5000 }); }
    catch (e) { problems.push('系统里没有 sg_format（需安装 sg3_utils）'); }
  }
  if (tool && tool.supports && tool.supports.length === 0) warnings.push('该工具不能改变逻辑块大小（只做全盘擦除），与“只改变逻辑块大小”原则冲突');
  if (settings.dryRun) warnings.push('dryRun 演示模式：只生成命令与日志，不真正执行');
  return { ok: problems.length === 0, problems, warnings };
}

/* 单工具多盘一条命令（2026-09-19 用户要求：format -s A -s B 才是真并行）
   hugo → format -s A -s B --merge -b N；wdckit → format --serial A --serial B ... */
/* 合批键：用户 2026-09-19 要求“日立和西数可以算同一批，一条 format 命令一起开始”
   → 日立/HGST（hugo）与西数（wdckit）统一用 hugo 一条命令批量发起（settings.unifyHugo !== false 时）。 */
function batchKey(diskOrToolId, settings) {
  const st = settings || {};
  if (diskOrToolId && typeof diskOrToolId === 'object') {
    const b = diskOrToolId.brand || '';
    const it = diskOrToolId.interfaceType || '';
    if (b === '日立/HGST') return 'hugo';
    if (b === '西数') return 'wdckit';
    if ((b === '希捷' || b === '东芝') && it === 'SAS') return 'sg_format';
    return recommendTool(diskOrToolId, st) || 'custom';
  }
  return diskOrToolId;
}
function renderToolGroup(disks, cfg, settings) {
  cfg = cfg || {};
  const list = (disks || []).filter(Boolean);
  if (!list.length) return null;
  const size = Number(cfg.lunSize) || Number(settings.defaultLunSize) || 512;
  const tid0 = cfg.toolId || batchKey(list[0], settings) || 'custom';
  const tid = tid0;
  const tool = TOOLS.find((t) => t.id === tid);
  const bin = toolBin(tid, settings);
  const cwd = (tid === 'hugo') ? expandPath((settings.toolPaths || {}).hugo, settings)
    : (tid === 'wdckit') ? expandPath((settings.toolPaths || {}).wdckit, settings)
    : (tid === 'seachest') ? expandPath((settings.toolPaths || {}).seachest, settings) : '';
  const warns = [];
  let inner = '', cmd = '';
  if (tid === 'hugo') {
    /* 用户 2026-09-19：日立批量用 -m <型号>，一条命令一起格。
       ⚠️ 2026-09-20 真机测试抓到的 BUG：批里只有 1 块盘时用 -m 会把「同型号、但不在本批」的盘一起格里
       （sdd 单盘有缺陷 → -m HUS724040ALS640 命中 sdd/sdh/sdk 三块，日志 “Format device on 3 Device(s)”）。
       → 修正：只有「该型号的盘全部都在本批内」时才用 -m；否则退回按序列号 -s 精确指定。
       （cfg.allDisks 由 autoformat 传入本机全盘列表；不传时保持旧行为，兼容手动批量。） */
    const models = []; for (const d of list) if (d.model && !models.includes(d.model)) models.push(d.model);
    const all = Array.isArray(cfg.allDisks) ? cfg.allDisks : null;
    let modelSafe = models.length > 0;
    if (modelSafe && all) {
      for (const m of models) {
        const total = all.filter((x) => (x.model || '') === m).length;
        const inBatch = list.filter((x) => (x.model || '') === m).length;
        if (inBatch < total) { modelSafe = false; break; }
      }
    }
    if (modelSafe) {
      inner = 'format ' + models.map((m) => `-m ${shq(m)}`).join(' ') + ` --merge -b ${size}`;
      warns.push('-m 按型号整批格（该型号的盘全部都在本批内）');
    } else if (list.every((d) => d.serial)) {
      inner = 'format ' + list.map((d) => `-s ${shq(d.serial)}`).join(' ') + ` --merge -b ${size}`;
      warns.push('按序列号 -s 精确指定（避免 -m 误伤同型号其它盘）');
    } else {
      inner = 'format ' + models.map((m) => `-m ${shq(m)}`).join(' ') + ` --merge -b ${size}`;
      warns.push('⚠️ 无序列号可用 → 退回 -m 按型号匹配（同型号盘会一起被格）');
    }
    cmd = `sudo ${bin} ${inner}`;
  } else if (tid === 'wdckit') {
    if (list.every((d) => d.serial)) {
      inner = 'format ' + list.map((d) => `--serial ${shq(d.serial)}`).join(' ') + ` --merge -b ${size}`;
      warns.push('一条命令多盘（--serial 逐个指定），不会误伤同型号其它盘');
    } else {
      inner = 'format ' + list.map((d) => shq(d.device)).join(' ') + ` --merge -b ${size}`;
      warns.push('部分盘无序列号 → 改用设备名');
    }
    cmd = `sudo ${bin} ${inner}`;
  } else if (tid === 'seachest') {
    const seaName = require('path').basename(bin || 'SeaChest_Format_linux_x86_64');
    inner = `${seaName} ` + list.map((d) => `-d ${d.sg || d.device}`).join(' ') + ` --setSectorSize ${size} --confirm this-will-erase-data-and-may-render-the-drive-inoperable`;
    cmd = `sudo ${inner}`;
  } else if (tid === 'sg_format' || tid === 'toshiba_sas') {
    /* 用户 2026-09-19：希捷/东芝也是同一批，用一条批量 sg_format 命令一起格（并行） */
    const devs = list.map((d) => d.sg || d.device);
    const par = Number.isFinite(Number(settings.sgConcurrency)) ? Number(settings.sgConcurrency) : 0;
    inner = "printf '%s\\n' " + devs.join(' ') + ` | xargs -I{} -P ${par} sudo sg_format -v --format --size=${size} {}`;
    cmd = "bash -lc " + shq(inner);
    warns.push(`一条命令并行格 ${devs.length} 块（-P ${par === 0 ? '不限并发' : par}）`);
  } else {
    return null;
  }
  return {
    toolId: tid, toolName: tool ? tool.name : tid, mode: cfg.mode || '', lunSize: size,
    inToolCommand: inner, command: cmd, cwd, binPath: bin, warnings: warns,
    isBatch: list.length > 1, count: list.length,
    devices: list.map((x) => ({ id: x.id, device: x.device, sg: x.sg, model: x.model || '', serial: x.serial || '', brand: x.brand, interfaceType: x.interfaceType })),
  };
}
module.exports = { TOOLS, evaluateDefect, recommendTool, renderCommand, renderBatch, renderToolGroup, batchKey, preflight, fmtGB, toolBin, shq, expandPath };
