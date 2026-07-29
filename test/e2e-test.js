#!/usr/bin/env node
/**
 * 浏览器端到端测试。
 *
 * 覆盖范围说明（重要，别高估它）：
 *   ✅ 真实浏览器里加载真实 SillyTavern 与本插件
 *   ✅ 调用酒馆自己的 runGenerationInterceptors() —— 验证 manifest 的
 *      generate_interceptor 接线确实生效（不是我自己直接调函数）
 *   ✅ 用酒馆真实的 eventSource 触发 CHAT_COMPLETION_SETTINGS_READY
 *   ✅ 请求真的经过本插件的 fetch 包装器，打到真实的酒馆后端，再到假 API 服务
 *   ✅ 断言 key 序列、model 覆盖、设置还原、失败重试
 *
 *   ❌ 不覆盖酒馆的提示词组装流程（Generate() 内部）。无头环境下酒馆的
 *      settingsReady 不置位导致 Generate() 会卡住 —— 该现象在**卸载本插件后
 *      依然复现**，属于测试环境问题，与插件无关。Generate() 会调用上述两个
 *      钩子这一点，已通过读源码确认：
 *        public/script.js:4505        → runGenerationInterceptors(...)
 *        public/scripts/openai.js:3052 → emit(CHAT_COMPLETION_SETTINGS_READY, generate_data)
 *
 * 前置：ST 在 127.0.0.1:8000（settings.json 已设 main_api=openai），
 *       fake-api 在 127.0.0.1:8317，插件已装好。
 * 用法：node test/e2e-test.js
 */

// puppeteer-core 不是本插件的依赖。默认从常规解析路径找，
// 找不到时用 PUPPETEER_PATH 环境变量指定绝对路径。
const puppeteer = (await import(process.env.PUPPETEER_PATH || 'puppeteer-core')).default;

const ST = process.env.ST_URL || 'http://127.0.0.1:8000';
const FAKE = process.env.FAKE_URL || 'http://127.0.0.1:8317';
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}

const fakeLog = async () => (await fetch(`${FAKE}/__log`)).json();
const fakeReset = () => fetch(`${FAKE}/__reset`, { method: 'POST' });
const fakeFail = (keys, status = 429) => fetch(`${FAKE}/__fail`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys, status }),
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 在页面里注入一个「模拟一次生成」的辅助函数 */
const DRIVER = `
globalThis.__rotTest = async function (type = 'normal') {
    const ext = await import('/scripts/extensions.js');
    const script = await import('/script.js');
    const ctx = globalThis.SillyTavern.getContext();
    const oai = ctx.chatCompletionSettings;

    // 阶段 1：走酒馆自己的拦截器派发（验证 manifest 接线）
    await ext.runGenerationInterceptors([], 4096, type);
    const afterInterceptor = {
        source: oai.chat_completion_source,
        openai_model: oai.openai_model,
        claude_model: oai.claude_model,
        google_model: oai.google_model,
    };

    // 阶段 2：构造与 openai.js createGenerationParameters 同形的请求体，
    //         用真实 eventSource 触发事件，让插件改写它
    const generate_data = {
        messages: [{ role: 'user', content: 'ping' }],
        model: ctx.getChatCompletionModel(),
        temperature: 1,
        max_tokens: 16,
        stream: false,
        chat_completion_source: oai.chat_completion_source,
        reverse_proxy: oai.reverse_proxy,
        proxy_password: oai.proxy_password,
    };
    await script.eventSource.emit(script.event_types.CHAT_COMPLETION_SETTINGS_READY, generate_data);
    const afterEvent = JSON.parse(JSON.stringify(generate_data));

    // 阶段 3：真的发出去 —— 经过插件的 fetch 包装器 → 酒馆后端 → 假 API
    let httpStatus = 0, replyText = '';
    try {
        const res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: script.getRequestHeaders(),
            body: JSON.stringify(generate_data),
        });
        httpStatus = res.status;
        replyText = (await res.text()).slice(0, 120);
    } catch (e) {
        replyText = 'FETCH ERR: ' + e.message;
    }

    // 收尾：触发酒馆生成结束事件，插件应还原全局设置
    await script.eventSource.emit(script.event_types.GENERATION_ENDED, 0);

    return {
        afterInterceptor, afterEvent, httpStatus, replyText,
        afterRestore: {
            source: oai.chat_completion_source,
            openai_model: oai.openai_model,
        },
    };
};
`;

(async () => {
    console.log('=== 浏览器端到端测试 ===\n');
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => consoleLines.push(`[PAGEERROR] ${e.message}`));

    try {
        await page.goto(ST, { waitUntil: 'networkidle2', timeout: 90_000 });
        await page.waitForFunction('!!globalThis.SillyTavern?.getContext', { timeout: 90_000 });
        await page.waitForFunction('typeof globalThis.apiRotatorInterceptor === "function"', { timeout: 60_000 })
            .catch(() => { });
        await sleep(2500);

        /* ---------------------------------------------------- 1. 插件加载 */
        console.log('[1] 插件加载与 UI 注入');
        const loaded = await page.evaluate(() => ({
            interceptor: typeof globalThis.apiRotatorInterceptor,
            panel: !!document.querySelector('.api-rotator-settings'),
            enableBox: !!document.querySelector('#apirot_enabled'),
            addBtn: !!document.querySelector('#apirot_add'),
            statusBox: !!document.querySelector('#apirot_status'),
            fetchPatched: globalThis.fetch.toString().includes('__apiRotatorTag')
                || globalThis.fetch.name !== 'fetch',
        }));
        check('generate_interceptor 已挂到 globalThis', loaded.interceptor === 'function', `实际 ${loaded.interceptor}`);
        check('设置面板已注入 DOM', loaded.panel);
        check('启用开关 / 新增按钮 / 状态面板都在', loaded.enableBox && loaded.addBtn && loaded.statusBox);
        check('fetch 已被包装', loaded.fetchPatched);

        const errs = consoleLines.filter(l => l.includes('PAGEERROR'));
        check('加载期间没有页面级报错', errs.length === 0, errs.slice(0, 3).join('\n       '));

        await page.evaluate(DRIVER);

        /* ------------------------------------------------ 2. 配置轮询池 */
        console.log('\n[2] 写入轮询配置（1 端点 × 3 key）');
        await page.evaluate((fakeUrl) => {
            const ctx = globalThis.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            oai.chat_completion_source = 'openai';
            oai.reverse_proxy = `${fakeUrl}/v1`;
            oai.proxy_password = 'sk-tavern-own';
            oai.openai_model = 'gpt-4o-tavern';
            oai.stream_openai = false;

            ctx.extensionSettings.apiRotator = {
                enabled: true, rotateMode: 'nested', strategy: 'round_robin',
                includeQuiet: false, onFailure: 'error', maxRetries: 3,
                cooldownSeconds: 0, blacklistOnFail: false,
                preferSameTypeOnRetry: true, logRequests: true,
                cursor: 0, flatCursor: 0,
                endpoints: [{
                    id: 'ep1', name: 'A', type: 'openai',
                    url: `${fakeUrl}/v1`, model: 'gpt-4o-rotated',
                    enabled: true, weight: 1, keyStrategy: 'round_robin', cursor: 0,
                    keys: [
                        { id: 'k1', value: 'sk-key-1', enabled: true, ok: 0, fail: 0 },
                        { id: 'k2', value: 'sk-key-2', enabled: true, ok: 0, fail: 0 },
                        { id: 'k3', value: 'sk-key-3', enabled: true, ok: 0, fail: 0 },
                    ],
                }],
            };
        }, FAKE);
        check('配置已写入', await page.evaluate(() =>
            globalThis.SillyTavern.getContext().extensionSettings.apiRotator.endpoints[0].keys.length === 3));

        /* -------------------------------- 3. 单次生成：三个阶段都正确 */
        console.log('\n[3] 单次生成：拦截器 → 事件改写 → 真实请求');
        await fakeReset();
        const one = await page.evaluate(() => globalThis.__rotTest('normal'));
        const log1 = await fakeLog();

        check('酒馆的 runGenerationInterceptors 确实调到了本插件（model 被换成端点配置）',
            one.afterInterceptor.openai_model === 'gpt-4o-rotated',
            `实际 ${JSON.stringify(one.afterInterceptor)}`);
        check('事件监听器把 reverse_proxy 改写为端点 URL',
            one.afterEvent.reverse_proxy === `${FAKE}/v1`, `实际 ${one.afterEvent.reverse_proxy}`);
        check('事件监听器把 proxy_password 改写为轮询池的 key',
            one.afterEvent.proxy_password === 'sk-key-1', `实际 ${one.afterEvent.proxy_password}`);
        check('请求成功抵达假 API', log1.length === 1, `实际 ${log1.length} 条, HTTP ${one.httpStatus}, ${one.replyText}`);
        check('假 API 收到的是轮询池的 key 与 model',
            log1[0]?.key === 'sk-key-1' && log1[0]?.model === 'gpt-4o-rotated',
            `实际 key=${log1[0]?.key} model=${log1[0]?.model}`);
        check('生成结束后全局设置已还原',
            one.afterRestore.source === 'openai' && one.afterRestore.openai_model === 'gpt-4o-tavern',
            `实际 ${JSON.stringify(one.afterRestore)}`);

        /* --------------------------- 4. 核心断言：一条消息一个 key */
        console.log('\n[4] 连续 6 次生成 —— 一条消息一个 key（核心断言）');
        await fakeReset();
        await page.evaluate(async () => {
            const s = globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
            s.cursor = 0; s.endpoints[0].cursor = 0;
            for (let i = 0; i < 6; i++) await globalThis.__rotTest('normal');
        });
        const log4 = await fakeLog();
        const seq = log4.map(e => e.key);
        console.log(`    key 序列: ${JSON.stringify(seq)}`);
        check('收到 6 条请求', log4.length === 6, `实际 ${log4.length}`);
        check('key 序列为 1,2,3,1,2,3（不是全挤在一个 key 上）',
            JSON.stringify(seq) === JSON.stringify(['sk-key-1', 'sk-key-2', 'sk-key-3', 'sk-key-1', 'sk-key-2', 'sk-key-3']),
            `实际 ${JSON.stringify(seq)}`);
        check('每条请求的 model 都是端点配置的值',
            log4.length > 0 && log4.every(e => e.model === 'gpt-4o-rotated'));

        /* --------------------------------- 5. quiet 默认不被接管 */
        console.log('\n[5] quiet 类型默认不接管（其他插件的后台请求不消耗轮询池）');
        await fakeReset();
        await page.evaluate(async () => {
            const s = globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
            s.includeQuiet = false; s.cursor = 0; s.endpoints[0].cursor = 0;
            await globalThis.__rotTest('quiet');
        });
        const log5 = await fakeLog();
        check('quiet 请求走酒馆自身的 key，不动轮询池',
            log5.length === 1 && log5[0].key === 'sk-tavern-own',
            `实际 ${JSON.stringify(log5.map(e => e.key))}`);

        console.log('\n[6] 打开 includeQuiet 后 quiet 也接管');
        await fakeReset();
        await page.evaluate(async () => {
            const s = globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
            s.includeQuiet = true; s.cursor = 0; s.endpoints[0].cursor = 0;
            await globalThis.__rotTest('quiet');
        });
        const log6 = await fakeLog();
        check('quiet 请求改用轮询池的 key',
            log6.length === 1 && log6[0].key === 'sk-key-1',
            `实际 ${JSON.stringify(log6.map(e => e.key))}`);

        /* --------------------------------------- 7. 失败自动切换 */
        console.log('\n[7] onFailure=next：坏 key 自动切下一个');
        await fakeReset();
        await fakeFail(['sk-key-1'], 429);
        const r7 = await page.evaluate(async () => {
            const s = globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
            s.onFailure = 'next'; s.includeQuiet = false;
            s.cursor = 0; s.endpoints[0].cursor = 0;
            for (const k of s.endpoints[0].keys) { delete k.cooldownUntil; delete k.blacklisted; }
            return globalThis.__rotTest('normal');
        });
        const log7 = await fakeLog();
        console.log(`    请求序列: ${JSON.stringify(log7.map(e => `${e.key}${e.failed ? '✗' : '✓'}`))}`);
        // 注意：重试选中的不一定是「下一个」key。轮询游标是单调递增的，
        // 首次选择时已推进过一次，所以重试可能跳到 k3。全局轮询仍然公平
        // （被跳过的 key 会在后续消息中被选到），契约是「换一个不同的可用 key」。
        check('先用坏 key 失败，再换一个不同的可用 key 并成功',
            log7.length === 2 && log7[0].key === 'sk-key-1' && log7[0].failed === true
            && log7[1].key !== 'sk-key-1' && !log7[1].failed,
            `实际 ${JSON.stringify(log7.map(e => ({ k: e.key, failed: !!e.failed })))}`);
        check('最终返回给酒馆的是成功响应（而非错误）',
            r7.httpStatus === 200 && r7.replyText.includes('chatcmpl-fake') && !r7.replyText.includes('rate_limit'),
            `HTTP ${r7.httpStatus} ${r7.replyText}`);

        /* --------------------------------------- 8. 失败直接报错 */
        console.log('\n[8] onFailure=error：坏 key 不重试');
        await fakeReset();
        await fakeFail(['sk-key-1'], 429);
        await page.evaluate(async () => {
            const s = globalThis.SillyTavern.getContext().extensionSettings.apiRotator;
            s.onFailure = 'error';
            s.cursor = 0; s.endpoints[0].cursor = 0;
            for (const k of s.endpoints[0].keys) { delete k.cooldownUntil; delete k.blacklisted; }
            return globalThis.__rotTest('normal');
        });
        const log8 = await fakeLog();
        check('只发一次请求，没有重试',
            log8.length === 1 && log8[0].failed === true,
            `实际 ${log8.length} 条: ${JSON.stringify(log8.map(e => e.key))}`);

        /* ------------------------------ 9. 多端点 + 跨厂商轮询 */
        console.log('\n[9] 多端点跨厂商轮询（openai / claude / gemini）');
        await fakeReset();
        const r9 = await page.evaluate(async (fakeUrl) => {
            const ctx = globalThis.SillyTavern.getContext();
            const s = ctx.extensionSettings.apiRotator;
            s.onFailure = 'error'; s.cursor = 0;
            s.endpoints = [
                { id: 'e1', name: 'O', type: 'openai', url: `${fakeUrl}/v1`, model: 'gpt-4o', enabled: true, weight: 1, keyStrategy: 'round_robin', cursor: 0, keys: [{ id: 'o1', value: 'sk-oai', enabled: true, ok: 0, fail: 0 }] },
                { id: 'e2', name: 'C', type: 'claude', url: `${fakeUrl}/v1`, model: 'claude-opus-4-5-20251101', enabled: true, weight: 1, keyStrategy: 'round_robin', cursor: 0, keys: [{ id: 'c1', value: 'sk-cla', enabled: true, ok: 0, fail: 0 }] },
                { id: 'e3', name: 'G', type: 'gemini', url: `${fakeUrl}/v1`, model: 'gemini-2.5-pro', enabled: true, weight: 1, keyStrategy: 'round_robin', cursor: 0, keys: [{ id: 'g1', value: 'sk-gem', enabled: true, ok: 0, fail: 0 }] },
            ];
            const sources = [];
            for (let i = 0; i < 3; i++) {
                const r = await globalThis.__rotTest('normal');
                sources.push(r.afterEvent.chat_completion_source);
            }
            return { sources, restored: ctx.chatCompletionSettings.chat_completion_source };
        }, FAKE);
        const log9 = await fakeLog();
        console.log(`    厂商序列: ${JSON.stringify(log9.map(e => e.vendor))}`);
        console.log(`    key 序列 : ${JSON.stringify(log9.map(e => e.key))}`);
        check('三次请求分别打到 openai / claude / gemini 三种厂商接口',
            JSON.stringify(log9.map(e => e.vendor)) === JSON.stringify(['openai', 'claude', 'gemini']),
            `实际 ${JSON.stringify(log9.map(e => e.vendor))}`);
        check('每家用各自的 key',
            JSON.stringify(log9.map(e => e.key)) === JSON.stringify(['sk-oai', 'sk-cla', 'sk-gem']),
            `实际 ${JSON.stringify(log9.map(e => e.key))}`);
        check('每家用各自的 model',
            log9[0]?.model === 'gpt-4o' && log9[1]?.model === 'claude-opus-4-5-20251101'
            && String(log9[2]?.model).includes('gemini-2.5-pro'),
            `实际 ${JSON.stringify(log9.map(e => e.model))}`);
        check('跨厂商轮询后全局 source 已还原为 openai',
            r9.restored === 'openai', `实际 ${r9.restored}`);

        /* ---------------------------------- 10. 关闭时完全不介入 */
        console.log('\n[10] 关闭轮询后完全不介入');
        await fakeReset();
        await page.evaluate(async () => {
            globalThis.SillyTavern.getContext().extensionSettings.apiRotator.enabled = false;
            await globalThis.__rotTest('normal');
        });
        const log10 = await fakeLog();
        check('关闭后走酒馆自身设置',
            log10.length === 1 && log10[0].key === 'sk-tavern-own' && log10[0].model === 'gpt-4o-tavern',
            `实际 key=${log10[0]?.key} model=${log10[0]?.model}`);

        await fakeReset();
    } catch (err) {
        fail++;
        console.error('\n❌ 测试异常：', err.message);
        console.log('\n控制台尾部：\n  ' + consoleLines.slice(-20).join('\n  '));
    } finally {
        await browser.close();
    }

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    process.exit(fail ? 1 : 0);
})();
