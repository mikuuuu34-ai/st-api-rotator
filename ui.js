/**
 * st-api-rotator — 设置面板
 */

import { renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    EXTENSION_PATH, ENDPOINT_TYPES,
    getSettings, persist, normalizeEndpoint, uid,
    availableKeys, isEndpointAvailable, isKeyAvailable, endpointIssues,
    getCurrentPick, onStateChange, reviveKey, resetAllStats,
    maskKey, describe, fetchModels, builtinModels,
} from './engine.js';

const $ = globalThis.jQuery;

/** 模型列表最多缓存多少条，避免把 settings.json 撑爆 */
const MAX_CACHED_MODELS = 400;

export async function initUi() {
    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    $('#extensions_settings').append(html);

    bindGlobalControls();
    renderEndpoints();
    renderStatus();

    onStateChange(() => { renderStatus(); });
    setInterval(renderStatus, 2000); // 冷却倒计时
}

/* ------------------------------------------------------------- 全局控件 */

function bindGlobalControls() {
    const s = getSettings();

    const bindCheck = (id, field) => {
        $(id).off('change.apirot').prop('checked', !!s[field]).on('change.apirot', function () {
            getSettings()[field] = !!$(this).prop('checked');
            persist();
            toggleConditional();
        });
    };
    const bindVal = (id, field, cast = String) => {
        $(id).off('change.apirot input.apirot').val(s[field]).on('change.apirot input.apirot', function () {
            getSettings()[field] = cast($(this).val());
            persist();
            toggleConditional();
        });
    };

    bindCheck('#apirot_enabled', 'enabled');
    bindCheck('#apirot_blacklist', 'blacklistOnFail');
    bindCheck('#apirot_quiet', 'includeQuiet');
    bindCheck('#apirot_log', 'logRequests');
    bindCheck('#apirot_prefersame', 'preferSameTypeOnRetry');

    bindVal('#apirot_mode', 'rotateMode');
    bindVal('#apirot_strategy', 'strategy');
    bindVal('#apirot_onfailure', 'onFailure');
    bindVal('#apirot_maxretries', 'maxRetries', Number);
    bindVal('#apirot_cooldown', 'cooldownSeconds', Number);

    $('#apirot_add').off('click.apirot').on('click.apirot', () => {
        const s2 = getSettings();
        s2.endpoints.push(normalizeEndpoint({
            id: uid(),
            name: `端点 ${s2.endpoints.length + 1}`,
            type: 'openai',
            url: '',
            model: '',
            enabled: true,
            weight: 1,
            keys: [],
            collapsed: false,   // 刚建的端点直接展开，方便填写
        }));
        persist();
        renderEndpoints();
    });

    $('#apirot_expand_all').off('click.apirot').on('click.apirot', () => {
        const s2 = getSettings();
        const anyCollapsed = s2.endpoints.some(e => e.collapsed);
        for (const e of s2.endpoints) e.collapsed = !anyCollapsed;
        persist();
        renderEndpoints();
    });

    $('#apirot_export').off('click.apirot').on('click.apirot', exportConfig);
    $('#apirot_import').off('click.apirot').on('click.apirot', importConfig);
    $('#apirot_reset').off('click.apirot').on('click.apirot', () => {
        resetAllStats();
        persist();
        renderEndpoints();
        renderStatus();
        globalThis.toastr?.success('已重置计数并解除全部冷却', 'API 轮询');
    });

    toggleConditional();
}

function toggleConditional() {
    const s = getSettings();
    $('.apirot-retry-only').toggle(s.onFailure === 'next');
}

/* --------------------------------------------------------- 端点列表渲染 */

function renderEndpoints() {
    const s = getSettings();
    const $wrap = $('#apirot_endpoints').empty();

    if (!s.endpoints.length) {
        $wrap.append('<div class="apirot-empty">还没有端点。点「新增」添加第一个。</div>');
        return;
    }

    s.endpoints.forEach((e, idx) => $wrap.append(endpointCard(e, idx)));

    const anyCollapsed = s.endpoints.some(e => e.collapsed);
    $('#apirot_expand_all').attr('title', anyCollapsed ? '全部展开' : '全部收起')
        .find('i').attr('class', anyCollapsed ? 'fa-solid fa-angles-down' : 'fa-solid fa-angles-up');
}

function endpointCard(e, idx) {
    const t = ENDPOINT_TYPES[e.type];
    const okCount = availableKeys(e).length;
    const total = (e.keys || []).length;
    const issues = endpointIssues(e);
    const dead = !isEndpointAvailable(e);
    const listId = `apirot_models_${e.id}`;

    const $card = $(`
        <div class="apirot-card ${dead ? 'apirot-card-dead' : ''} ${e.collapsed ? 'apirot-collapsed' : ''}" data-id="${e.id}">
            <div class="apirot-card-head">
                <div class="apirot-chevron ep-toggle" title="展开 / 收起">
                    <i class="fa-solid ${e.collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>
                </div>
                <label class="checkbox_label apirot-inline" title="启用该端点">
                    <input type="checkbox" class="ep-enabled" ${e.enabled ? 'checked' : ''}>
                </label>
                <input type="text" class="text_pole ep-name" value="${escapeAttr(e.name || '')}" placeholder="名称">
                <span class="apirot-badge ${issues.length ? 'apirot-badge-warn' : ''}"
                      title="${issues.length ? escapeAttr(issues.join('、')) : ''}">${issues.length ? issues[0] : `${okCount}/${total} key`}</span>
                <div class="apirot-card-actions">
                    <div class="menu_button ep-up" title="上移"><i class="fa-solid fa-arrow-up"></i></div>
                    <div class="menu_button ep-down" title="下移"><i class="fa-solid fa-arrow-down"></i></div>
                    <div class="menu_button ep-del" title="删除端点"><i class="fa-solid fa-trash"></i></div>
                </div>
            </div>

            <div class="apirot-summary">${escapeHtml(t.label)} · ${escapeHtml(e.model || '未设模型')}</div>

            <div class="apirot-card-body">
                <div class="apirot-grid">
                    <div>
                        <label>类型</label>
                        <select class="text_pole ep-type">
                            ${Object.entries(ENDPOINT_TYPES).map(([k, v]) =>
        `<option value="${k}" ${e.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                    </select>
                    </div>
                    <div>
                        <label>权重<small>（按权重随机时生效）</small></label>
                        <input type="number" class="text_pole ep-weight" min="1" step="1" value="${Number(e.weight) || 1}">
                    </div>
                </div>

                <label>接口地址<small>（基址，不要带 /chat/completions）</small></label>
                <input type="text" class="text_pole ep-url" value="${escapeAttr(e.url || '')}" placeholder="${t.urlHint}">

                <label>模型</label>
                <div class="apirot-model-row">
                    <input type="text" class="text_pole ep-model" list="${listId}"
                           value="${escapeAttr(e.model || '')}" placeholder="点右侧加载，或直接手输入">
                    <div class="menu_button ep-loadmodels" title="从该端点拉取可用模型列表">
                        <i class="fa-solid fa-cloud-arrow-down"></i> 加载
                    </div>
                </div>
                <datalist id="${listId}">
                    ${(e.knownModels || []).map(m => `<option value="${escapeAttr(m)}"></option>`).join('')}
                </datalist>
                <div class="apirot-model-hint">${modelHintText(e)}</div>

                <div class="apirot-grid">
                    <div>
                        <label>key 选择方式</label>
                        <select class="text_pole ep-keystrategy">
                            <option value="round_robin" ${e.keyStrategy === 'round_robin' ? 'selected' : ''}>依次轮询</option>
                            <option value="random" ${e.keyStrategy === 'random' ? 'selected' : ''}>随机</option>
                        </select>
                    </div>
                </div>

                <label>密钥</label>
                <div class="apirot-keys"></div>
                <textarea class="text_pole ep-newkeys" rows="2"
                    placeholder="批量添加：每行一个 key，粘贴后点下方按钮"></textarea>
                <div class="menu_button ep-addkeys"><i class="fa-solid fa-plus"></i> 添加这些 key</div>
            </div>
        </div>
    `);

    $card.find('.apirot-card-body').toggle(!e.collapsed);
    $card.find('.apirot-summary').toggle(!!e.collapsed);
    $card.find('.apirot-keys').append(renderKeys(e));
    bindEndpointCard($card, e, idx);
    return $card;
}

function modelHintText(e) {
    const n = (e.knownModels || []).length;
    if (n) return `已加载 ${n} 个模型，点输入框可下拉选择，也可以直接手输入`;
    return '可以直接手输入模型名；点「加载」会从该端点拉取真实可用的列表';
}

function renderKeys(e) {
    if (!e.keys.length) return $('<div class="apirot-empty">该端点还没有 key</div>');
    const $list = $('<div></div>');
    for (const k of e.keys) {
        const cooling = k.cooldownUntil && k.cooldownUntil > Date.now();
        const left = cooling ? Math.ceil((k.cooldownUntil - Date.now()) / 1000) : 0;
        const state = k.blacklisted ? '已停用' : cooling ? `冷却 ${left}s` : k.enabled ? '正常' : '已关闭';
        const cls = isKeyAvailable(k) ? 'ok' : 'bad';
        const $row = $(`
            <div class="apirot-key ${cls}" data-kid="${k.id}">
                <label class="checkbox_label apirot-inline">
                    <input type="checkbox" class="k-enabled" ${k.enabled ? 'checked' : ''}>
                </label>
                <code class="apirot-keyval" title="点击显示完整 key">${escapeHtml(maskKey(k.value))}</code>
                <span class="apirot-keystate">${state}</span>
                <span class="apirot-keystat">✓${k.ok || 0} ✗${k.fail || 0}</span>
                <div class="menu_button k-revive" title="解除冷却/停用"><i class="fa-solid fa-heart-pulse"></i></div>
                <div class="menu_button k-del" title="删除"><i class="fa-solid fa-xmark"></i></div>
            </div>
        `);
        if (k.lastError) $row.find('.apirot-keystate').attr('title', k.lastError);
        $row.find('.apirot-keyval').on('click', function () {
            const showing = $(this).data('showing');
            $(this).text(showing ? maskKey(k.value) : k.value).data('showing', !showing);
        });
        $row.find('.k-enabled').on('change', function () {
            k.enabled = !!$(this).prop('checked');
            persist(); renderEndpoints();
        });
        $row.find('.k-revive').on('click', () => { reviveKey(k); persist(); renderEndpoints(); });
        $row.find('.k-del').on('click', () => {
            e.keys = e.keys.filter(x => x.id !== k.id);
            persist(); renderEndpoints();
        });
        $list.append($row);
    }
    return $list;
}

function bindEndpointCard($card, e, idx) {
    const s = getSettings();
    const save = () => { persist(); };

    // 收起 / 展开：只重绘这张卡，避免整列表重建导致输入焦点丢失
    $card.find('.ep-toggle').on('click', () => {
        e.collapsed = !e.collapsed;
        save();
        $card.toggleClass('apirot-collapsed', !!e.collapsed);
        $card.find('.apirot-card-body').toggle(!e.collapsed);
        $card.find('.apirot-summary').toggle(!!e.collapsed);
        $card.find('.ep-toggle i').attr('class',
            `fa-solid ${e.collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}`);
    });

    $card.find('.ep-enabled').on('change', function () { e.enabled = !!$(this).prop('checked'); save(); renderEndpoints(); });
    $card.find('.ep-name').on('input', function () { e.name = String($(this).val()); save(); });
    $card.find('.ep-url').on('input', function () { e.url = String($(this).val()); save(); });
    $card.find('.ep-weight').on('input', function () { e.weight = Number($(this).val()) || 1; save(); });
    $card.find('.ep-keystrategy').on('change', function () { e.keyStrategy = String($(this).val()); save(); });

    // 模型改动会影响端点是否「配置完整」，需要刷新徽标；但不能整列表重绘（会丢焦点）
    $card.find('.ep-model').on('input', function () {
        e.model = String($(this).val()).trim();
        save();
        refreshCardBadge($card, e);
        renderStatus();
    });

    $card.find('.ep-type').on('change', function () {
        e.type = String($(this).val());
        e.knownModels = [];   // 换了厂商，之前拉的列表不再适用
        save(); renderEndpoints();
    });

    $card.find('.ep-loadmodels').on('click', function () {
        loadModelsFor($card, e, $(this));
    });

    $card.find('.ep-del').on('click', () => {
        if (!confirm(`删除端点「${e.name || e.type}」及其 ${e.keys.length} 个 key？`)) return;
        s.endpoints = s.endpoints.filter(x => x.id !== e.id);
        save(); renderEndpoints();
    });
    $card.find('.ep-up').on('click', () => { move(s.endpoints, idx, -1); save(); renderEndpoints(); });
    $card.find('.ep-down').on('click', () => { move(s.endpoints, idx, +1); save(); renderEndpoints(); });

    $card.find('.ep-addkeys').on('click', () => {
        const raw = String($card.find('.ep-newkeys').val() || '');
        const added = raw.split('\n').map(x => x.trim()).filter(Boolean);
        if (!added.length) return;
        let dup = 0;
        for (const v of added) {
            if (e.keys.some(k => k.value === v)) { dup++; continue; }
            e.keys.push({ id: uid(), value: v, label: '', enabled: true, ok: 0, fail: 0 });
        }
        save(); renderEndpoints();
        globalThis.toastr?.success(`已添加 ${added.length - dup} 个 key${dup ? `，跳过 ${dup} 个重复` : ''}`, 'API 轮询');
    });
}

/** 只更新卡片头部的徽标与失效样式，不重建整张卡 */
function refreshCardBadge($card, e) {
    const issues = endpointIssues(e);
    const okCount = availableKeys(e).length;
    const total = (e.keys || []).length;
    $card.toggleClass('apirot-card-dead', !isEndpointAvailable(e));
    $card.find('.apirot-badge')
        .toggleClass('apirot-badge-warn', issues.length > 0)
        .attr('title', issues.join('、'))
        .text(issues.length ? issues[0] : `${okCount}/${total} key`);
    const t = ENDPOINT_TYPES[e.type];
    $card.find('.apirot-summary').text(`${t.label} · ${e.model || '未设模型'}`);
}

/* ------------------------------------------------------------ 加载模型 */

async function loadModelsFor($card, e, $btn) {
    const original = $btn.html();
    $btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 加载中').addClass('disabled');
    const $hint = $card.find('.apirot-model-hint');

    let models = [];
    let note = '';
    try {
        models = await fetchModels(e);
        note = `已从该端点加载 ${models.length} 个模型`;
    } catch (err) {
        // 拉取失败就回落到酒馆内置列表：Claude 官方端点不认 Bearer，
        // 私有中转站也可能没开放 /v1/models，这时至少给出常见型号。
        const fallback = builtinModels(e.type);
        if (fallback.length) {
            models = fallback;
            note = `无法从该端点获取（${err.message}），已改用酒馆内置的 ${models.length} 个常见模型`;
            globalThis.toastr?.warning(note, 'API 轮询');
        } else {
            $hint.text(`加载失败：${err.message}`);
            globalThis.toastr?.error(err.message, 'API 轮询');
            $btn.html(original).removeClass('disabled');
            return;
        }
    }

    if (models.length > MAX_CACHED_MODELS) {
        note += `（列表过长，只保留前 ${MAX_CACHED_MODELS} 个）`;
        models = models.slice(0, MAX_CACHED_MODELS);
    }

    e.knownModels = models;
    persist();

    // 刷新 datalist，不重建整张卡（否则输入焦点和展开状态都会丢）
    const listId = `apirot_models_${e.id}`;
    $card.find(`#${listId}`).html(models.map(m => `<option value="${escapeAttr(m)}"></option>`).join(''));
    $hint.text(note);
    $btn.html(original).removeClass('disabled');

    // 当前没填模型时，自动带上第一个，省一次输入
    if (!e.model && models.length) {
        e.model = models[0];
        $card.find('.ep-model').val(e.model);
        persist();
        refreshCardBadge($card, e);
        renderStatus();
    }
}

function move(arr, idx, delta) {
    const to = idx + delta;
    if (to < 0 || to >= arr.length) return;
    const [item] = arr.splice(idx, 1);
    arr.splice(to, 0, item);
}

/* ----------------------------------------------------------- 状态面板 */

function renderStatus() {
    const $box = $('#apirot_status');
    if (!$box.length) return;
    const s = getSettings();
    const pick = getCurrentPick();

    const endpoints = s.endpoints.length;
    const usableEndpoints = s.endpoints.filter(isEndpointAvailable).length;
    const totalKeys = s.endpoints.reduce((a, e) => a + e.keys.length, 0);
    const usableKeys = s.endpoints.reduce((a, e) => a + availableKeys(e).length, 0);
    const incomplete = s.endpoints.filter(e => e.enabled !== false && endpointIssues(e).length);

    $box.html(`
        <div>端点：<b>${usableEndpoints}/${endpoints}</b> 可用　密钥：<b>${usableKeys}/${totalKeys}</b> 可用</div>
        <div>当前占用：${pick ? `<b>${escapeHtml(describe(pick))}</b>` : '<i>空闲</i>'}</div>
        ${incomplete.length ? `<div class="apirot-warn">${incomplete.length} 个已启用的端点配置不完整：${
        incomplete.map(e => `${escapeHtml(e.name || e.type)}（${endpointIssues(e).join('、')}）`).join('；')}</div>` : ''}
        ${!s.enabled ? '<div class="apirot-warn">轮询未启用，当前走酒馆自身的 API 设置。</div>' : ''}
        ${s.enabled && usableKeys === 0 ? '<div class="apirot-warn">没有任何可用密钥，生成时会回退到酒馆自身设置。</div>' : ''}
    `);
}

/* ------------------------------------------------------------ 导入导出 */

function exportConfig() {
    const s = getSettings();
    const payload = JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: {
            rotateMode: s.rotateMode, strategy: s.strategy, onFailure: s.onFailure,
            maxRetries: s.maxRetries, cooldownSeconds: s.cooldownSeconds,
            blacklistOnFail: s.blacklistOnFail, includeQuiet: s.includeQuiet,
            preferSameTypeOnRetry: s.preferSameTypeOnRetry,
        },
        // 不导出 knownModels：那只是缓存，换机器重新加载即可，也能让文件小很多
        endpoints: s.endpoints.map(({ knownModels, ...rest }) => rest),
    }, null, 2);

    const blob = new Blob([payload], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'api-rotator-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
    globalThis.toastr?.info('配置里包含明文 key，注意保管导出的文件', 'API 轮询');
}

function importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!Array.isArray(data.endpoints)) throw new Error('缺少 endpoints 字段');
            const s = getSettings();
            if (s.endpoints.length && !confirm('导入会覆盖现有的全部端点配置，继续？')) return;
            s.endpoints = data.endpoints.map(normalizeEndpoint);
            Object.assign(s, data.settings || {});
            persist();
            renderEndpoints();
            bindGlobalControls();
            globalThis.toastr?.success(`已导入 ${s.endpoints.length} 个端点`, 'API 轮询');
        } catch (err) {
            globalThis.toastr?.error(`导入失败：${err.message}`, 'API 轮询');
        }
    };
    input.click();
}

/* -------------------------------------------------------------- 工具 */

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
const escapeAttr = escapeHtml;
