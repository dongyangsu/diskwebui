'use strict';
/* 构建指纹：给一套代码算一个短哈希，节点之间用它比对版本（自动同步更新用） */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '0.3.0';

/* 只对“清单内”的文件算指纹：多出来的野文件（如误拷的 lib/server.js）不应影响版本比对 */
const KNOWN_LIB = ['autoformat.js', 'autoupdate.js', 'build.js', 'clean.js', 'detect.js', 'exec.js', 'rules.js', 'store.js', 'tls.js', 'tools.js'];
const KNOWN_PUBLIC = ['app.js', 'index.html', 'style.css'];

function fileList(dir) {
  const base = dir || path.join(__dirname, '..');
  const out = ['server.js'];
  for (const f of KNOWN_LIB) if (fs.existsSync(path.join(base, 'lib', f))) out.push('lib/' + f);
  for (const f of KNOWN_PUBLIC) if (fs.existsSync(path.join(base, 'public', f))) out.push('public/' + f);
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
