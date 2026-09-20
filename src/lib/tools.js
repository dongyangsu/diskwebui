'use strict';
/* 工具包自动探测：不同机器上 hugo / wdckit / SeaChestUtilities 的版本与可执行文件名都不一样，
   这里在本地文件系统里扫一遍，找到真实路径，避免写死。 */
const fs = require('fs');
const path = require('path');

function isExec(p) {
  try { const s = fs.statSync(p); return s.isFile() && (s.mode & 0o111) !== 0 && s.size > 0; } catch (e) { return false; }
}
function list(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
}
/* 版本号排序用：把 hugo-7.4.5.x86_64 / wdckit-3.0.2.0-x86_64 里的数字提取出来 */
function verKey(name) {
  const m = name.match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : [0];
}
function cmpVerDesc(a, b) {
  const A = verKey(a), B = verKey(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return y - x;
  }
  return 0;
}

function detect(home) {
  home = home || process.env.HOME || '/root';
  const out = { hugo: null, wdckit: null, seachest: null, scannedHome: home, all: { hugo: [], wdckit: [], seachest: [] } };
  const entries = list(home);

  /* hugo（日立/HGST）：目录 hugo-*，内含可执行文件 hugo */
  const hugoDirs = entries.filter((e) => e.isDirectory() && /^hugo-[\d.]+[.\-_]x86_64$/i.test(e.name)).map((e) => e.name).sort(cmpVerDesc);
  for (const d of hugoDirs) {
    const p = path.join(home, d);
    for (const b of ['hugo', 'HUGO']) {
      if (isExec(path.join(p, b))) { out.all.hugo.push({ path: p, bin: b, dir: d }); break; }
    }
  }
  if (out.all.hugo.length) out.hugo = { path: out.all.hugo[0].path, bin: out.all.hugo[0].bin, dir: out.all.hugo[0].dir };

  /* wdckit（西数）：目录 wdckit-*，内含可执行文件 wdckit */
  const wdDirs = entries.filter((e) => e.isDirectory() && /^wdckit-[\d.]+[.\-_]x86_64$/i.test(e.name)).map((e) => e.name).sort(cmpVerDesc);
  for (const d of wdDirs) {
    const p = path.join(home, d);
    if (isExec(path.join(p, 'wdckit'))) out.all.wdckit.push({ path: p, bin: 'wdckit', dir: d });
  }
  if (out.all.wdckit.length) out.wdckit = Object.assign({}, out.all.wdckit[0]);

  /* SeaChest（希捷）：在 SeaChestUtilities 下递归找 SeaChest_Format* 可执行文件（名字各版本不同） */
  const roots = entries.filter((e) => e.isDirectory() && /^SeaChest/i.test(e.name)).map((e) => path.join(home, e.name));
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6 || found.length > 60) return;
    for (const e of list(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^SeaChest_Format/i.test(e.name) && isExec(p)) found.push(p);
    }
  };
  for (const r of roots) walk(r, 1);
  /* 优先 Non-RAID / Linux / x86_64，其次路径最短 */
  found.sort((a, b) => {
    const score = (s) => (/Non-RAID/i.test(s) ? 4 : 0) + (/\/Linux\//i.test(s) ? 2 : 0) + (/x86_64/i.test(s) ? 1 : 0);
    return (score(b) - score(a)) || (a.length - b.length);
  });
  for (const f of found) out.all.seachest.push({ path: path.dirname(f), bin: path.basename(f) });
  if (out.all.seachest.length) out.seachest = Object.assign({}, out.all.seachest[0]);

  out.summary = {
    hugo: out.hugo ? `${out.hugo.path}/${out.hugo.bin}` : null,
    wdckit: out.wdckit ? `${out.wdckit.path}/${out.wdckit.bin}` : null,
    seachest: out.seachest ? `${out.seachest.path}/${out.seachest.bin}` : null,
  };
  return out;
}

module.exports = { detect, isExec };
