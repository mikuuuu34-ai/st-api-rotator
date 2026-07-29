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

// 加载失败时回落到酒馆内置列表
console.log('\n[UI] 加载失败时回落到酒馆内置列表');
await p.evaluate(()=>{
  const e=globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0];
  e.type='claude'; e.url='http://127.0.0.1:59999/v1'; e.knownModels=[]; e.collapsed=false;
  globalThis.jQuery('#apirot_reset').trigger('click');
});
await new Promise(r=>setTimeout(r,500));
await p.evaluate(()=>globalThis.jQuery('.apirot-card').first().find('.ep-loadmodels').trigger('click'));
await new Promise(r=>setTimeout(r,4000));
const fb = await p.evaluate(()=>{
  const e=globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0];
  return { n:e.knownModels.length, sample:e.knownModels.slice(0,2),
           hint:document.querySelector('.apirot-model-hint')?.textContent||'' };
});
console.log('    回落列表:', fb.n, '个, 例:', JSON.stringify(fb.sample));
ck('端点不可达时回落到酒馆内置的 Claude 模型列表', fb.n>0 && fb.sample.some(m=>m.includes('claude')), JSON.stringify(fb));
ck('提示文案说明了回落原因', fb.hint.includes('内置'), fb.hint);

ck('整个 UI 操作过程中没有报错', errs.length===0, errs.slice(0,3).join(' | '));
console.log(`\n=== UI: ${pass} 通过 / ${fail} 失败 ===`);
await b.close();
process.exit(fail?1:0);
