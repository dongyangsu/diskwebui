'use strict';
/* HTTPS 支持：自动生成自签证书（含本机所有 IP 的 SAN），放在 data/tls/ 下。
   用 openssl 生成（兼容老系统：走 -config 而不是 -addext）。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'data', 'tls');
const KEY = path.join(DIR, 'key.pem');
const CRT = path.join(DIR, 'cert.pem');

function localIPs() {
  const out = ['127.0.0.1'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && out.indexOf(i.address) < 0) out.push(i.address);
  }
  return out;
}

function ensureCert(settings) {
  fs.mkdirSync(DIR, { recursive: true });
  const ips = localIPs();
  const cfg = path.join(DIR, 'openssl.cnf');
  const want = { ips, host: os.hostname() };
  const stamp = path.join(DIR, 'sans.json');
  let have = null;
  try { have = JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch (e) { have = null; }
  const need = !fs.existsSync(KEY) || !fs.existsSync(CRT)
    || !have || JSON.stringify(have.ips) !== JSON.stringify(want.ips) || have.host !== want.host;
  if (need) {
    const alt = ips.map((ip, i) => `IP.${i + 1}=${ip}`).join('\n') + `\nDNS.1=localhost\nDNS.2=${want.host}`;
    fs.writeFileSync(cfg, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=disk-webui\nO=disk-webui\n[v3]\nsubjectAltName=@alt\nbasicConstraints=CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment\n[alt]\n${alt}\n`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', KEY, '-out', CRT, '-config', cfg], { stdio: 'ignore' });
    fs.writeFileSync(stamp, JSON.stringify(want, null, 2));
  }
  return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT), ips, dir: DIR };
}

module.exports = { ensureCert, localIPs };
