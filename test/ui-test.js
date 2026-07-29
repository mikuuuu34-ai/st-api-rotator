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

ck('整个 UI 操作过程中没有报错', errs.length===0, errs.slice(0,3).join(' | '));
console.log(`\n=== UI: ${pass} 通过 / ${fail} 失败 ===`);
await b.close();
process.exit(fail?1:0);
