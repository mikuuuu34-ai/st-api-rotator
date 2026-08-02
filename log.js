/**
 * st-api-rotator — 日志缓冲（纯逻辑）
 *
 * 和 selector.js 一样刻意不 import 任何 SillyTavern 模块：环形缓冲的上限行为、
 * 级别筛选、序列化往返、以及「绝不记录消息内容」这条硬约束，都要能在 Node 里
 * 直接断言，不需要跑浏览器。
 *
 * 存放策略（三处各司其职）：
 *   - 开关与上限  → extension_settings（随酒馆存盘）
 *   - 日志条目    → localStorage（不能写进 settings.json，见 engine.js 的 persist 注释）
 *   - 全量导出    → 用户下载的 .txt
 */

/** 面板最多渲染多少条 —— 再多 DOM 就开始拖慢生成时的重绘了，其余靠导出看 */
export const PANEL_MAX = 100;

/** 默认保留条数 */
export const DEFAULT_MAX = 1000;

export const STORAGE_KEY = 'apiRotator_log_v1';

/** 写 localStorage 的体积上限。浏览器配额普遍 5MB，留足余量给酒馆自己的数据 */
export const STORAGE_BUDGET = 3 * 1024 * 1024;

export const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * 事件表。level 是默认级别，push 时可以覆盖。
 * 标 ★ 的是为排查「没有正确轮询」专门加的诊断事件。
 */
export const LOG_EVENTS = {
    hook: { label: '进入拦截器', level: 'info' },
    concurrent: { label: '并发生成', level: 'warn' },   // ★ 上一次还没结束就开始了下一次
    skip: { label: '跳过轮询', level: 'info' },
    pick: { label: '选中', level: 'info' },
    apply: { label: '改写全局设置', level: 'debug' },
    send: { label: '请求带出', level: 'info' },
    crosstalk: { label: '串台', level: 'error' },       // ★ 请求带的批次号和当前选中的对不上
    bypass: { label: '未走轮询', level: 'warn' },       // ★ 生成请求发出去了但没有轮询标记
    ok: { label: '成功', level: 'info' },
    fail: { label: '失败', level: 'error' },
    retry: { label: '重试', level: 'warn' },
    giveup: { label: '放弃重试', level: 'warn' },
    end: { label: '生成结束', level: 'info' },
    'idle-pick': { label: '空转', level: 'warn' },      // ★ 推进了游标却没发出任何请求
    restore: { label: '还原设置', level: 'debug' },
};

/**
 * 明确禁止进日志的字段名。
 * 「日志不记录消息内容」是这个功能的硬约束 —— 调用方本来就只传结构化的元信息，
 * 这里是兜底，防止后续改动不小心把整个请求体塞进来。
 */
const FORBIDDEN_KEYS = /^(messages|prompt|content|text|input|chat|history|body|data)$/i;

/** detail 里单个字符串值的长度上限 */
const MAX_VALUE_LEN = 200;

export function clampMax(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_MAX;
    return Math.min(Math.max(v, 10), 20000);
}

/**
 * 清洗 detail：丢掉疑似正文的字段，截断超长字符串，拍平嵌套对象。
 * @returns {object|undefined}
 */
export function sanitizeDetail(d) {
    if (!d || typeof d !== 'object') return undefined;
    const out = {};
    for (const [k, v] of Object.entries(d)) {
        if (FORBIDDEN_KEYS.test(k)) continue;
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'string') {
            out[k] = v.length > MAX_VALUE_LEN ? `${v.slice(0, MAX_VALUE_LEN)}…` : v;
        } else if (typeof v === 'number' || typeof v === 'boolean') {
            out[k] = v;
        } else {
            // 数组/对象只留一个短摘要，避免整棵树被序列化进来
            const s = safeStringify(v);
            out[k] = s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN)}…` : s;
        }
    }
    return Object.keys(out).length ? out : undefined;
}

function safeStringify(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
}

export function passes(entry, filter) {
    if (!entry) return false;
    if (filter === 'warn') return LEVEL_ORDER[entry.level] >= LEVEL_ORDER.warn;
    return true;
}

/* ------------------------------------------------------------------ 格式化 */

const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');

/** 面板用：HH:MM:SS.mmm */
export function fmtClock(t) {
    const d = new Date(t);
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

/** 导出用：YYYY-MM-DD HH:MM:SS.mmm（本地时间，比 ISO 更好读） */
export function fmtStamp(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtClock(t)}`;
}

export function eventLabel(ev) {
    return LOG_EVENTS[ev]?.label || ev;
}

/** 导出文本里的一条（带细节行） */
export function formatEntry(e) {
    const gen = e.gen ? `#${e.gen}` : '#-';
    const head = `${fmtStamp(e.t)}  ${gen.padEnd(6)} ${e.level.toUpperCase().padEnd(5)} ${String(e.ev).padEnd(11)} ${e.msg}`;
    if (!e.d) return head;
    return `${head}\n${' '.repeat(31)}↳ ${safeStringify(e.d)}`;
}

/* -------------------------------------------------------------------- 缓冲 */

/**
 * @param {{max?: number, now?: () => number}} opts now 可注入，便于测试
 */
export function createLogStore({ max = DEFAULT_MAX, now = () => Date.now() } = {}) {
    let entries = [];
    let seq = 0;
    let gen = 0;
    let limit = clampMax(max);
    let enabled = true;
    let minLevel = 'info';           // 「详细模式」下调成 debug
    const listeners = new Set();

    function trim() {
        if (entries.length > limit) entries.splice(0, entries.length - limit);
    }

    function emit() {
        for (const fn of listeners) { try { fn(); } catch { /* 监听器自己的问题不影响记录 */ } }
    }

    const store = {
        get size() { return entries.length; },
        get max() { return limit; },
        get enabled() { return enabled; },
        get currentGen() { return gen; },

        onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

        setEnabled(v) { enabled = !!v; },
        setVerbose(v) { minLevel = v ? 'debug' : 'info'; },
        setMax(n) { limit = clampMax(n); trim(); emit(); return limit; },

        /** 开一个新的生成批次；同一次生成的所有条目共用这个号 */
        nextGen() { return ++gen; },

        /**
         * @param {string} ev   事件名，见 LOG_EVENTS
         * @param {number} genId 生成批次号，0 表示不属于任何一次生成
         * @param {string} msg  人读的一行摘要
         * @param {object} [d]  结构化细节，会被 sanitizeDetail 清洗
         * @param {string} [levelOverride]
         * @returns {object|null} 落库的条目，被过滤掉时返回 null
         */
        push(ev, genId, msg, d, levelOverride) {
            if (!enabled) return null;
            const level = levelOverride || LOG_EVENTS[ev]?.level || 'info';
            if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return null;

            const entry = {
                id: ++seq,
                t: now(),
                gen: Number(genId) || 0,
                ev,
                level,
                msg: String(msg ?? '').slice(0, 400),
            };
            const detail = sanitizeDetail(d);
            if (detail) entry.d = detail;

            entries.push(entry);
            trim();
            emit();
            return entry;
        },

        /** 时间正序（最早在前），导出与测试用 */
        all(filter = 'all') {
            return entries.filter(e => passes(e, filter));
        },

        /** 最新在前，最多 n 条 —— 面板渲染用 */
        recent(n = PANEL_MAX, filter = 'all') {
            const out = [];
            for (let i = entries.length - 1; i >= 0 && out.length < n; i--) {
                if (passes(entries[i], filter)) out.push(entries[i]);
            }
            return out;
        },

        /** 满足筛选条件的总数（面板要显示「共 N 条」） */
        count(filter = 'all') {
            return filter === 'all' ? entries.length : entries.filter(e => passes(e, filter)).length;
        },

        clear() { entries = []; emit(); },

        /**
         * 序列化到 localStorage。超出体积预算时丢最早的一半，
         * 宁可少留历史也不能把配额撑爆导致酒馆自己写不进去。
         */
        serialize() {
            let list = entries;
            for (let i = 0; i < 8; i++) {
                const raw = JSON.stringify({ v: 1, seq, gen, entries: list });
                if (raw.length <= STORAGE_BUDGET || list.length <= 1) return raw;
                list = list.slice(Math.ceil(list.length / 2));
            }
            return JSON.stringify({ v: 1, seq, gen, entries: [] });
        },

        /** 从 localStorage 恢复。数据坏了就当没有，不抛异常。 */
        hydrate(raw) {
            if (!raw) return false;
            let parsed;
            try { parsed = JSON.parse(raw); } catch { return false; }
            if (!parsed || !Array.isArray(parsed.entries)) return false;

            entries = parsed.entries
                .filter(e => e && typeof e.id === 'number' && typeof e.t === 'number' && e.ev)
                .map(e => ({
                    id: e.id, t: e.t, gen: Number(e.gen) || 0,
                    ev: String(e.ev), level: LEVEL_ORDER[e.level] === undefined ? 'info' : e.level,
                    msg: String(e.msg ?? ''),
                    ...(e.d && typeof e.d === 'object' ? { d: e.d } : {}),
                }));
            trim();
            // 序号和批次号必须接着往上走，否则刷新后新旧条目的编号会撞在一起
            seq = Math.max(Number(parsed.seq) || 0, ...entries.map(e => e.id), 0);
            gen = Math.max(Number(parsed.gen) || 0, ...entries.map(e => e.gen), 0);
            emit();
            return true;
        },

        /** 导出成人读文本，时间正序 */
        toText(filter = 'all', meta = {}) {
            const list = store.all(filter);
            const head = [
                '# st-api-rotator 运行日志',
                `# 导出时间：${fmtStamp(now())}`,
                `# 条目：${list.length}${filter === 'warn' ? '（仅警告与错误）' : ''} / 保留上限 ${limit}`,
                ...Object.entries(meta).map(([k, v]) => `# ${k}：${v}`),
                '# 本日志不含任何消息内容，key 一律掩码显示。',
                '#',
                '# 时间                    批次   级别  事件        摘要',
                `#${'-'.repeat(79)}`,
            ];
            return `${head.join('\n')}\n${list.map(formatEntry).join('\n')}\n`;
        },
    };

    return store;
}
