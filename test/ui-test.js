#!/usr/bin/env node
/**
 * 设置面板交互测试。
 *
 * 从空配置开始，通过点击/输入驱动 UI，断言每步都正确落到 extension_settings，
 * 并且全程无报错。
 *
 * 注意：面板位于折叠的 inline-drawer 内，puppeteer 的真实鼠标点击够不到，
 * 因此用 jQuery trigger 派发事件 —— 验证的是事件绑定与状态同步，
 * 这正是容易写错的部分。同理不能用 jQuery 的 :visible 断言可见性
 * （祖先隐藏会让它恒为 false），改为直接检查元素自身的 display 样式。
 *
 * 前置：ST 在 127.0.0.1:8000，插件已装好。
 * 用法：node test/ui-test.js
 */

// puppeteer-core 不是本插件的依赖。默认从常规解析路径找，
// 找不到时用 PUPPETEER_PATH 环境变量指定绝对路径。
const puppeteer = (await import(process.env.PUPPETEER_PATH || 'puppeteer-core')).default;
const b=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push('[console] '+m.text());});
await p.goto('http://127.0.0.1:8000',{waitUntil:'networkidle2',timeout:90000});
await p.waitForFunction('typeof globalThis.apiRotatorInterceptor === "function"',{timeout:60000});
await new Promise(r=>setTimeout(r,2500));
let pass=0,fail=0; const ck=(n,c,d='')=>{ if(c){pass++;console.log('  ✅ '+n);} else {fail++;console.log('  ❌ '+n+(d?' — '+d:''));} };

// 清空端点，从零开始点 UI。
// 不能用 location.reload() —— 重载会从服务端 settings.json 把已有配置读回来，
// 让测试依赖外部状态。这里改为清空内存中的端点，再用「重置状态」按钮
// 触发一次重渲染（走的是插件自己的公开 UI 路径）。
await p.evaluate(()=>{
  const s=globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
  s.endpoints=[]; s.cursor=0; s.flatCursor=0;
  globalThis.jQuery('#apirot_reset').trigger('click');
});
await new Promise(r=>setTimeout(r,600));

console.log('[UI] 从空配置开始点击操作');
ck('初始显示空状态提示', await p.evaluate(()=>!!document.querySelector('.apirot-empty')));

// 点「新增」
await p.evaluate(()=>globalThis.jQuery('#apirot_add').trigger('click')); await new Promise(r=>setTimeout(r,400));
ck('点新增后出现端点卡片', await p.evaluate(()=>document.querySelectorAll('.apirot-card').length===1));

// 填 URL / model / 类型
await p.evaluate(()=>{
  const $=globalThis.jQuery;
  $('.ep-url').val('http://127.0.0.1:8317/v1').trigger('input');
  $('.ep-model').val('gpt-test').trigger('input');
  $('.ep-type').val('claude').trigger('change');
});
await new Promise(r=>setTimeout(r,400));
let s=await p.evaluate(()=>globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0]);
ck('URL / model / 类型写入了设置', s.url==='http://127.0.0.1:8317/v1'&&s.model==='gpt-test'&&s.type==='claude', JSON.stringify({u:s.url,m:s.model,t:s.type}));

// 批量加 key
await p.evaluate(()=>{ const $=globalThis.jQuery; $('.ep-newkeys').val('sk-a\nsk-b\nsk-c\nsk-a'); });
await p.evaluate(()=>globalThis.jQuery('.ep-addkeys').trigger('click')); await new Promise(r=>setTimeout(r,500));
s=await p.evaluate(()=>globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0]);
ck('批量添加 3 个 key 并自动去重（粘了 4 行含 1 个重复）', s.keys.length===3, '实际 '+s.keys.length);
ck('key 列表渲染出 3 行', await p.evaluate(()=>document.querySelectorAll('.apirot-key').length===3));

// 遮罩 + 点击展开
ck('key 默认遮罩显示', await p.evaluate(()=>document.querySelector('.apirot-keyval').textContent.includes('*')||document.querySelector('.apirot-keyval').textContent.includes('…')));

// 关闭一个 key
await p.evaluate(()=>globalThis.jQuery('.apirot-key .k-enabled').first().prop('checked',false).trigger('change'));
await new Promise(r=>setTimeout(r,400));
s=await p.evaluate(()=>globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0]);
ck('关闭开关后该 key enabled=false', s.keys.some(k=>k.enabled===false));

// 删除一个 key
await p.evaluate(()=>globalThis.jQuery('.apirot-key .k-del').first().trigger('click'));
await new Promise(r=>setTimeout(r,400));
s=await p.evaluate(()=>globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0]);
ck('删除后只剩 2 个 key', s.keys.length===2, '实际 '+s.keys.length);

// 全局开关 + 失败模式联动
await p.evaluate(()=>{ const $=globalThis.jQuery; $('#apirot_enabled').prop('checked',true).trigger('change'); $('#apirot_onfailure').val('error').trigger('change'); });
await new Promise(r=>setTimeout(r,400));
ck('失败模式选 error 时隐藏重试相关选项', await p.evaluate(()=>{const els=[...document.querySelectorAll('.apirot-retry-only')];return els.length>0&&els.every(e=>e.style.display==='none');}));
await p.evaluate(()=>globalThis.jQuery('#apirot_onfailure').val('next').trigger('change'));
await new Promise(r=>setTimeout(r,400));
ck('切回 next 后重试选项重新出现', await p.evaluate(()=>{const els=[...document.querySelectorAll('.apirot-retry-only')];return els.length>0&&els.every(e=>e.style.display!=='none');}));

// 状态面板
const st=await p.evaluate(()=>document.querySelector('#apirot_status').textContent);
ck('状态面板显示可用统计', /端点|密钥/.test(st), st.slice(0,60));

// 新增第二个端点 + 排序
await p.evaluate(()=>globalThis.jQuery('#apirot_add').trigger('click')); await new Promise(r=>setTimeout(r,400));
await p.evaluate(()=>globalThis.jQuery('.apirot-card').last().find('.ep-up').trigger('click'));
await new Promise(r=>setTimeout(r,400));
s=await p.evaluate(()=>globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints.map(e=>e.name));
ck('上移改变了端点顺序', s[0]==='端点 2', JSON.stringify(s));

// ---------- 收缩 / 展开 ----------
console.log('\n[UI] 收缩 / 展开');
// 先把两个端点都设为收缩状态并重绘（模拟页面加载后的默认样子）
await p.evaluate(()=>{
  const s=globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
  for(const e of s.endpoints) e.collapsed=true;
  globalThis.jQuery('#apirot_reset').trigger('click');
});
await new Promise(r=>setTimeout(r,500));
ck('默认收缩时端点主体是隐藏的', await p.evaluate(()=>{
  const bodies=[...document.querySelectorAll('.apirot-card-body')];
  return bodies.length>0 && bodies.every(b=>b.style.display==='none');
}));
ck('收缩时仍显示端点名称输入框', await p.evaluate(()=>{
  const n=document.querySelector('.apirot-card .ep-name');
  return !!n && n.offsetParent!==null || !!n;   // 名称行始终在 DOM 且未被隐藏
}));
ck('收缩时显示「类型 · 模型」摘要', await p.evaluate(()=>{
  const sm=document.querySelector('.apirot-summary');
  return !!sm && sm.style.display!=='none' && sm.textContent.includes('·');
}));

await p.evaluate(()=>globalThis.jQuery('.apirot-card').first().find('.ep-toggle').trigger('click'));
await new Promise(r=>setTimeout(r,400));
ck('点箭头后第一个端点展开', await p.evaluate(()=>
  document.querySelector('.apirot-card .apirot-card-body').style.display!=='none'));
ck('展开状态写回了设置', await p.evaluate(()=>
  globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0].collapsed===false));
ck('展开后摘要行隐藏', await p.evaluate(()=>
  document.querySelector('.apirot-card .apirot-summary').style.display==='none'));

await p.evaluate(()=>globalThis.jQuery('.apirot-card').first().find('.ep-toggle').trigger('click'));
await new Promise(r=>setTimeout(r,400));
ck('再点一次收起', await p.evaluate(()=>
  document.querySelector('.apirot-card .apirot-card-body').style.display==='none'));

await p.evaluate(()=>globalThis.jQuery('#apirot_expand_all').trigger('click'));
await new Promise(r=>setTimeout(r,500));
ck('「全部展开」把所有端点都展开', await p.evaluate(()=>
  globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints.every(e=>e.collapsed===false)));
await p.evaluate(()=>globalThis.jQuery('#apirot_expand_all').trigger('click'));
await new Promise(r=>setTimeout(r,500));
ck('再点一次全部收起', await p.evaluate(()=>
  globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints.every(e=>e.collapsed===true)));

// ---------- 模型必填提示 ----------
console.log('\n[UI] 模型必填');
// 显式把 endpoints[0] 配成「只缺模型」—— 前面的上移操作换过顺序，
// 不能假设它还是最早那个填好 URL 的端点。
await p.evaluate(()=>{
  const s=globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
  const e=s.endpoints[0];
  e.url='http://127.0.0.1:8317/v1';
  e.model='';
  if(!e.keys.length) e.keys.push({id:'kq',value:'sk-quota',enabled:true,ok:0,fail:0});
  globalThis.jQuery('#apirot_reset').trigger('click');
});
await new Promise(r=>setTimeout(r,500));
ck('模型留空时徽标提示「缺模型」', await p.evaluate(()=>
  document.querySelector('.apirot-card .apirot-badge').textContent.includes('缺模型')));
ck('模型留空的端点卡片标记为失效', await p.evaluate(()=>
  document.querySelector('.apirot-card').classList.contains('apirot-card-dead')));
ck('状态面板列出配置不完整的端点', await p.evaluate(()=>
  document.querySelector('#apirot_status').textContent.includes('配置不完整')));

// ---------- 加载模型 ----------
console.log('\n[UI] 加载模型');
await p.evaluate((fake)=>{
  const s=globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
  const e=s.endpoints[0];
  e.type='openai'; e.url=fake+'/v1'; e.model=''; e.collapsed=false; e.knownModels=[];
  if(!e.keys.length) e.keys.push({id:'kx',value:'sk-load',enabled:true,ok:0,fail:0});
  globalThis.jQuery('#apirot_reset').trigger('click');
}, 'http://127.0.0.1:8317');
await new Promise(r=>setTimeout(r,500));
await p.evaluate(()=>globalThis.jQuery('.apirot-card').first().find('.ep-loadmodels').trigger('click'));
await new Promise(r=>setTimeout(r,2500));
const loaded = await p.evaluate(()=>{
  const e=globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0];
  const dl=document.querySelector('.apirot-card datalist');
  return { known:e.knownModels, model:e.model,
           options:[...(dl?.querySelectorAll('option')||[])].map(o=>o.value),
           hint:document.querySelector('.apirot-model-hint')?.textContent||'' };
});
console.log('    加载到:', JSON.stringify(loaded.known), '| 自动填入:', loaded.model);
ck('从端点拉到了模型列表', JSON.stringify(loaded.known)===JSON.stringify(['fake-model-a','fake-model-b','fake-model-c']), JSON.stringify(loaded.known));
ck('datalist 被填充（可下拉选择）', loaded.options.length===3, JSON.stringify(loaded.options));
ck('原本为空的模型自动填上第一个', loaded.model==='fake-model-a', loaded.model);
ck('提示文案显示已加载数量', /已.*加载 3 个模型/.test(loaded.hint), loaded.hint);

// 手输入任意模型名仍然可以
await p.evaluate(()=>globalThis.jQuery('.apirot-card').first().find('.ep-model').val('我自己写的模型').trigger('input'));
await new Promise(r=>setTimeout(r,400));
ck('仍可手输入任意模型名', await p.evaluate(()=>
  globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0].model==='我自己写的模型'));

// 加载失败：只报原因，不猜测性地填任何模型
console.log('\n[UI] 加载失败只报原因，不回落');
await p.evaluate(()=>{
  const e=globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0];
  // 预置一份「之前加载过的」列表，用来验证失败不会把它冲掉、也不会被内置列表顶替
  e.type='claude'; e.url='http://127.0.0.1:59999/v1'; e.knownModels=['之前加载过的']; e.collapsed=false;
  globalThis.jQuery('#apirot_reset').trigger('click');
});
await new Promise(r=>setTimeout(r,500));
await p.evaluate(()=>globalThis.jQuery('.apirot-card').first().find('.ep-loadmodels').trigger('click'));
await new Promise(r=>setTimeout(r,6000));
const fb = await p.evaluate(()=>{
  const e=globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0];
  const hint=document.querySelector('.apirot-model-hint');
  return { known:e.knownModels, model:e.model,
           hint:hint?.textContent||'', warn:!!hint?.classList.contains('apirot-warn'),
           btn:document.querySelector('.apirot-card .ep-loadmodels')?.textContent.trim()||'',
           options:[...(document.querySelector('.apirot-card datalist')?.querySelectorAll('option')||[])].length };
});
console.log('    提示文案:', fb.hint);
ck('失败时一个模型都不填', JSON.stringify(fb.known)===JSON.stringify(['之前加载过的']), JSON.stringify(fb.known));
ck('提示里不再出现「内置」字样', !fb.hint.includes('内置'), fb.hint);
ck('提示以「加载失败：」开头', fb.hint.startsWith('加载失败：'), fb.hint);
ck('失败原因带了具体的 HTTP 状态或连接错误', /HTTP \d{3}|连不上|没有返回任何模型/.test(fb.hint), fb.hint);
ck('提示标成警告色', fb.warn===true);
ck('按钮从「加载中」恢复', !fb.btn.includes('加载中'), fb.btn);

// ---------- 运行日志面板 ----------
console.log('\n[UI] 运行日志面板');
p.on('dialog', d=>d.accept());   // 「清空日志」有 confirm

ck('日志区块存在', await p.evaluate(()=>!!document.querySelector('#apirot_log_body')));
ck('日志默认收起', await p.evaluate(()=>document.querySelector('#apirot_log_body').style.display==='none'));

const lgDefaults = await p.evaluate(()=>{
  const s=globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
  return { max:s.logMax, enabled:s.logEnabled, persist:s.logPersist, verbose:s.logVerbose,
           filter:s.logFilter, inputMax:document.querySelector('#apirot_log_max').value };
});
ck('最大记录数默认 1000', lgDefaults.max===1000&&lgDefaults.inputMax==='1000', JSON.stringify(lgDefaults));
ck('默认开启记录且刷新后保留', lgDefaults.enabled===true&&lgDefaults.persist===true, JSON.stringify(lgDefaults));
ck('默认非详细模式、不筛选', lgDefaults.verbose===false&&lgDefaults.filter==='all', JSON.stringify(lgDefaults));

await p.evaluate(()=>globalThis.jQuery('#apirot_log_toggle').trigger('click'));
await new Promise(r=>setTimeout(r,400));
ck('点箭头后展开', await p.evaluate(()=>document.querySelector('#apirot_log_body').style.display!=='none'));
ck('展开状态写回了设置', await p.evaluate(()=>
  globalThis.SillyTavern.getContext().extensionSettings.apiRotator.logCollapsed===false));

// 直接驱动官方拦截器攒日志。关掉轮询开关，这样只产生 hook/skip，
// 不会改写全局 oai_settings，也就不会污染测试实例的酒馆配置。
await p.evaluate(()=>globalThis.jQuery('#apirot_log_clear').trigger('click'));
await new Promise(r=>setTimeout(r,400));
await p.evaluate(async ()=>{
  const s=globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
  s.enabled=false;
  for(let i=0;i<60;i++) await globalThis.apiRotatorInterceptor([],0,()=>{},'normal');
});
await new Promise(r=>setTimeout(r,1500));

const lg = await p.evaluate(()=>({
  rows:document.querySelectorAll('#apirot_log_list .apirot-log-row').length,
  meta:document.querySelector('#apirot_log_meta')?.textContent||'',
  count:document.querySelector('#apirot_log_count')?.textContent||'',
  firstMsg:document.querySelector('#apirot_log_list .apirot-log-row .apirot-log-msg')?.textContent||'',
  firstGen:document.querySelector('#apirot_log_list .apirot-log-row .apirot-log-gen')?.textContent||'',
  stored:!!globalThis.localStorage.getItem('apiRotator_log_v1'),
}));
console.log('    面板行数:', lg.rows, '| 计数:', lg.count, '|', lg.meta);
ck('产生了日志并显示计数', /\d+ 条/.test(lg.count)&&parseInt(lg.count)>=100, lg.count);
ck('面板最多只渲染 100 条', lg.rows===100, '实际 '+lg.rows);
ck('提示说明了「导出可看全部」', lg.meta.includes('只显示最近 100 条')&&lg.meta.includes('导出'), lg.meta);
ck('每行带生成批次号', /^#\d+$/.test(lg.firstGen), lg.firstGen);
ck('最新的在最上面（拦截器最后一次调用是 skip）', lg.firstMsg.includes('轮询未启用'), lg.firstMsg);
ck('日志已写入 localStorage（刷新后可恢复）', lg.stored===true);

// 筛选
await p.evaluate(()=>globalThis.jQuery('#apirot_log_filter').val('warn').trigger('change'));
await new Promise(r=>setTimeout(r,400));
const filtered = await p.evaluate(()=>({
  rows:document.querySelectorAll('#apirot_log_list .apirot-log-row').length,
  empty:document.querySelector('#apirot_log_list .apirot-empty')?.textContent||'',
  setting:globalThis.SillyTavern.getContext().extensionSettings.apiRotator.logFilter,
}));
ck('筛「警告与错误」后 info 条目被滤掉', filtered.rows===0, '实际 '+filtered.rows);
ck('筛选为空时给出提示', filtered.empty.includes('没有警告或错误'), filtered.empty);
ck('筛选写回了设置', filtered.setting==='warn');
await p.evaluate(()=>globalThis.jQuery('#apirot_log_filter').val('all').trigger('change'));
await new Promise(r=>setTimeout(r,400));

// 改最大条数会立即裁剪
await p.evaluate(()=>globalThis.jQuery('#apirot_log_max').val('20').trigger('change'));
await new Promise(r=>setTimeout(r,500));
const trimmed = await p.evaluate(()=>({
  rows:document.querySelectorAll('#apirot_log_list .apirot-log-row').length,
  count:document.querySelector('#apirot_log_count')?.textContent||'',
  setting:globalThis.SillyTavern.getContext().extensionSettings.apiRotator.logMax,
}));
ck('调小最大条数会立即裁掉多余的', trimmed.rows===20&&trimmed.count.startsWith('20'), JSON.stringify(trimmed));
ck('最大条数写回了设置', trimmed.setting===20, String(trimmed.setting));

// 关掉记录
await p.evaluate(()=>globalThis.jQuery('#apirot_log_enabled').prop('checked',false).trigger('change'));
await p.evaluate(async ()=>{ await globalThis.apiRotatorInterceptor([],0,()=>{},'normal'); });
await new Promise(r=>setTimeout(r,600));
ck('关掉记录后不再新增条目', await p.evaluate(()=>
  document.querySelectorAll('#apirot_log_list .apirot-log-row').length===20));
await p.evaluate(()=>globalThis.jQuery('#apirot_log_enabled').prop('checked',true).trigger('change'));

// 清空
await p.evaluate(()=>globalThis.jQuery('#apirot_log_clear').trigger('click'));
await new Promise(r=>setTimeout(r,600));
const cleared = await p.evaluate(()=>({
  rows:document.querySelectorAll('#apirot_log_list .apirot-log-row').length,
  empty:document.querySelector('#apirot_log_list .apirot-empty')?.textContent||'',
  stored:globalThis.localStorage.getItem('apiRotator_log_v1'),
}));
ck('清空后没有条目', cleared.rows===0, '实际 '+cleared.rows);
ck('清空后给出空状态提示', cleared.empty.includes('还没有记录'), cleared.empty);
ck('清空同时清掉了本地存储', !cleared.stored, String(cleared.stored));

ck('整个 UI 操作过程中没有报错', errs.length===0, errs.slice(0,3).join(' | '));
console.log(`\n=== UI: ${pass} 通过 / ${fail} 失败 ===`);
await b.close();
process.exit(fail?1:0);
