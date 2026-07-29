#!/usr/bin/env node
/**
 * 假的多厂商 API 服务，用于验证 st-api-rotator。
 *
 * 它不校验任何东西，只做两件事：
 *   1. 把每个收到的请求（路径 / 认证头 / model / body）记进内存
 *   2. 按路径判断厂商，返回对应格式的合法响应
 *
 * 控制接口：
 *   GET  /__log      → 收到的全部请求（JSON 数组）
 *   POST /__reset    → 清空日志
 *   POST /__fail     → {keys:["sk-a"], status:429} 让指定 key 后续请求失败
 *
 * 用法：node test/fake-api.js [port]
 */

import http from 'node:http';

const PORT = Number(process.argv[2] || 8317);

/** @type {Array<object>} */
const log = [];
/** @type {{keys: Set<string>, status: number}} */
const failRule = { keys: new Set(), status: 429 };

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', c => data += c);
        req.on('end', () => resolve(data));
    });
}

/** 三家厂商传 key 的方式不同，全都捞一遍 */
function extractKey(req, url) {
    const auth = req.headers['authorization'];
    if (auth) return String(auth).replace(/^Bearer\s+/i, '');
    if (req.headers['x-api-key']) return String(req.headers['x-api-key']);
    if (req.headers['x-goog-api-key']) return String(req.headers['x-goog-api-key']);
    const q = url.searchParams.get('key');
    if (q) return q;
    return '';
}

function vendorOf(pathname) {
    if (pathname.includes('/messages')) return 'claude';
    if (pathname.includes('generateContent') || pathname.includes('models/')) return 'gemini';
    return 'openai';
}

function replyFor(vendor, text) {
    if (vendor === 'claude') {
        return {
            id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake',
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        };
    }
    if (vendor === 'gemini') {
        return {
            candidates: [{
                content: { parts: [{ text }], role: 'model' },
                finishReason: 'STOP', index: 0,
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        };
    }
    return {
        id: 'chatcmpl-fake', object: 'chat.completion', created: 0, model: 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
    };

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // ---- 控制接口 ----
    if (url.pathname === '/__log') {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify(log, null, 2));
    }
    if (url.pathname === '/__reset') {
        log.length = 0;
        failRule.keys.clear();
        res.writeHead(200, cors); return res.end('ok');
    }
    if (url.pathname === '/__fail') {
        const body = JSON.parse(await readBody(req) || '{}');
        failRule.keys = new Set(body.keys || []);
        failRule.status = Number(body.status) || 429;
        res.writeHead(200, cors); return res.end('ok');
    }

    // ---- 模型列表（GET {base}/models，Gemini 是 {base}/v1beta/models）----
    if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
        const key = extractKey(req, url);
        if (failRule.keys.has(key)) {
            res.writeHead(failRule.status, { 'Content-Type': 'application/json', ...cors });
            return res.end(JSON.stringify({ error: { message: 'fake failure' } }));
        }
        log.push({ seq: log.length + 1, method: 'GET', path: url.pathname, kind: 'models', key });
        const isGemini = url.pathname.includes('v1beta');
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify(isGemini
            ? { models: [{ name: 'models/fake-gemini-a' }, { name: 'models/fake-gemini-b' }] }
            : { data: [{ id: 'fake-model-a' }, { id: 'fake-model-b' }, { id: 'fake-model-c' }] }));
    }

    // ---- 模拟厂商接口 ----
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 非 JSON 也记下来 */ }

    const key = extractKey(req, url);
    const vendor = vendorOf(url.pathname);

    const entry = {
        seq: log.length + 1,
        at: Date.now(),
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        vendor,
        key,
        model: body.model || url.pathname.match(/models\/([^:]+)/)?.[1] || '',
        stream: !!body.stream,
        messageCount: Array.isArray(body.messages) ? body.messages.length
            : Array.isArray(body.contents) ? body.contents.length : 0,
        authHeader: req.headers['authorization'] || '',
        xApiKey: req.headers['x-api-key'] || '',
        xGoogKey: req.headers['x-goog-api-key'] || '',
    };
    log.push(entry);

    if (failRule.keys.has(key)) {
        entry.failed = true;
        res.writeHead(failRule.status, { 'Content-Type': 'application/json', ...cors });
        return res.end(JSON.stringify({ error: { message: `fake failure for key ${key}`, type: 'rate_limit_error' } }));
    }

    const text = `[fake:${vendor}] key=${key} model=${entry.model}`;

    if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors });
        const chunk = vendor === 'claude'
            ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
            : vendor === 'gemini'
                ? { candidates: [{ content: { parts: [{ text }], role: 'model' }, index: 0 }] }
                : { id: 'chatcmpl-fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(replyFor(vendor, text)));
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`fake-api listening on http://127.0.0.1:${PORT}`);
});
