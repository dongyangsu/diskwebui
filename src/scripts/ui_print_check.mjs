import { spawn } from "node:child_process";
import fs from "node:fs";
const jar = JSON.parse(fs.readFileSync("/tmp/tok.json", "utf8"));
let tk = ""; for (const k of Object.keys(jar)) { if (tk === "" || jar[k].exp > jar[tk].exp) tk = k; }
const PORT = 9370, PROFILE = "/tmp/chrome-printchk";
fs.rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn("/usr/bin/google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-gpu", "--window-size=1700,950", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 40; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p && p.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch (e) {} }
const ws = new WebSocket(wsUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const cdp = (m, p = {}) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); return new Promise((r) => pend.set(mid, r)); };
const js = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
await cdp("Page.enable"); await cdp("Runtime.enable");
await cdp("Page.navigate", { url: "http://192.168.2.139:8090" }); await sleep(3000);
await js(`localStorage.setItem('dw_token', ${JSON.stringify(tk)}); 1`);
await cdp("Page.reload"); await sleep(3500);
await js(`document.querySelector('.tab[data-view="machines"]').click(); 1`); await sleep(4200);
await js(`printTable(true); 1`); await sleep(500);
await cdp("Emulation.setEmulatedMedia", { media: "print" });
await sleep(400);
const pdf = await cdp("Page.printToPDF", { printBackground: true });
if (pdf.result && pdf.result.data) { fs.writeFileSync("/tmp/print_preview2.pdf", Buffer.from(pdf.result.data, "base64")); console.log("PDF 已生成"); }
console.log("打印区文本:", String(await js(`document.querySelector('#printHead').innerText`)).replace(/\n/g, " ｜ "));
await cdp("Emulation.setEmulatedMedia", { media: "screen" });
ws.close(); chrome.kill(); console.log("== 关闭 ==");
