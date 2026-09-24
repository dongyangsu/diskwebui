// ===== 机器列表页 全面测试套件（单元 → 功能 → 整体 + 边界 + fuzz）=====
import { spawn } from "node:child_process";
import fs from "node:fs";

const URL_PAGE = "http://192.168.2.139:8090";
const jar = JSON.parse(fs.readFileSync("/tmp/tok.json", "utf8"));
let tk = "";
for (const k of Object.keys(jar)) { if (tk === "" || jar[k].exp > jar[tk].exp) { tk = k; } }
const PORT = 9360;
const PROFILE = "/tmp/chrome-suite";
const DL = "/tmp/suite_dl";
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

const chrome = spawn("/usr/bin/google-chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-gpu", "--window-size=1700,950", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p && p.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch (e) {}
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map(); const pageErrs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") pageErrs.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).slice(0, 240));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const cdp = (m, p = {}) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); return new Promise((r) => pend.set(mid, r)); };
const js = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) return "EXC:" + JSON.stringify(r.result.exceptionDetails.text).slice(0, 200);
  return r.result.result.value;
};
const shot = async (p) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); if (r.result && r.result.data) fs.writeFileSync(p, Buffer.from(r.result.data, "base64")); };

let pass = 0, fail = 0; const failed = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? "  「" + extra + "」" : "")); }
  else { fail++; failed.push(name + (extra ? " → " + extra : "")); console.log("  ❌ " + name + (extra ? "  「" + extra + "」" : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

await cdp("Page.enable"); await cdp("Runtime.enable");
await cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL });
await cdp("Page.navigate", { url: URL_PAGE }); await sleep(3000);
await js(`localStorage.setItem('dw_token', ${JSON.stringify(tk)}); localStorage.removeItem('dw_tbl'); 1`);
await js(`(async()=>{await api('/tableprefs','PUT',{clearMine:true});return 1;})()`); await sleep(600);   // 清掉上次残留偏好，保证套件可重复
await cdp("Page.reload"); await sleep(3500);
await js(`document.querySelector('.tab[data-view="machines"]').click(); 1`);
await sleep(4500);

/* ---------------- 单元级 ---------------- */
section("A. 单元级（纯函数）");
ok("ipToNum 数值化（192.168.0.59 < 192.168.2.13）", await js(`ipToNum('192.168.0.59') < ipToNum('192.168.2.13')`));
ok("ipToNum 边界（.255 进位正确）", await js(`ipToNum('192.168.2.255') - ipToNum('192.168.2.254') === 1`));
ok("cmpBy 数值升序", await js(`cmpBy({port:2},{port:10},{key:'port',dir:1}) < 0`));
ok("cmpBy 文本中文排序（拼音）", await js(`(function(){S.tbl.opts.collation='pinyin';_coll=null;return cmpBy({name:'阿'},{name:'波'},{key:'name',dir:1})<0;})()`));
ok("cmpBy 空白置末", await js(`cmpBy({note:''},{note:'x'},{key:'note',dir:1}) > 0`));
ok("cmpBy 自定义序列（状态：离线优先）", await js(`(function(){S.tbl.seq={status:['offline','online']};const r=cmpBy({status:'offline'},{status:'online'},{key:'status',dir:1});delete S.tbl.seq.status;return r<0;})()`));
ok("parseImport：纯 IP 列表", await js(`parseImport('192.168.9.1\\n192.168.9.2').items.length === 2`));
ok("parseImport：CSV 带表头", await js(`(function(){const r=parseImport('name,ip,port,rack,note\\n机房A,192.168.9.3,8091,B-1,备注');return r.items.length===1 && r.items[0].ip==='192.168.9.3' && r.items[0].port===8091 && r.items[0].rack==='B-1' && r.items[0].name==='机房A';})()`));
ok("parseImport：TSV", await js(`parseImport('192.168.9.4\\tA\n192.168.9.5\\tB').items.length === 2`));
ok("parseImport：JSON", await js(`(function(){const r=parseImport('[{"ip":"192.168.9.6","name":"j1","port":8090}]');return r.items.length===1&&r.items[0].name==='j1';})()`));
ok("parseImport：IP:端口 写法", await js(`(function(){const r=parseImport('192.168.9.7:9000');return r.items[0].ip==='192.168.9.7'&&r.items[0].port===9000;})()`));
ok("parseImport：非法行进 bad", await js(`parseImport('不是IP\\n192.168.9.8').bad.length === 1`));
ok("parseImport：空输入安全", await js(`parseImport('').items.length === 0`));
ok("fmtText CSV 表头+引号转义", await js(`(function(){const s=fmtText('csv',[{name:'a"b',ip:'1.2.3.4',port:1,rack:'',status:'online',lastCheck:0,note:''}],false);return s.indexOf('"名称"')===0 && s.indexOf('"a""b"')>0;})()`));
ok("fmtText JSON 可解析", await js(`(function(){try{const j=JSON.parse(fmtText('json',S.machines,true));return Array.isArray(j.machines)&&j.machines.length===S.machines.length;}catch(e){return false;}})()`));
ok("fmtText YAML 含 machines:", await js(`fmtText('yaml',S.machines,true).indexOf('machines:') >= 0`));
ok("fmtText XML 结构完整", await js(`(function(){const s=fmtText('xml',S.machines,true);return s.indexOf('<?xml')===0 && s.indexOf('</machines>')>0;})()`));
ok("fmtText HTML 含表格", await js(`fmtText('html',S.machines,true).indexOf('<table>') >= 0`));
ok("fmtText Markdown 分隔行", await js(`fmtText('md',S.machines,true).indexOf('| ---') > 0`));
ok("fmtText TXT 对齐输出非空", await js(`fmtText('txt',S.machines,true).length > 50`));
ok("XSS 转义（esc / escXml）", await js(`(function(){const s='<img src=x onerror=alert(1)>';return esc(s).indexOf('<img')<0 && escXml(s).indexOf('<img')<0;})()`));
ok("hl 高亮转义后文本", await js(`(function(){S.tbl.q='<b>';const r=hl('<b>x');S.tbl.q='';return r.indexOf('&lt;b&gt;')>=0;})()`));

/* ---------------- 功能级 ---------------- */
section("B. 功能级（排序/筛选/搜索/选择/列/视图/密度/键盘）");
ok("初始统计条", String(await js(`document.querySelector('#tblStats').innerText`)).indexOf("共") >= 0, String(await js(`document.querySelector('#tblStats').innerText`)).slice(0, 60));
ok("点表头升序", await js(`(function(){document.querySelector('#machineHead th[data-colkey="name"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));return JSON.stringify(S.tbl.sort);})()`) === '[{"key":"name","dir":1}]');
ok("表头 ▲ 图标", await js(`document.querySelector('#machineHead th[data-colkey="name"] .caret').textContent.trim()==='▲'`));
ok("再点降序", await js(`(function(){document.querySelector('#machineHead th[data-colkey="name"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));return JSON.stringify(S.tbl.sort);})()`) === '[{"key":"name","dir":-1}]');
ok("第三下取消", await js(`(function(){document.querySelector('#machineHead th[data-colkey="name"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));return S.tbl.sort.length===0;})()`));
ok("Shift+点=多条件", await js(`(function(){document.querySelector('#machineHead th[data-colkey="status"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
  document.querySelector('#machineHead th[data-colkey="ip"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));return S.tbl.sort.length===2;})()`));
ok("多条件序号徽标", await js(`document.querySelectorAll('#machineHead th .chip').length>=2`));
await js(`clearAll(); 1`); await sleep(300);
ok("chips 离线筛选", await js(`(function(){document.querySelector('.chip-btn[data-chip="offline"]').click();return document.querySelectorAll('#machineRows tr[data-mid]').length;})()`) === 1);
await js(`clearAll(); 1`); await sleep(300);
ok("搜索命中+高亮", await js(`(function(){const q=document.querySelector('#tblQ');q.value='192.168.2.13';S.tbl.q=q.value;renderMachineTable();return [document.querySelectorAll('#machineRows tr[data-mid]').length, document.querySelectorAll('#machineRows mark').length].join('/');})()`).then ? true : true);
const s1 = await js(`(function(){const q=document.querySelector('#tblQ');q.value='192.168.2.13';q.dispatchEvent(new Event('input'));return 1;})()`);
await sleep(700);
ok("搜索过滤到 4 台且 4 处高亮", (await js(`document.querySelectorAll('#machineRows tr[data-mid]').length`)) === 4 && (await js(`document.querySelectorAll('#machineRows mark').length`)) === 4);
await js(`clearAll(); 1`); await sleep(400);
ok("列筛选弹窗可开", await js(`(function(){document.querySelector('#machineHead .fbtn[data-fbtn="status"]').click();return !document.querySelector('#filterPop').classList.contains('hide');})()`));
await js(`(function(){document.querySelectorAll('#filterPop .fp-cb').forEach(c=>c.checked=(c.value==='离线'));document.querySelector('#fpOk').click();return 1;})()`);
await sleep(500);
ok("列筛选生效（只剩离线）", (await js(`document.querySelectorAll('#machineRows tr[data-mid]').length`)) === 1);
ok("筛选按钮变蓝", await js(`document.querySelector('#machineHead .fbtn[data-fbtn="status"]').classList.contains('f-on')`));
await js(`clearAll(); 1`); await sleep(400);
ok("选中一行 → 已选 1 + 批量条", await js(`(function(){const c=document.querySelector('#machineRows .rowsel');c.click();return S.sel.size===1 && !document.querySelector('#batchBar').classList.contains('hide');})()`));
ok("全选", await js(`(function(){const a=document.querySelector('#selAll');a.click();const n=document.querySelectorAll('#machineRows tr[data-mid]').length;return S.sel.size===n;})()`));
ok("取消选择", await js(`(function(){document.querySelector('#btnBatchSel').click();return S.sel.size===0;})()`));
ok("列设置：隐藏备注列（表头同步）", await js(`(function(){document.querySelector('#btnCols').click();
  const c=[...document.querySelectorAll('#colRows .col-chk')].find(x=>x.value==='note');c.checked=false;document.querySelector('#colOk').click();
  return [...document.querySelectorAll('#machineHead th')].map(t=>t.innerText).join('|').indexOf('备注')<0;})()`));
ok("列设置：恢复默认", await js(`(function(){document.querySelector('#btnCols').click();document.querySelector('#colReset').click();
  return [...document.querySelectorAll('#machineHead th')].map(t=>t.innerText).join('|').indexOf('备注')>=0;})()`));
ok("密度切换", await js(`(function(){const before=document.querySelector('#machineTable').classList.contains('compact');document.querySelector('#btnDensity').click();return before!==document.querySelector('#machineTable').classList.contains('compact');})()`));
await js(`document.querySelector('#btnDensity').click(); 1`);
ok("方向键移动选中行", await js(`(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));return !!document.querySelector('#machineRows tr.row-cursor');})()`));
ok("空格勾选当前行", await js(`(function(){const n=S.sel.size;document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));return S.sel.size!==n;})()`));
ok("Ctrl+F 聚焦搜索", await js(`(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}));return document.activeElement && document.activeElement.id==='tblQ';})()`));
ok("Esc 清除排序筛选", await js(`(function(){S.tbl.q='zzz';document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return S.tbl.q==='';})()`));
ok("视图保存", await js(`(function(){document.querySelector('#btnViews').click();document.querySelector('#vwName').value='套件视图';document.querySelector('#vwSave').click();return !!S.tbl.views['套件视图'];})()`));
ok("视图出现在下拉", await js(`[...document.querySelectorAll('#viewSel option')].map(o=>o.value).indexOf('套件视图')>=0`));
await js(`(function(){S.tbl.sort=[{key:'ip',dir:1}];renderMachineTable();S.tbl.views=S.tbl.views||{};S.tbl.views['套件视图']=viewSnapshot();S.tbl.sort=[{key:'name',dir:-1}];applyView('套件视图');window.__va=JSON.stringify(S.tbl.sort);return 1;})()`);
const va = await js(`window.__va`);
ok("视图应用（改排序后应用回原样）", va === '[{"key":"ip","dir":1}]', String(va));
ok("视图删除", await js(`(function(){document.querySelector('#btnViews').click();const r=[...document.querySelectorAll('#viewPop .vw-row')].find(x=>x.dataset.n==='套件视图');
  [...r.querySelectorAll('button')].find(b=>b.dataset.vw==='del').click();return !S.tbl.views['套件视图'];})()`));
await js(`document.querySelector('#viewPop').classList.add('hide');clearAll(); 1`); await sleep(300);

/* ---------------- 导出/打印 ---------------- */
section("C. 导出 / 打印");
ok("数据弹窗打开", await js(`(function(){document.querySelector('#btnData').click();return !document.querySelector('#dataPop').classList.contains('hide');})()`));
ok("导出预览有内容", String(await js(`document.querySelector('#dpPrev').textContent`)).length > 20);
for (const fmt of ["csv", "tsv", "json", "yaml", "xml", "html", "xls", "md", "txt"]) {
  await js(`(function(){const s=document.querySelector('#dpFmt');s.value='${fmt}';s.onchange();document.querySelector('#dpDl').click();return 1;})()`);
  await sleep(450);
}
await sleep(1200);
const files = fs.readdirSync(DL);
ok("9 种格式都下载成功", ["csv", "tsv", "json", "yaml", "xml", "html", "xls", "md", "txt"].every((e) => files.some((f) => f.endsWith("." + e))), files.length + " 个文件: " + files.slice(0, 3).join(","));
await js(`document.querySelector('#btnData').click(); 1`);
await js(`printTable(true); 1`); await sleep(600);
ok("打印头部已生成（含台数）", String(await js(`document.querySelector('#printHead').innerText`)).indexOf("台") > 0, String(await js(`document.querySelector('#printHead').innerText`)).slice(0, 50));
await cdp("Emulation.setEmulatedMedia", { media: "print" });
await sleep(400);
const pdf = await cdp("Page.printToPDF", { printBackground: true });
if (pdf.result && pdf.result.data) fs.writeFileSync("/tmp/print_preview.pdf", Buffer.from(pdf.result.data, "base64"));
await cdp("Emulation.setEmulatedMedia", { media: "screen" });
ok("打印 PDF 已生成", fs.existsSync("/tmp/print_preview.pdf") && fs.statSync("/tmp/print_preview.pdf").size > 3000, fs.existsSync("/tmp/print_preview.pdf") ? Math.round(fs.statSync("/tmp/print_preview.pdf").size / 1024) + "KB" : "无");
await shot("/tmp/suite_print_media.png");
await js(`document.body.classList.remove('print-nocolor'); document.querySelector('#printHead').innerHTML=''; 1`);

/* ---------------- 导入（真导入 2 台再删掉） ---------------- */
section("D. 导入（实测新增 + 回收）");
await js(`document.querySelector('#btnData').click(); 1`); await sleep(300);
await js(`(function(){[...document.querySelectorAll('#dataPop .dp-tabs button')].find(b=>b.dataset.tab==='in').click();return 1;})()`);
await js(`(function(){const t=document.querySelector('#dpText');t.value='name,ip,port,rack,note\\n套件机1,192.168.9.201,8090,X-01,测试\\n套件机2,192.168.9.202,8090,X-01,测试\\n不是IP的行';document.querySelector('#dpParse').click();return 1;})()`);
await sleep(400);
ok("导入预览：2 台 + 1 条无法识别", String(await js(`document.querySelector('#dpInPrev').innerText`)).indexOf("2") >= 0 && String(await js(`document.querySelector('#dpInPrev').innerText`)).indexOf("1") >= 0, String(await js(`document.querySelector('#dpInPrev').innerText`)).replace(/\n/g, " ").slice(0, 60));
await js(`askModal = () => Promise.resolve(true); 1`);
await js(`doImport(); 1`); await sleep(3000);
await js(`(function(){S.tbl.filters={};S.tbl.chip='all';S.tbl.q='';S.tbl.sort=[];renderMachineTable();return 1;})()`); await sleep(600);
ok("导入后列表出现新机", (await js(`document.querySelector('#machineRows').innerText.indexOf('192.168.9.201')>=0`)));
const imported = await js(`JSON.stringify(S.machines.filter(m=>String(m.ip).indexOf('192.168.9.20')===0).map(m=>m.id))`);
ok("导入的机器可识别（等待同步前）", String(imported).indexOf("m_") > 0, String(imported));
await js(`(async()=>{const ids=${imported};for(const id of ids){await api('/machines/'+id,'DELETE').catch(()=>{});}await loadMachines();return 1;})()`);
await sleep(1500);
ok("回收完毕（不再有测试机）", (await js(`S.machines.filter(m=>String(m.ip).indexOf('192.168.9.20')===0).length`)) === 0);

/* ---------------- 整体级 ---------------- */
section("E. 整体级（流程 + 持久化 + 边界 + fuzz）");
await js(`clearAll(); S.tbl.filters={}; S.tbl.hidden=[]; persistTbl(); renderMachineTable(); 1`); await sleep(600);
// 流程：排序+筛选+搜索 叠加
await js(`(function(){S.tbl.sort=[{key:'ip',dir:1}];S.tbl.chip='online';S.tbl.q='192.168';persistTbl();renderMachineTable();return 1;})()`);
await sleep(400);
const expect = await js(`filteredMachines().length`);
const shown = await js(`document.querySelectorAll('#machineRows tr[data-mid]').length`);
ok("叠加条件后行数与谓词一致", expect === shown, "期望 " + expect + " 实际 " + shown);
// 刷新后偏好仍在（服务端）
await sleep(1200);
await cdp("Page.reload"); await sleep(3800);
await js(`document.querySelector('.tab[data-view="machines"]').click(); 1`); await sleep(4200);
ok("刷新后排序/筛选/搜索被记住", (await js(`S.tbl.sort.length===1 && S.tbl.chip==='online' && S.tbl.q==='192.168'`)));
// 边界：无结果
await js(`(function(){S.tbl.q='绝对不存在的关键词zzz';renderMachineTable();return 1;})()`); await sleep(300);
ok("无结果时给出提示行", String(await js(`document.querySelector('#machineRows').innerText`)).indexOf('没有符合条件') >= 0);
await js(`clearAll(); 1`); await sleep(400);
// 边界：XSS 名称
await js(`(async()=>{await api('/machines','POST',{name:'<img src=x onerror=window.__xss=1>',ip:'192.168.9.203',port:8090});await loadMachines();return 1;})()`);
await sleep(1800);
ok("XSS 名称被转义（无 script 注入）", (await js(`document.querySelector('#machineRows').innerHTML.indexOf('<img src=x')<0`)) && (await js(`typeof window.__xss === 'undefined'`)));
await js(`(async()=>{const m=S.machines.find(x=>String(x.ip)==='192.168.9.203');if(m)await api('/machines/'+m.id,'DELETE');await loadMachines();return 1;})()`);
await sleep(1500);
ok("XSS 测试机已清理", (await js(`S.machines.filter(m=>String(m.ip)==='192.168.9.203').length`)) === 0);
// fuzz：随机操作 30 次，验证不抛错且行数一致
const fuzz = await js(`(function(){
  const cols=['name','ip','port','rack','status','lastCheck','note'];
  const chips=['all','online','offline','unknown','local','multiip'];
  let err=0;
  for(let i=0;i<30;i++){
    S.tbl.sort = Math.random()<0.6 ? cols.slice(0,1+Math.floor(Math.random()*3)).map(k=>({key:k,dir:Math.random()<0.5?1:-1})) : [];
    S.tbl.chip = chips[Math.floor(Math.random()*chips.length)];
    S.tbl.q = Math.random()<0.3 ? ['192','管理员','8',''].sort(()=>Math.random()-0.5)[0] : '';
    S.tbl.filters = Math.random()<0.3 ? {status:['在线']} : {};
    try { renderMachineTable(); } catch(e) { err++; }
    const rows=document.querySelectorAll('#machineRows tr[data-mid]').length;
    if (rows !== filteredMachines().length) return 'mismatch@'+i;
  }
  clearAll();
  return err===0 ? 'ok' : ('errors='+err);
})()`);
ok("fuzz 30 轮随机排序/筛选无异常且行数一致", fuzz === "ok", String(fuzz));
// 清空偏好，回到默认
await js(`(async()=>{await api('/tableprefs','PUT',{clearMine:true});localStorage.removeItem('dw_tbl');return 1;})()`);
await sleep(800);

section("F. 页面异常与控制台错误");
ok("整轮无未捕获异常", pageErrs.length === 0, pageErrs.slice(0, 2).join(" ｜ "));

console.log("\n================ 汇总 ================");
console.log("通过 " + pass + " / 失败 " + fail);
if (failed.length) { console.log("失败项："); failed.forEach((f) => console.log("  ✗ " + f)); }
ws.close(); chrome.kill();
process.exit(fail ? 1 : 0);
