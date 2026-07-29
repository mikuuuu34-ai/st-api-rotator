#!/usr/bin/env node
/**
 * 轮询顺序单元测试。
 *
 * 这里验证的是用户最核心的诉求：
 *   「一条信息对应一个处理」—— 连续 N 条消息必须依次用不同的 key，
 *   而不是全部挤在同一个 key 上。
 *
 * selector.js 不依赖 SillyTavern，所以这些断言可以直接在 Node 里跑。
 * 用法：node test/selector-test.js
 */

import {
    normalizeSettings, pickNextFrom, pairId, defaultSettings, endpointIssues,
} from '../selector.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    check(name, a === e, `期望 ${e}\n       实际 ${a}`);
}

/** 构造设置：endpoints 形如 [{name, keys:['k1','k2'], type, model}] */
function makeSettings(endpoints, overrides = {}) {
    const s = normalizeSettings({
        ...structuredClone(defaultSettings),
        enabled: true,
        ...overrides,
        endpoints: endpoints.map((e, i) => ({
            id: `e${i}`,
            name: e.name || `E${i}`,
            type: e.type || 'openai',
            url: e.url || `http://127.0.0.1:8317/v1`,
            model: e.model || `model-${i}`,
            enabled: e.enabled !== false,
            weight: e.weight || 1,
            keyStrategy: e.keyStrategy || 'round_robin',
            keys: e.keys.map((v, j) => ({ id: `e${i}k${j}`, value: v, enabled: true, ok: 0, fail: 0 })),
        })),
    });
    return s;
}

/** 连续取 n 次，返回 key 值序列 */
function sequence(s, n, now = Date.now()) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const p = pickNextFrom(s, new Set(), null, now);
        out.push(p ? p.key.value : null);
    }
    return out;
}

function sequenceLabelled(s, n, now = Date.now()) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const p = pickNextFrom(s, new Set(), null, now);
        out.push(p ? `${p.endpoint.name}:${p.key.value}` : null);
    }
    return out;
}

console.log('=== 轮询顺序单元测试 ===\n');

console.log('[1] 单端点多 key —— 一条消息一个 key（用户的核心要求）');
{
    const s = makeSettings([{ name: 'A', keys: ['k1', 'k2', 'k3'] }]);
    eq('6 条消息依次用 k1..k3 循环，不挤在一个 key 上',
        sequence(s, 6), ['k1', 'k2', 'k3', 'k1', 'k2', 'k3']);
}

console.log('\n[2] 多端点各一 key —— API 之间轮换');
{
    const s = makeSettings([
        { name: 'A', keys: ['a1'] },
        { name: 'B', keys: ['b1'] },
        { name: 'C', keys: ['c1'] },
    ]);
    eq('依次轮 A→B→C→A…', sequenceLabelled(s, 6),
        ['A:a1', 'B:b1', 'C:c1', 'A:a1', 'B:b1', 'C:c1']);
}

console.log('\n[3] 嵌套：多 API 轮询，其中某个 API 内部再轮 key');
{
    const s = makeSettings([
        { name: 'A', keys: ['a1', 'a2', 'a3'] },
        { name: 'B', keys: ['b1'] },
    ], { rotateMode: 'nested' });
    eq('端点交替，A 内部的 key 自己往前走',
        sequenceLabelled(s, 6),
        ['A:a1', 'B:b1', 'A:a2', 'B:b1', 'A:a3', 'B:b1']);
}

console.log('\n[4] 展平模式：所有 (API,key) 组合平铺');
{
    const s = makeSettings([
        { name: 'A', keys: ['a1', 'a2', 'a3'] },
        { name: 'B', keys: ['b1'] },
    ], { rotateMode: 'flat' });
    eq('4 个组合依次轮完再回头',
        sequenceLabelled(s, 8),
        ['A:a1', 'A:a2', 'A:a3', 'B:b1', 'A:a1', 'A:a2', 'A:a3', 'B:b1']);
}

console.log('\n[5] 不同端点用不同模型');
{
    const s = makeSettings([
        { name: 'A', keys: ['a1'], model: 'gpt-4o' },
        { name: 'B', keys: ['b1'], model: 'claude-opus-4-5-20251101', type: 'claude' },
        { name: 'C', keys: ['c1'], model: 'gemini-2.5-pro', type: 'gemini' },
    ]);
    const models = [];
    for (let i = 0; i < 3; i++) models.push(pickNextFrom(s, new Set()).endpoint.model);
    eq('每个端点带出自己的模型', models,
        ['gpt-4o', 'claude-opus-4-5-20251101', 'gemini-2.5-pro']);
}

console.log('\n[6] 冷却中的 key 会被跳过，到期后自动回归');
{
    const now = 1_000_000;
    const s = makeSettings([{ name: 'A', keys: ['k1', 'k2', 'k3'] }]);
    s.endpoints[0].keys[1].cooldownUntil = now + 60_000;   // k2 冷却中
    eq('冷却期内只在 k1/k3 之间轮', sequence(s, 4, now), ['k1', 'k3', 'k1', 'k3']);

    s.cursor = 0; s.endpoints[0].cursor = 0;
    eq('冷却到期后 k2 回归', sequence(s, 3, now + 61_000), ['k1', 'k2', 'k3']);
}

console.log('\n[7] 停用/黑名单的 key 与端点被排除');
{
    const s = makeSettings([
        { name: 'A', keys: ['a1', 'a2'] },
        { name: 'B', keys: ['b1'] },
    ]);
    s.endpoints[0].keys[0].enabled = false;   // a1 关闭
    s.endpoints[1].enabled = false;           // 端点 B 整个关闭
    eq('只剩 a2 可用', sequence(s, 3), ['a2', 'a2', 'a2']);

    s.endpoints[0].keys[1].blacklisted = true;
    check('全部不可用时返回 null', pickNextFrom(s, new Set()) === null);
}

console.log('\n[8] 重试排除：已试过的 pair 不会被重复选中');
{
    const s = makeSettings([{ name: 'A', keys: ['k1', 'k2', 'k3'] }]);
    const tried = new Set();
    const picked = [];
    for (let i = 0; i < 3; i++) {
        const p = pickNextFrom(s, tried);
        if (!p) break;
        picked.push(p.key.value);
        tried.add(pairId(p.endpoint, p.key));
    }
    check('三次重试拿到三个互不相同的 key',
        new Set(picked).size === 3, `实际 ${JSON.stringify(picked)}`);
    check('全部试过后返回 null（不会无限重试）',
        pickNextFrom(s, tried) === null);
}

console.log('\n[9] 重试优先同类型端点（避免厂商专有参数错位）');
{
    const s = makeSettings([
        { name: 'A', keys: ['a1', 'a2'], type: 'openai' },
        { name: 'B', keys: ['b1'], type: 'claude' },
    ]);
    const tried = new Set([pairId(s.endpoints[0], s.endpoints[0].keys[0])]);
    const p = pickNextFrom(s, tried, 'openai');
    check('优先选到同为 openai 的 a2', p?.key.value === 'a2', `实际 ${p?.key.value}`);

    const tried2 = new Set([
        pairId(s.endpoints[0], s.endpoints[0].keys[0]),
        pairId(s.endpoints[0], s.endpoints[0].keys[1]),
    ]);
    const p2 = pickNextFrom(s, tried2, 'openai');
    check('同类型用尽后回退到其他类型', p2?.key.value === 'b1', `实际 ${p2?.key.value}`);
}

console.log('\n[10] 边界：空配置 / 无 key / 无 URL');
{
    check('没有端点 → null', pickNextFrom(makeSettings([]), new Set()) === null);
    check('端点没有 key → null', pickNextFrom(makeSettings([{ name: 'A', keys: [] }]), new Set()) === null);
    const noUrl = makeSettings([{ name: 'A', keys: ['k1'] }]);
    noUrl.endpoints[0].url = '';
    check('端点没有 URL → null', pickNextFrom(noUrl, new Set()) === null);
}

console.log('\n[11] 模型是必填项（旧版「留空跟随酒馆」的回退已移除）');
{
    const s = makeSettings([{ name: 'A', keys: ['k1'] }]);
    check('填了模型时可用', pickNextFrom(s, new Set()) !== null);

    s.endpoints[0].model = '';
    check('模型留空 → 该端点不可用', pickNextFrom(s, new Set()) === null);

    const s2 = makeSettings([
        { name: 'A', keys: ['a1'] },
        { name: 'B', keys: ['b1'] },
    ]);
    s2.endpoints[0].model = '';
    eq('只轮到配了模型的那个端点', sequence(s2, 3), ['b1', 'b1', 'b1']);

    const issues = endpointIssues({ url: '', model: '', keys: [] });
    check('endpointIssues 能列出缺失项', issues.length === 3, JSON.stringify(issues));
    eq('缺失项文案', endpointIssues({ url: 'x', model: '', keys: [{ value: 'k', enabled: true }] }), ['缺模型']);
}

console.log('\n[12] 权重分配大致符合预期');
{
    const s = makeSettings([
        { name: 'A', keys: ['a1'], weight: 9 },
        { name: 'B', keys: ['b1'], weight: 1 },
    ], { strategy: 'weighted' });
    let a = 0;
    for (let i = 0; i < 4000; i++) {
        if (pickNextFrom(s, new Set()).endpoint.name === 'A') a++;
    }
    const ratio = a / 4000;
    check(`权重 9:1 时 A 约占 90%（实测 ${(ratio * 100).toFixed(1)}%）`,
        ratio > 0.85 && ratio < 0.95);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
