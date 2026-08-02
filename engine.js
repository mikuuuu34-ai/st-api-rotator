/**
 * st-api-rotator — 酒馆集成层
 *
 * 负责：两阶段注入、失败重试与冷却、全局设置的快照与还原。
 * 纯选择逻辑在 selector.js（不依赖酒馆，可单测）。
 *
 * 关键实现依据（SillyTavern 1.18.0，已核对源码并实测）：
 *  - public/scripts/extensions.js:2015  runGenerationInterceptors → globalThis[manifest.generate_interceptor]
 *  - public/scripts/openai.js:3052      await emit(CHAT_COMPLETION_SETTINGS_READY, generate_data) 后
 *                                        对同一对象 JSON.stringify 发出 → 监听器内改写生效
 *  - public/scripts/openai.js:3129      getStreamingReply 回落到全局 oai_settings.chat_completion_source
 *                                        → 跨厂商切换必须在生成开始前改全局设置
 *  - src/endpoints/backends/chat-completions.js:214/442/1745
 *                                        claude / makersuite / openai 三源统一：
 *                                        reverse_proxy 决定 URL，proxy_password 决定 key
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '../../../../script.js';

import {
    ENDPOINT_TYPES, defaultSettings,
    normalizeSettings, normalizeEndpoint, uid,
    isKeyAvailable, availableKeys, isEndpointAvailable, endpointIssues, pairId,
    pickNextFrom, maskKey, trimUrl, reviveKey, resetAllStats as resetStatsIn,
} from './selector.js';

import { createLogStore, STORAGE_KEY } from './log.js';

export {
    ENDPOINT_TYPES, defaultSettings, normalizeEndpoint, uid,
    isKeyAvailable, availableKeys, isEndpointAvailable, endpointIssues, maskKey, trimUrl, reviveKey,
};

export const MODULE_KEY = 'apiRotator';
export const EXTENSION_NAME = 'st-api-rotator';
export const EXTENSION_PATH = `third-party/${EXTENSION_NAME}`;

const GENERATE_URL = '/api/backends/chat-completions/generate';

/**
 * 阶段 2 打在请求体上的标记。
 * 值是**生成批次号**而不是布尔 —— 这样 fetch 发出请求时可以拿它和当时的
 * currentPick.gen 比对，两者不一致就说明两次生成串台了（并发场景）。
 * 批次号从 1 开始，truthiness 检查不受影响。
 */
const ROTATOR_TAG = '__apiRotatorTag';

/* ------------------------------------------------------------------ 日志 */

export const logStore = createLogStore();

/** localStorage 写失败（配额满 / 隐私模式）后不再重试，避免每条日志都抛一次 */
let persistBroken = false;
let saveTimer = null;

function schedulePersist() {
    if (persistBroken || !getSettings().logPersist) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushLog, 1000);
}

export function flushLog() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (persistBroken || !getSettings().logPersist) return;
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, logStore.serialize());
    } catch (err) {
        persistBroken = true;
        console.warn('[api-rotator] 日志写入 localStorage 失败，本次会话改为只保留在内存中', err);
    }
}

export function clearPersistedLog() {
    try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** 把设置里的日志开关同步到缓冲区。设置变更后 UI 会再调一次。 */
export function syncLogSettings() {
    const s = getSettings();
    logStore.setEnabled(s.logEnabled !== false);
    logStore.setVerbose(!!s.logVerbose);
    logStore.setMax(s.logMax);
}

/**
 * 恢复上次会话的日志。必须在酒馆把 settings.json 读回来之后调用
 * （否则 logPersist / logMax 还是默认值）。
 */
export function initLog() {
    syncLogSettings();
    if (getSettings().logPersist && logStore.size === 0) {
        try {
            logStore.hydrate(globalThis.localStorage?.getItem(STORAGE_KEY));
        } catch (err) {
            console.warn('[api-rotator] 读取历史日志失败，从空开始', err);
        }
    }
    logStore.onChange(schedulePersist);
}

/* ------------------------------------------------------------------ 设置 */

export function getSettings() {
    if (!extension_settings[MODULE_KEY]) {
        extension_settings[MODULE_KEY] = structuredClone(defaultSettings);
    }
    return normalizeSettings(extension_settings[MODULE_KEY]);
}

/** 只在设置已还原、非轮询窗口内调用，避免把轮询态写进 settings.json */
export function persist() {
    saveSettingsDebounced();
}

export function pickNext(tried = new Set(), preferType = null) {
    return pickNextFrom(getSettings(), tried, preferType);
}

export function resetAllStats() {
    resetStatsIn(getSettings());
}

/* ----------------------------------------------------------- 运行时状态 */

/** @type {{endpoint: object, key: object, tried: Set<string>, gen: number} | null} */
let currentPick = null;
/** 被改写前的 oai_settings 字段快照 */
let snapshot = null;
/** 本次生成的统计，用于在结束时判断「推进了游标却没发出请求」 */
let genStats = null;
/** 状态变更回调（UI 用） */
const listeners = new Set();

export function onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emitState() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }
export function getCurrentPick() { return currentPick; }

/** 当前可用的端点/密钥规模，记进日志便于判断「候选池是不是只剩一个」 */
function poolInfo(s) {
    const eps = (s.endpoints || []).filter(e => isEndpointAvailable(e));
    return {
        poolEndpoints: eps.length,
        poolKeys: eps.reduce((a, e) => a + availableKeys(e).length, 0),
    };
}

function oai() {
    // getContext().chatCompletionSettings 与 openai.js 的 oai_settings 是同一对象引用
    return getContext().chatCompletionSettings;
}

function snapField(o, field) {
    if (snapshot && !(field in snapshot)) snapshot[field] = o[field];
}

/**
 * 阶段 1：改写全局 oai_settings。
 * 必须在生成开始前完成，否则 getStreamingReply 会用错解析器（openai.js:3129）。
 * 只赋值，不触发 change 事件 → UI 不跳动、不写盘。
 */
function applyPick(pick) {
    const o = oai();
    if (!o) return;
    const t = ENDPOINT_TYPES[pick.endpoint.type];
    if (!snapshot) snapshot = {};
    snapField(o, 'chat_completion_source');
    snapField(o, t.modelField);
    o.chat_completion_source = t.source;
    o[t.modelField] = pick.endpoint.model;
    logStore.push('apply', pick.gen, `全局设置改为 ${t.source} / ${pick.endpoint.model}`,
        { source: t.source, modelField: t.modelField, model: pick.endpoint.model });
}

export function restoreSettings() {
    if (!snapshot) return;
    const o = oai();
    if (o) for (const [k, v] of Object.entries(snapshot)) o[k] = v;
    logStore.push('restore', currentPick?.gen || 0, '已还原被改写的全局设置',
        { fields: Object.keys(snapshot).join(',') });
    snapshot = null;
}

/** 阶段 2：改写出站请求体 */
function applyToRequest(data, pick) {
    const t = ENDPOINT_TYPES[pick.endpoint.type];
    data.chat_completion_source = t.source;
    data.reverse_proxy = trimUrl(pick.endpoint.url);
    data.proxy_password = pick.key.value;
    data.model = pick.endpoint.model;   // 必填项，isEndpointAvailable 已保证非空
    data[ROTATOR_TAG] = pick.gen;       // 批次号，供 fetch 层做串台检测
}

export function describe(pick) {
    return `${pick.endpoint.name || pick.endpoint.type} / ${pick.key.label || maskKey(pick.key.value)} / ${pick.endpoint.model}`;
}

/* ------------------------------------------------------------ 模型列表 */

/** 常见状态码的排查提示，附在错误信息后面 */
function statusHint(status) {
    if (status === 400) return '请求被拒绝；Claude 官方端点不支持这种探测方式，请手动输入模型名';
    if (status === 401 || status === 403) return '密钥无效或没有权限';
    if (status === 404) return '地址不对 —— 检查基址是不是漏了 /v1，或者多写了 /chat/completions';
    if (status === 429) return '被限流了，稍后再试';
    if (status >= 500) return '上游或酒馆后端报错';
    return '';
}

/**
 * 在线拉取某个端点真实可用的模型列表。
 *
 * 走酒馆的 /api/backends/chat-completions/status —— 它同样吃
 * reverse_proxy + proxy_password（见 chat-completions.js:1745），
 * 所以不需要把 key 存进酒馆、也不受浏览器 CORS 限制。
 *
 * 注意：该接口不支持 claude 源（会 400），因此 claude 类型退化成 openai
 * 形状去探测同一个基址 —— 多数 Claude 中转站同时提供 /v1/models；
 * 官方 api.anthropic.com 不认 Bearer，会失败。
 *
 * 失败时**如实抛出原因，不做任何猜测性回落**。早期版本会回落到酒馆内置的
 * 模型列表，结果是用户看到一堆能选的型号，误以为端点已经连通，实际上压根没通。
 *
 * @returns {Promise<string[]>}
 */
export async function fetchModels(endpoint) {
    const key = availableKeys(endpoint)[0] || (endpoint.keys || [])[0];
    if (!key?.value) throw new Error('该端点还没有 key，无法拉取模型列表');
    if (!endpoint.url) throw new Error('请先填写接口地址');

    const t = ENDPOINT_TYPES[endpoint.type];
    let res;
    try {
        res = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: t.statusSource,
                reverse_proxy: trimUrl(endpoint.url),
                proxy_password: key.value,
            }),
        });
    } catch (err) {
        // 这一跳是打到酒馆自己的后端，走不通说明酒馆那边有问题，不是目标 API 的锅
        throw new Error(`连不上酒馆后端：${err.message}`);
    }

    if (!res.ok) {
        let detail = '';
        try { detail = extractErrorMessage(await res.text()); } catch { /* 读不到就算了 */ }
        const hint = statusHint(res.status);
        const parts = [`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`];
        if (detail) parts.push(detail);
        if (hint) parts.push(`（${hint}）`);
        throw new Error(parts.join(' — '));
    }

    const json = await res.json().catch(() => null);
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const ids = list
        .map(m => (typeof m === 'string' ? m : m?.id || m?.name))
        .filter(Boolean)
        .map(String);

    if (!ids.length) throw new Error('接口通了，但没有返回任何模型（该端点可能不提供 /v1/models）');
    return [...new Set(ids)].sort();
}

/* --------------------------------------------------------- 成败与冷却 */

function recordSuccess(pick) {
    if (!pick) return;
    pick.key.ok = (pick.key.ok || 0) + 1;
    pick.key.failCount = 0;
    pick.key.lastError = '';
    emitState();
}

function recordFailure(pick, status, message) {
    if (!pick) return;
    const s = getSettings();
    pick.key.fail = (pick.key.fail || 0) + 1;
    pick.key.failCount = (pick.key.failCount || 0) + 1;
    pick.key.lastError = `${status}: ${String(message || '').slice(0, 140)}`;
    if (s.blacklistOnFail) {
        pick.key.blacklisted = true;
    } else if (Number(s.cooldownSeconds) > 0) {
        pick.key.cooldownUntil = Date.now() + Number(s.cooldownSeconds) * 1000;
    }
    emitState();
}

/* ------------------------------------------------------------ 钩子安装 */

let installed = false;

export function installHooks() {
    if (installed) return;
    installed = true;

    // 阶段 1：官方生成前钩子（manifest.generate_interceptor 查的是 globalThis）
    globalThis.apiRotatorInterceptor = async function (_chat, _contextSize, _abort, type) {
        const gen = logStore.nextGen();
        const kind = String(type ?? 'normal');
        try {
            // 并发检测：上一次生成还没走到 GENERATION_ENDED 就又进来了。
            // currentPick 是模块级单变量，后一次会把前一次覆盖掉，两次请求可能
            // 共用同一个 (端点, key)。这是已知缺陷，本版本只记录、不修复。
            if (currentPick) {
                logStore.push('concurrent', gen,
                    `上一次生成 #${currentPick.gen} 还没结束就开始了本次 #${gen}，两次请求可能共用同一个端点/key`,
                    { prevGen: currentPick.gen, prev: describe(currentPick), type: kind });
            }

            // 上一轮若因异常未还原，这里兜底
            restoreSettings();
            currentPick = null;

            const s = getSettings();
            genStats = { gen, t0: Date.now(), requests: 0, picked: false };
            logStore.push('hook', gen, `拦截器被调用（类型 ${kind}）`, { type: kind, ...poolInfo(s) });

            if (!s.enabled) {
                logStore.push('skip', gen, '轮询未启用，本次走酒馆自身的 API 设置', { reason: 'disabled' });
                return;
            }
            if (kind === 'quiet' && !s.includeQuiet) {
                logStore.push('skip', gen, '后台请求（quiet），按设置不接管', { reason: 'quiet' });
                return;
            }

            const flat = s.rotateMode === 'flat';
            const cursorBefore = flat ? s.flatCursor : s.cursor;

            const pick = pickNext();
            if (!pick) {
                logStore.push('skip', gen, '没有可用的端点/密钥，本次沿用酒馆自身设置',
                    { reason: 'no-candidate', ...poolInfo(s) }, 'warn');
                console.warn('[api-rotator] 没有可用的端点/密钥，本次沿用酒馆自身设置');
                globalThis.toastr?.warning('没有可用的端点或密钥，本次沿用酒馆自身设置', 'API 轮询');
                return;
            }
            currentPick = { ...pick, gen, tried: new Set([pairId(pick.endpoint, pick.key)]) };
            genStats.picked = true;
            applyPick(currentPick);

            logStore.push('pick', gen, `选中 ${describe(currentPick)}`, {
                endpoint: pick.endpoint.name || pick.endpoint.type,
                epType: pick.endpoint.type,
                key: maskKey(pick.key.value),
                model: pick.endpoint.model,
                mode: s.rotateMode,
                strategy: s.strategy,
                cursor: `${cursorBefore}→${flat ? s.flatCursor : s.cursor}`,
                epCursor: pick.endpoint.cursor,
                ...poolInfo(s),
            });

            if (s.logRequests) console.log(`[api-rotator] 本次使用 → ${describe(currentPick)}`);
            emitState();
        } catch (err) {
            logStore.push('skip', gen, `拦截器异常：${err.message}`, { reason: 'error' }, 'error');
            console.error('[api-rotator] 拦截器异常，本次沿用酒馆自身设置', err);
            restoreSettings();
            currentPick = null;
        }
    };

    // 阶段 2：改写出站请求体
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (data) => {
        if (!data) return;
        if (!currentPick) {
            logStore.push('bypass', genStats?.gen || 0,
                '请求体已就绪，但当前没有选中的端点 —— 这次生成不走轮询',
                { source: data.chat_completion_source, model: data.model }, 'debug');
            return;
        }
        try {
            applyToRequest(data, currentPick);
            logStore.push('send', currentPick.gen, `请求带出 ${describe(currentPick)}`, {
                endpoint: currentPick.endpoint.name || currentPick.endpoint.type,
                key: maskKey(currentPick.key.value),
                model: currentPick.endpoint.model,
                url: trimUrl(currentPick.endpoint.url),
                stream: !!data.stream,
            });
        } catch (err) {
            logStore.push('send', currentPick.gen, `请求体改写失败：${err.message}`, null, 'error');
            console.error('[api-rotator] 请求体改写失败', err);
        }
    });

    // 收尾还原
    const finish = (reason) => () => {
        if (genStats) {
            const ms = Date.now() - genStats.t0;
            // 选了 key 却一个请求都没发出去 —— 游标被白白推进，下一条消息看起来就「跳」了一个 key
            if (genStats.picked && genStats.requests === 0) {
                logStore.push('idle-pick', genStats.gen,
                    '本次选中了端点/key 却没有发出任何请求，游标已被推进 —— 下一条消息会看起来跳过一个 key',
                    { ms, reason });
            }
            logStore.push('end', genStats.gen,
                `生成结束（${reason}），本次发出 ${genStats.requests} 个请求，用时 ${ms}ms`,
                { requests: genStats.requests, ms, reason });
        }
        genStats = null;
        restoreSettings();
        currentPick = null;
        persist();
        emitState();
    };
    eventSource.on(event_types.GENERATION_ENDED, finish('正常结束'));
    eventSource.on(event_types.GENERATION_STOPPED, finish('被中止'));
    globalThis.addEventListener('beforeunload', () => { restoreSettings(); flushLog(); });

    installFetchWrapper();
}

/**
 * 判断一次生成请求是否失败。
 *
 * 酒馆对上游错误的包装方式并不统一（已在 1.18.0 实测）：
 *   openai 非流式 → HTTP 200，body {"error":{"message":"Too Many Requests"}}
 *   openai 流式   → HTTP 429，body 为上游原文
 *   claude 非流式 → HTTP 500，body {"error":true}
 *   gemini 非流式 → HTTP 500，body {"error":{...}}
 * 所以只看 response.ok 会漏掉最常见的非流式限流，必须同时看 body。
 *
 * @returns {Promise<{status:number, message:string}|null>} null 表示成功
 */
export async function detectFailure(response, isStream) {
    if (!response.ok) {
        let text = '';
        try { text = await response.clone().text(); } catch { /* ignore */ }
        return { status: response.status, message: extractErrorMessage(text) || response.statusText || '请求失败' };
    }

    // 200 且是流式：不消费 body 就无法判断，交给酒馆自身的流内错误处理
    if (isStream) return null;

    let json = null;
    try { json = await response.clone().json(); } catch { return null; }
    if (json && json.error) {
        const msg = typeof json.error === 'object'
            ? (json.error.message || JSON.stringify(json.error))
            : String(json.error);
        return { status: 200, message: msg };
    }
    return null;
}

export function extractErrorMessage(text) {
    if (!text) return '';
    try {
        const j = JSON.parse(text);
        if (j?.error?.message) return String(j.error.message);
        if (typeof j?.error === 'string') return j.error;
    } catch { /* 非 JSON */ }
    return String(text).slice(0, 160);
}

/**
 * 失败重试：仅对阶段 2 打过标记的请求生效，其余流量原样放行。
 * 这是「仅接管主聊天」承诺的兑现方式 —— 其他插件走 ChatCompletionService
 * 自己 fetch（custom-request.js:462），不会带标记，因此完全不受影响。
 */
function installFetchWrapper() {
    // 必须绑到 globalThis：调用方多为 ES module（严格模式），裸调 fetch(...) 时 this 是
    // undefined，原生 fetch 被这样转发会抛 "Illegal invocation"，进而拖垮酒馆自身的
    // pingServer() 等调用，导致生成整个卡死。
    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        if (!init || typeof init.body !== 'string' || !url.includes(GENERATE_URL)) {
            return originalFetch(input, init);
        }

        let body;
        try {
            body = JSON.parse(init.body);
        } catch {
            return originalFetch(input, init);
        }

        const tagGen = body?.[ROTATOR_TAG];
        if (!body || !tagGen) {
            // 主聊天生成请求发出去了，但身上没有轮询标记 —— 这条完全没走轮询池。
            // 排查「某些场景没轮询」时，这是最直接的一条证据。
            logStore.push('bypass', genStats?.gen || 0,
                '有一个生成请求没有走轮询，用的是酒馆自身的 API 设置',
                { source: body?.chat_completion_source, model: body?.model, stream: !!body?.stream });
            return originalFetch(input, init);
        }
        delete body[ROTATOR_TAG];

        // 串台检测：请求在阶段 2 绑定的批次号，与此刻全局选中的批次号不一致，
        // 说明有另一次生成插进来把 currentPick 覆盖了（并发缺陷）。
        // 发出前和响应返回时各查一次 —— 后者才是并发最常发生的时机：
        // 请求还在飞，另一次生成已经改了 currentPick，回来时成败就记到别人的 key 上了。
        const checkCrosstalk = (when) => {
            if (!currentPick || currentPick.gen === tagGen) return;
            logStore.push('crosstalk', tagGen,
                `${when}：本请求绑定批次 #${tagGen}，此刻全局却是 #${currentPick.gen}（${describe(currentPick)}）`
                + ' —— 两次生成串台，成败统计会记到错误的 key 上',
                { when, taggedGen: tagGen, activeGen: currentPick.gen, active: describe(currentPick) });
        };
        checkCrosstalk('请求发出前');

        const s = getSettings();
        const pickAtStart = currentPick;
        const isStream = !!body.stream;
        const genOf = () => currentPick?.gen || tagGen;
        let attempt = 0;

        for (;;) {
            if (genStats) genStats.requests++;
            const t0 = Date.now();
            const response = await originalFetch(input, { ...init, body: JSON.stringify(body) });
            const ms = Date.now() - t0;
            checkCrosstalk('响应返回时');

            const failure = await detectFailure(response, isStream);
            if (!failure) {
                recordSuccess(currentPick);
                logStore.push('ok', genOf(),
                    `请求成功，用时 ${ms}ms${currentPick ? ` → ${describe(currentPick)}` : ''}`,
                    { ms, status: response.status, stream: isStream });
                return response;
            }
            recordFailure(currentPick, failure.status, failure.message);
            logStore.push('fail', genOf(), `请求失败 ${failure.status}：${failure.message}`, {
                status: failure.status,
                message: failure.message,
                ms,
                endpoint: currentPick?.endpoint?.name || currentPick?.endpoint?.type,
                key: currentPick ? maskKey(currentPick.key.value) : undefined,
            });

            if (s.onFailure !== 'next') {
                logStore.push('giveup', genOf(), '按设置直接报错，不重试', { reason: 'no-retry' });
                if (s.logRequests) console.warn(`[api-rotator] 请求失败（${failure.status}: ${failure.message}），按设置直接报错（不重试）`);
                return response;
            }
            if (attempt >= Number(s.maxRetries || 0)) {
                logStore.push('giveup', genOf(), `已重试 ${attempt} 次仍失败，放弃`,
                    { reason: 'max-retries', attempt });
                console.warn(`[api-rotator] 重试 ${attempt} 次后仍失败，放弃`);
                return response;
            }

            const preferType = s.preferSameTypeOnRetry ? pickAtStart?.endpoint?.type ?? null : null;
            const tried = currentPick?.tried ?? new Set();
            const next = pickNext(tried, preferType);
            if (!next) {
                logStore.push('giveup', genOf(), '没有其他可用的端点/密钥可供重试',
                    { reason: 'no-candidate', tried: tried.size });
                console.warn('[api-rotator] 没有其他可用的端点/密钥可供重试');
                return response;
            }

            attempt++;
            tried.add(pairId(next.endpoint, next.key));
            const from = currentPick ? describe(currentPick) : '(未知)';
            currentPick = { ...next, gen: genOf(), tried };
            applyPick(currentPick);       // 同步全局设置，保证响应解析用对解析器
            applyToRequest(body, currentPick);
            delete body[ROTATOR_TAG];

            const crossVendor = next.endpoint.type !== pickAtStart?.endpoint?.type;
            logStore.push('retry', currentPick.gen, `第 ${attempt} 次重试：${from} → ${describe(currentPick)}`,
                { attempt, from, to: describe(currentPick), crossVendor });

            if (crossVendor) {
                console.warn('[api-rotator] 重试切换到了不同厂商类型，请求体中的厂商专有参数可能不完全匹配');
            }
            if (s.logRequests) console.log(`[api-rotator] 第 ${attempt} 次重试 → ${describe(currentPick)}`);
            emitState();
        }
    };
}
