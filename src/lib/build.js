'use strict';
/* 构建指纹：给一套代码算一个短哈希，节点之间用它比对版本（自动同步更新用） */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '0.4.0';

/* 只对“清单内”的文件算指纹：多出来的野文件（如误拷的 lib/server.js）不应影响版本比对 */
const KNOWN_LIB = ['autoformat.js', 'autoupdate.js', 'brandlookup.js', 'build.js', 'clean.js', 'detect.js', 'exec.js', 'rules.js', 'store.js', 'tls.js', 'tools.js'];
const KNOWN_PUBLIC = ['app.js', 'index.html', 'style.css'];
/* 前端内置依赖（xterm.js 真终端）——2026-09-30 加入清单：
   ⚠️ 教训：这些文件若不在清单里，节点自动同步会漏拷 → 启动即崩（.59 曾因漏拷 lib/brandlookup.js 崩溃循环）。
   新增任何 runtime 文件时，务必同步加进这里的清单。 */
const KNOWN_VENDOR = ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-web-links.js'];
const KNOWN_SCRIPTS = ['make_label.py', 'ptyshell.py', 'ui_suite.mjs', 'ui_print_check.mjs', 'release_checklist.md'];

function fileList(dir) {
  const base = dir || path.join(__dirname, '..');
  const out = ['server.js'];
  for (const f of KNOWN_LIB) if (fs.existsSync(path.join(base, 'lib', f))) out.push('lib/' + f);
  for (const f of KNOWN_PUBLIC) if (fs.existsSync(path.join(base, 'public', f))) out.push('public/' + f);
  for (const f of KNOWN_VENDOR) if (fs.existsSync(path.join(base, 'public', 'vendor', f))) out.push('public/vendor/' + f);
  for (const f of KNOWN_SCRIPTS) if (fs.existsSync(path.join(base, 'scripts', f))) out.push('scripts/' + f);
  return out;
}

function compute(dir) {
  const h = crypto.createHash('md5');
  h.update(VERSION);
  for (const f of fileList(dir || path.join(__dirname, '..'))) {
    try { h.update(fs.readFileSync(path.join(dir || path.join(__dirname, '..'), f))); } catch (e) {}
  }
  return h.digest('hex').slice(0, 12);
}

module.exports = { VERSION, compute, fileList };
