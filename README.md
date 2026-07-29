# API 轮询 (st-api-rotator)

SillyTavern 扩展。多 API + 多 key 轮询，支持嵌套、每个端点独立模型，**保证一条消息对应一次请求对应一个 key**。

适配 **SillyTavern 1.18.0**。

---

## 它解决什么

- 一个 API 有多个 key → 每条消息轮换一个 key，不会全挤在同一个 key 上被限流
- 有多个 API 中转站 → 按端点轮换
- 两者嵌套 → 多 API 轮询中的某个 API，内部再轮它自己的多个 key
- 每个端点可以配不同的模型（A 站用 gpt-4o、B 站用 claude、C 站用 gemini 都行）
- 某个 key 挂了 → 可选自动换下一个重试，或直接报错（开关可切）

## 安装

扩展面板 → **Install Extension** → 粘贴本仓库的 Git URL。

宿主机需要装有 `git`。装完刷新页面，扩展设置里会出现「API 轮询」抽屉。

## 配置

1. 打开「启用轮询」
2. 「新增」一个端点，填：
   - **类型**：OpenAI 兼容 / Claude / Gemini
   - **接口地址**：基址，**不要带 `/chat/completions`**
     - OpenAI 兼容 → `https://your-proxy.com/v1`
     - Claude → `https://api.anthropic.com/v1`
     - Gemini → `https://generativelanguage.googleapis.com`
   - **密钥**：在文本框里每行粘一个 key，点「添加这些 key」（自动去重）
   - **模型**：**必填**。可以直接手输入，也可以点「加载」从该端点拉取真实可用的
     模型列表，然后在输入框下拉选择
3. 需要多个 API 就重复第 2 步

端点默认**收起**，只显示一行「名称 + 类型 · 模型 + key 可用数」，点左侧箭头展开。
右上角的双箭头按钮可以一键全部展开/收起。配置不完整的端点会在徽标上直接标出
缺什么（缺接口地址 / 缺模型 / 没有可用 key），并且不会被轮询选中。

### 关于「加载」模型

走的是酒馆的 `/api/backends/chat-completions/status`，用同一套
`reverse_proxy` + `proxy_password` 覆盖，所以不需要把 key 存进酒馆，也没有浏览器
跨域问题。

- **OpenAI 兼容 / Gemini**：直接拉该端点真实返回的列表（中转站的自定义模型名靠这个）
- **Claude**：酒馆的这个接口不支持 claude 源，插件会退化成 OpenAI 形状去探测同一个
  基址（多数 Claude 中转站也提供 `/v1/models`）。官方 `api.anthropic.com` 不认
  Bearer 认证，探测会失败 —— 此时自动回落到**酒馆内置的 Claude 模型列表**，并在
  提示里说明原因。

无论哪种情况，**模型名都可以手输入**，不受列表限制。

**轮询方式**
- `嵌套`：先在端点之间轮，再在选中端点内部轮它的 key
- `展平`：把所有 (端点, key) 组合平铺，依次轮完

**失败处理**
- `自动换下一个重试`：失败的 key 进入冷却期，自动换一个继续，可设最大重试次数
- `直接报错`：严格一条消息一个 key，失败就报错不重试

## 只接管主聊天

本插件**只接管主聊天生成**。总结、翻译、向量化等其他插件发出的请求走的是酒馆自身的 API 设置，不受影响、也不消耗轮询池。

这不是靠白名单实现的，而是结构上的隔离：其他插件走 `ChatCompletionService.sendRequest`
（`public/scripts/custom-request.js:462`）自己发 fetch，不经过本插件用的两个钩子。

如果你希望后台请求也走轮询池，打开「同时接管后台请求」。

## 工作原理

两阶段注入：

```
阶段 1  generate_interceptor（生成开始前）
        选出本次的 (端点, key, 模型)，改写全局 oai_settings
        ↓  必须在这里改，因为酒馆解析回复时读的是全局设置而非请求体
阶段 2  CHAT_COMPLETION_SETTINGS_READY（请求发出前）
        把 reverse_proxy / proxy_password / model 写进请求体
        ↓
      fetch → 酒馆后端 → 目标 API
        ↑ 失败时由受限作用域的 fetch 包装器换 key 重发
收尾   GENERATION_ENDED → 还原全局设置
```

关键依据（均已读源码 + 实测确认）：

| 事实 | 位置 |
|---|---|
| `generate_interceptor` 从 `globalThis` 取函数 | `public/scripts/extensions.js:2015` |
| 事件 emit 后对同一对象 stringify，改写生效 | `public/scripts/openai.js:3052` |
| 回复解析回落到**全局** `chat_completion_source` | `public/scripts/openai.js:3129` |
| `reverse_proxy` 决定 URL、`proxy_password` 决定 key | `src/endpoints/backends/chat-completions.js:214 / 442 / 1745` |

## 已知限制

1. **不支持 OpenAI Responses API** —— 酒馆本身没有这个源，后端固定拼 `{url}/chat/completions`。
2. **流式输出中途失败无法重试**。已经开始吐 token 后再失败只能如实报错；请求发出前的失败（429/5xx/超时）可以正常重试。
3. **重试选中的不一定是"下一个"key**。轮询游标单调递增，首次选择时已推进过，重试可能跳过一个。全局轮询依然公平，被跳过的 key 会在后续消息中被选到。
4. **跨厂商重试时厂商专有参数可能不完全匹配**。默认开启「重试时优先选同类型端点」来规避；同类型用尽才会跨厂商。
5. **跨厂商轮询期间全局 `oai_settings.chat_completion_source` 会被临时改写**，生成结束还原。若在生成过程中强制刷新页面，理论上可能残留（已加 `beforeunload` 兜底，非 100%）。
6. 依赖的都不是酒馆的稳定公开 API，**大版本升级后需要回归测试**（跑 `test/` 下的脚本即可）。

## 安全提示

**key 以明文存在酒馆的 `settings.json` 里**（这是配置时选定的存储方式）。这意味着：

- 任何其他扩展都能读到这些 key
- 导出的配置文件包含明文 key，注意保管
- 不要把 `settings.json` 或导出的配置提交到公开仓库

如果这不可接受，酒馆 1.18 自带的密钥库（`/api/secrets` + 请求级 `secret_id`）是更安全的替代方案，但需要改动本插件的存储层。

## 测试

```bash
# 1. 纯逻辑单测，不需要跑酒馆
node test/selector-test.js

# 2. 后端机制验证，需要酒馆 + 假 API 服务在跑
node test/fake-api.js 8317 &
node test/backend-test.js

# 3. 浏览器端到端，另需 chromium + puppeteer-core
node test/e2e-test.js
node test/ui-test.js
```

浏览器测试需要 `puppeteer-core`。若它不在常规解析路径下，用
`PUPPETEER_PATH=/abs/path/to/puppeteer-core.js` 指定；浏览器路径用 `CHROME_PATH`。

`test/fake-api.js` 是一个假的多厂商 API 服务，会记录收到的每个请求（路径 / key / model），
并可通过 `POST /__fail` 让指定 key 返回 429，用于验证失败切换。

当前状态：**selector 22/22，后端集成 16/16，浏览器端到端 25/25，UI 交互 32/32**。
其中端到端测试会真的调用酒馆自己的 `runGenerationInterceptors()` 与真实 `eventSource`，
并断言连发 6 条消息时假 API 收到的 key 序列为 `1,2,3,1,2,3`。

端到端测试**不覆盖**酒馆的提示词组装流程（`Generate()` 内部）：无头浏览器环境下酒馆的
`settingsReady` 不置位会导致 `Generate()` 卡住，该现象在卸载本插件后依然复现，属于测试
环境问题。`Generate()` 会调用上述两个钩子这一点已通过读源码确认（`public/script.js:4505`、
`public/scripts/openai.js:3052`）。

## 版本与更新

`manifest.json` 里的 `version` **只是显示用的**（酒馆只在扩展列表里把它渲染成一行字，
见 `public/scripts/extensions.js:918`），没有任何比较逻辑。

酒馆判断"有没有更新"靠的是 **git commit**：`/api/extensions/version` 会
`git fetch origin` 然后比较 `HEAD` 与 `origin/<branch>` 的差异
（`src/endpoints/extensions.js:41` 的 `checkIfRepoIsUpToDate`）。

所以：

- 安装 = `git clone`，更新 = `git pull`
- 想发布新版本，**正常 push commit 就行**，用户点更新按钮即可拿到
- `auto_update: true` 会让酒馆在启动时自动拉取更新；当前设为 `false`，需要手动点更新
- **不要删库重建、也不要 force push** —— 已经装过的用户执行 `git pull` 会因为历史
  分叉而失败，只能卸载重装

## 许可

AGPL-3.0，与 SillyTavern 一致。
