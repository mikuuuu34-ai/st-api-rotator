#!/usr/bin/env node
/**
 * 后端集成测试：验证本插件赖以工作的核心机制在真实 SillyTavern 上成立。
 *
 * 直接向 ST 的 /api/backends/chat-completions/generate 发请求，
 * 请求体里带 reverse_proxy + proxy_password + model，
 * 然后检查假 API 服务实际收到的 URL / key / model 是否与我们指定的一致。
 *
 * 这验证的是架构假设本身（chat-completions.js:214/442/1745），
 * 与插件的 UI 无关 —— 如果这里挂了，整个方案就不成立。
 *
 * 用法：node test/backend-test.js
 * 前置：ST 跑在 127.0.0.1:8000，fake-api 跑在 127.0.0.1:8317
 */

const ST = process.env.ST_URL || 'http://127.0.0.1:8000';
const FAKE = process.env.FAKE_URL || 'http://127.0.0.1:8317';

let cookie = '';
let csrf = '';

async function bootstrap() {
    const res = await fetch(`${ST}/csrf-token`);
    const setCookie = res.headers.getSetCookie?.() || [];
    cookie = setCookie.map(c => c.split(';')[0]).join('; ');
    csrf = (await res.json()).token;
}

async function generate(body) {
    return fetch(`${ST}/api/backends/chat-completions/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Cookie': cookie,
        },
        body: JSON.stringify(body),
    });
}

const fakeLog = async () => (await fetch(`${FAKE}/__log`)).json();
const fakeReset = () => fetch(`${FAKE}/__reset`, { method: 'POST' });
const fakeFail = (keys, status = 429) =>
    fetch(`${FAKE}/__fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys, status }),
    });

const baseBody = {
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16,
    temperature: 1,
    stream: false,
};

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function testVendor(label, source, model, key) {
    await fakeReset();
    const res = await generate({
        ...baseBody,
        chat_completion_source: source,
        model,
        reverse_proxy: `${FAKE}/v1`,
        proxy_password: key,
        use_sysprompt: true,
    });
    const log = await fakeLog();
    const hit = log[0];

    console.log(`\n[${label}] source=${source} HTTP ${res.status}`);
    check(`${label}: 假服务收到了请求`, !!hit, `实际收到 ${log.length} 条`);
    if (!hit) { console.log('    ST 响应:', (await res.text()).slice(0, 300)); return; }

    check(`${label}: key 与指定一致`, hit.key === key, `期望 ${key}，实际 ${hit.key}`);
    check(`${label}: model 与指定一致`, String(hit.model).includes(model), `期望 ${model}，实际 ${hit.model}`);
    console.log(`    → path=${hit.path} vendor=${hit.vendor} key=${hit.key} model=${hit.model}`);
}

async function testFailover() {
    console.log('\n[失败形态] 摸清酒馆把上游错误包装成什么样 —— 插件的失败检测依赖于此');
    const shapes = [];
    for (const [label, source, model, stream] of [
        ['openai 非流式', 'openai', 'gpt-4o', false],
        ['openai 流式', 'openai', 'gpt-4o', true],
        ['claude 非流式', 'claude', 'claude-opus-4-5-20251101', false],
        ['gemini 非流式', 'makersuite', 'gemini-2.5-pro', false],
    ]) {
        await fakeReset();
        await fakeFail(['sk-bad'], 429);
        const res = await generate({
            ...baseBody, stream,
            chat_completion_source: source,
            model,
            reverse_proxy: `${FAKE}/v1`,
            proxy_password: 'sk-bad',
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 流式可能不是纯 JSON */ }
        const detected = !res.ok || !!json?.error;
        shapes.push({ label, status: res.status, hasErrorField: !!json?.error, detected });
        check(`${label}：插件能识别为失败`, detected,
            `HTTP ${res.status}, body=${text.slice(0, 90)}`);
    }

    console.log('\n    实测到的失败形态（engine.js detectFailure 就是按这张表写的）：');
    for (const s of shapes) {
        console.log(`      ${s.label.padEnd(16)} HTTP ${String(s.status).padEnd(4)} error字段=${s.hasErrorField}`);
    }
    check('存在 HTTP 200 但 body 带 error 的情况（证明不能只看 response.ok）',
        shapes.some(s => s.status === 200 && s.hasErrorField));

    await fakeReset();
}

async function testStreaming() {
    console.log('\n[流式] 确认 stream=true 时 key 注入同样生效');
    await fakeReset();
    const res = await generate({
        ...baseBody,
        stream: true,
        chat_completion_source: 'openai',
        model: 'gpt-4o',
        reverse_proxy: `${FAKE}/v1`,
        proxy_password: 'sk-stream',
    });
    await res.text();
    const log = await fakeLog();
    check('流式请求携带了正确的 key', log[0]?.key === 'sk-stream', `实际 ${log[0]?.key}`);
    check('假服务确认这是流式请求', log[0]?.stream === true);
}

(async () => {
    console.log('=== 后端集成测试：验证 reverse_proxy + proxy_password 机制 ===');
    await bootstrap();
    console.log(`ST=${ST}  FAKE=${FAKE}  csrf=${csrf.slice(0, 12)}…`);

    await testVendor('OpenAI', 'openai', 'gpt-4o', 'sk-openai-111');
    await testVendor('Claude', 'claude', 'claude-opus-4-5-20251101', 'sk-claude-222');
    await testVendor('Gemini', 'makersuite', 'gemini-2.5-pro', 'sk-gemini-333');
    await testFailover();
    await testStreaming();

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    process.exit(fail ? 1 : 0);
})();
