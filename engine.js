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
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

import {
    ENDPOINT_TYPES, defaultSettings,
    normalizeSettings, normalizeEndpoint, uid,
    isKeyAvailable, availableKeys, isEndpointAvailable, pairId,
    pickNextFrom, maskKey, trimUrl, reviveKey, resetAllStats as resetStatsIn,
} from './selector.js';

export {
    ENDPOINT_TYPES, defaultSettings, normalizeEndpoint, uid,
    isKeyAvailable, availableKeys, isEndpointAvailable, maskKey, trimUrl, reviveKey,
};

export const MODULE_KEY = 'apiRotator';
export const EXTENSION_NAME = 'st-api-rotator';
export const EXTENSION_PATH = `third-party/${EXTENSION_NAME}`;

const GENERATE_URL = '/api/backends/chat-completions/generate';
const ROTATOR_TAG = '__apiRotatorTag';

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

/** @type {{endpoint: object, key: object, tried: Set<string>} | null} */
let currentPick = null;
/** 被改写前的 oai_settings 字段快照 */
let snapshot = null;
/** 状态变更回调（UI 用） */
const listeners = new Set();

export function onStateChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emitState() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }
export function getCurrentPick() { return currentPick; }

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
    if (pick.endpoint.model) o[t.modelField] = pick.endpoint.model;
}

export function restoreSettings() {
    if (!snapshot) return;
    const o = oai();
    if (o) for (const [k, v] of Object.entries(snapshot)) o[k] = v;
    snapshot = null;
}

/** 阶段 2：改写出站请求体 */
function applyToRequest(data, pick) {
    const t = ENDPOINT_TYPES[pick.endpoint.type];
    data.chat_completion_source = t.source;
    data.reverse_proxy = trimUrl(pick.endpoint.url);
    data.proxy_password = pick.key.value;
    if (pick.endpoint.model) data.model = pick.endpoint.model;
    data[ROTATOR_TAG] = true;
}

export function describe(pick) {
    return `${pick.endpoint.name || pick.endpoint.type} / ${pick.key.label || maskKey(pick.key.value)} / ${pick.endpoint.model || '(跟随酒馆)'}`;
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
        try {
            // 上一轮若因异常未还原，这里兜底
            restoreSettings();
            currentPick = null;

            const s = getSettings();
            if (!s.enabled) return;
            if (type === 'quiet' && !s.includeQuiet) return;

            const pick = pickNext();
            if (!pick) {
                console.warn('[api-rotator] 没有可用的端点/密钥，本次沿用酒馆自身设置');
                globalThis.toastr?.warning('没有可用的端点或密钥，本次沿用酒馆自身设置', 'API 轮询');
                return;
            }
            currentPick = { ...pick, tried: new Set([pairId(pick.endpoint, pick.key)]) };
            applyPick(currentPick);
            if (s.logRequests) console.log(`[api-rotator] 本次使用 → ${describe(currentPick)}`);
            emitState();
        } catch (err) {
            console.error('[api-rotator] 拦截器异常，本次沿用酒馆自身设置', err);
            restoreSettings();
            currentPick = null;
        }
    };

    // 阶段 2：改写出站请求体
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (data) => {
        if (!currentPick || !data) return;
        try {
            applyToRequest(data, currentPick);
        } catch (err) {
            console.error('[api-rotator] 请求体改写失败', err);
        }
    });

    // 收尾还原
    const finish = () => {
        restoreSettings();
        currentPick = null;
        persist();
        emitState();
    };
    eventSource.on(event_types.GENERATION_ENDED, finish);
    eventSource.on(event_types.GENERATION_STOPPED, finish);
    globalThis.addEventListener('beforeunload', restoreSettings);

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
        if (!body || !body[ROTATOR_TAG]) {
            return originalFetch(input, init);
        }
        delete body[ROTATOR_TAG];

        const s = getSettings();
        const pickAtStart = currentPick;
        const isStream = !!body.stream;
        let attempt = 0;

        for (;;) {
            const response = await originalFetch(input, { ...init, body: JSON.stringify(body) });

            const failure = await detectFailure(response, isStream);
            if (!failure) {
                recordSuccess(currentPick);
                return response;
            }
            recordFailure(currentPick, failure.status, failure.message);

            if (s.onFailure !== 'next') {
                if (s.logRequests) console.warn(`[api-rotator] 请求失败（${failure.status}: ${failure.message}），按设置直接报错（不重试）`);
                return response;
            }
            if (attempt >= Number(s.maxRetries || 0)) {
                console.warn(`[api-rotator] 重试 ${attempt} 次后仍失败，放弃`);
                return response;
            }

            const preferType = s.preferSameTypeOnRetry ? pickAtStart?.endpoint?.type ?? null : null;
            const tried = currentPick?.tried ?? new Set();
            const next = pickNext(tried, preferType);
            if (!next) {
                console.warn('[api-rotator] 没有其他可用的端点/密钥可供重试');
                return response;
            }

            attempt++;
            tried.add(pairId(next.endpoint, next.key));
            currentPick = { ...next, tried };
            applyPick(currentPick);       // 同步全局设置，保证响应解析用对解析器
            applyToRequest(body, currentPick);
            delete body[ROTATOR_TAG];

            if (next.endpoint.type !== pickAtStart?.endpoint?.type) {
                console.warn('[api-rotator] 重试切换到了不同厂商类型，请求体中的厂商专有参数可能不完全匹配');
            }
            if (s.logRequests) console.log(`[api-rotator] 第 ${attempt} 次重试 → ${describe(currentPick)}`);
            emitState();
        }
    };
}
