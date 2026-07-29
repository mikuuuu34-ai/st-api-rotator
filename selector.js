/**
 * st-api-rotator — 纯选择逻辑
 *
 * 这个文件刻意不 import 任何 SillyTavern 模块，所有函数都只依赖传入的
 * settings 对象。这样轮询顺序（尤其是「一条消息 = 一个 key」这条核心保证）
 * 可以在 Node 里被直接单元测试，不需要跑浏览器。
 */

/**
 * 端点类型 → 酒馆内部字段映射。
 * source 必须落在 openai.js 的 proxySupportedSources 内（CLAUDE / OPENAI / MAKERSUITE 均在）。
 */
export const ENDPOINT_TYPES = {
    openai: {
        source: 'openai',
        modelField: 'openai_model',
        label: 'OpenAI 兼容',
        urlHint: 'https://api.openai.com/v1',
    },
    claude: {
        source: 'claude',
        modelField: 'claude_model',
        label: 'Claude',
        urlHint: 'https://api.anthropic.com/v1',
    },
    gemini: {
        source: 'makersuite',
        modelField: 'google_model',
        label: 'Gemini',
        urlHint: 'https://generativelanguage.googleapis.com',
    },
};

export const defaultSettings = {
    enabled: false,
    rotateMode: 'nested',      // nested | flat
    strategy: 'round_robin',   // round_robin | random | weighted
    includeQuiet: false,       // 是否接管 quiet 类型（总结等后台请求）
    onFailure: 'next',         // next | error
    maxRetries: 3,
    cooldownSeconds: 300,
    blacklistOnFail: false,
    preferSameTypeOnRetry: true,
    logRequests: true,
    endpoints: [],
    cursor: 0,
    flatCursor: 0,
};

export function uid() {
    return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function normalizeEndpoint(e) {
    if (!e.id) e.id = uid();
    if (!ENDPOINT_TYPES[e.type]) e.type = 'openai';
    if (e.enabled === undefined) e.enabled = true;
    if (!Array.isArray(e.keys)) e.keys = [];
    if (typeof e.cursor !== 'number') e.cursor = 0;
    if (!e.keyStrategy) e.keyStrategy = 'round_robin';
    if (!(Number(e.weight) > 0)) e.weight = 1;
    for (const k of e.keys) {
        if (!k.id) k.id = uid();
        if (k.enabled === undefined) k.enabled = true;
        if (typeof k.ok !== 'number') k.ok = 0;
        if (typeof k.fail !== 'number') k.fail = 0;
    }
    return e;
}

export function normalizeSettings(s) {
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    if (!Array.isArray(s.endpoints)) s.endpoints = [];
    for (const e of s.endpoints) normalizeEndpoint(e);
    return s;
}

/* -------------------------------------------------------------- 可用性 */

export function isKeyAvailable(k, now = Date.now()) {
    if (!k || k.enabled === false || !k.value) return false;
    if (k.blacklisted) return false;
    if (k.cooldownUntil && k.cooldownUntil > now) return false;
    return true;
}

export function availableKeys(e, now = Date.now()) {
    return (e.keys || []).filter(k => isKeyAvailable(k, now));
}

export function isEndpointAvailable(e, now = Date.now()) {
    return !!e && e.enabled !== false && !!e.url && availableKeys(e, now).length > 0;
}

export const pairId = (e, k) => `${e.id}:${k.id}`;

/* ---------------------------------------------------------------- 选择 */

/**
 * 推进游标并返回索引。
 * round_robin 用单调递增计数器对当前长度取模 —— 候选集变动时也不会卡死在同一项。
 */
export function advance(holder, field, len, strategy, weights, rng = Math.random) {
    if (len <= 0) return -1;
    if (strategy === 'random') return Math.floor(rng() * len);
    if (strategy === 'weighted' && Array.isArray(weights)) {
        const w = weights.map(x => (Number(x) > 0 ? Number(x) : 1));
        const total = w.reduce((a, b) => a + b, 0);
        let r = rng() * total;
        for (let i = 0; i < len; i++) {
            r -= w[i];
            if (r <= 0) return i;
        }
        return len - 1;
    }
    const counter = Number(holder[field]) || 0;
    holder[field] = (counter + 1) % 1e9;
    return counter % len;
}

/**
 * 选出下一个 (endpoint, key)。会就地推进 settings / endpoint 上的游标。
 *
 * @param {object} s 设置对象
 * @param {Set<string>} tried 本次消息已试过的 pair，用于失败重试时排除
 * @param {string|null} preferType 优先同类型（重试时保持请求体形状有效）
 * @param {number} now 当前时间戳（测试可注入）
 * @param {() => number} rng 随机源（测试可注入）
 * @returns {{endpoint: object, key: object}|null}
 */
export function pickNextFrom(s, tried = new Set(), preferType = null, now = Date.now(), rng = Math.random) {
    let endpoints = (s.endpoints || []).filter(e => isEndpointAvailable(e, now));
    if (!endpoints.length) return null;

    const hasUntried = (e) => availableKeys(e, now).some(k => !tried.has(pairId(e, k)));

    if (preferType) {
        const sameType = endpoints.filter(e => e.type === preferType && hasUntried(e));
        if (sameType.length) endpoints = sameType;
    }

    if (s.rotateMode === 'flat') {
        const pairs = [];
        for (const e of endpoints) {
            for (const k of availableKeys(e, now)) {
                if (!tried.has(pairId(e, k))) pairs.push({ endpoint: e, key: k });
            }
        }
        if (!pairs.length) return null;
        const idx = advance(s, 'flatCursor', pairs.length, s.strategy, pairs.map(p => p.endpoint.weight), rng);
        return pairs[idx];
    }

    // nested：先在端点间轮，再在该端点内部轮 key
    const candidates = endpoints.filter(hasUntried);
    if (!candidates.length) return null;
    const eIdx = advance(s, 'cursor', candidates.length, s.strategy, candidates.map(e => e.weight), rng);
    const endpoint = candidates[eIdx];
    const keys = availableKeys(endpoint, now).filter(k => !tried.has(pairId(endpoint, k)));
    if (!keys.length) return null;
    const kIdx = advance(endpoint, 'cursor', keys.length, endpoint.keyStrategy, null, rng);
    return { endpoint, key: keys[kIdx] };
}

/* ---------------------------------------------------------------- 工具 */

export function maskKey(v) {
    const s = String(v || '');
    if (s.length <= 8) return '***';
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function trimUrl(u) {
    return String(u || '').trim().replace(/\/+$/, '');
}

export function reviveKey(k) {
    delete k.cooldownUntil;
    delete k.blacklisted;
    k.failCount = 0;
    k.lastError = '';
}

export function resetAllStats(s) {
    for (const e of s.endpoints || []) {
        e.cursor = 0;
        for (const k of e.keys) {
            k.ok = 0; k.fail = 0;
            reviveKey(k);
        }
    }
    s.cursor = 0;
    s.flatCursor = 0;
}
