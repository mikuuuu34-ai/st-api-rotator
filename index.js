/**
 * st-api-rotator — 入口
 *
 * 为 SillyTavern 提供多 API / 多 key 轮询，支持嵌套（某个 API 内部再轮 key）、
 * 每个端点独立模型，并保证「一条消息 = 一次请求 = 一个 key」。
 *
 * 只接管主聊天生成；其他插件（总结/翻译/向量化等）走 ChatCompletionService
 * 自己的 fetch，不经过本插件的任何钩子，因此完全不受影响。
 */

import { getSettings, installHooks, initLog } from './engine.js';
import { initUi } from './ui.js';

// 必须在模块加载时同步挂上 globalThis.apiRotatorInterceptor，
// 否则 manifest.generate_interceptor 查不到函数（extensions.js:2025）。
installHooks();

jQuery(async () => {
    try {
        getSettings();
        initLog();      // 要在 settings.json 读回来之后，否则拿到的还是默认值
        await initUi();
        console.log('[api-rotator] 已加载');
    } catch (err) {
        console.error('[api-rotator] 初始化失败', err);
    }
});
