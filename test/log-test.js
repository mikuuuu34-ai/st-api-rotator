#!/usr/bin/env node
/**
 * 日志缓冲单元测试。
 *
 * 这里验证三件事：
 *   1. 环形缓冲的上限行为 —— 默认留 1000 条，面板只取最近 100 条
 *   2. 「日志不记录消息内容」这条硬约束确实拦得住
 *   3. 序列化往返不丢东西，尤其是序号和批次号必须接着往上走
 *
 * log.js 不依赖 SillyTavern，可以直接在 Node 里跑。
 * 用法：node test/log-test.js
 */

import {
    createLogStore, sanitizeDetail, clampMax, passes,
    PANEL_MAX, DEFAULT_MAX, LOG_EVENTS, eventLabel, formatEntry, fmtStamp,
} from '../log.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    check(name, a === e, `期望 ${e}\n       实际 ${a}`);
}

/** 固定时钟，让断言可复现 */
function fixedClock(start = 1_700_000_000_000) {
    let t = start;
    return () => (t += 1000);
}

console.log('=== 日志缓冲单元测试 ===\n');

console.log('[1] 默认上限与面板上限');
{
    eq('保留上限默认 1000 条', DEFAULT_MAX, 1000);
    eq('面板只显示 100 条', PANEL_MAX, 100);
    const s = createLogStore();
    eq('新建缓冲的上限就是 1000', s.max, 1000);
}

console.log('\n[2] 环形缓冲：超出上限丢最早的');
{
    // 上限有下界保护（clampMax 最低 10），所以这里用 10 而不是更小的数
    const s = createLogStore({ max: 10, now: fixedClock() });
    for (let i = 1; i <= 25; i++) s.push('pick', 1, `第 ${i} 条`);
    eq('只留最后 10 条', s.size, 10);
    eq('留下的是最新的 10 条', s.all().map(e => e.msg),
        ['第 16 条', '第 17 条', '第 18 条', '第 19 条', '第 20 条',
            '第 21 条', '第 22 条', '第 23 条', '第 24 条', '第 25 条']);
    eq('id 是连续递增的（没被重排）', s.all().map(e => e.id),
        [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
}

console.log('\n[3] 调小上限会立即裁掉超出的部分');
{
    const s = createLogStore({ max: 100, now: fixedClock() });
    for (let i = 0; i < 100; i++) s.push('pick', 1, `#${i}`);
    eq('先攒满 100 条', s.size, 100);
    s.setMax(10);
    eq('调到 10 之后只剩 10 条', s.size, 10);
    eq('剩下的是最新的', s.all()[0].msg, '#90');

    eq('上限有下界保护', createLogStore({ max: 0 }).max, clampMax(0));
    eq('下界是 10', clampMax(-5), 10);
    eq('上界是 20000', clampMax(999999), 20000);
    eq('非法值回落到默认', clampMax('abc'), DEFAULT_MAX);
}

console.log('\n[4] 面板取数：最新在前，最多 100 条');
{
    const s = createLogStore({ max: 1000, now: fixedClock() });
    for (let i = 1; i <= 300; i++) s.push('pick', i, `#${i}`);
    const rows = s.recent(PANEL_MAX);
    eq('只给 100 条', rows.length, 100);
    eq('第一条是最新的', rows[0].msg, '#300');
    eq('最后一条是第 201 条', rows[99].msg, '#201');
    eq('缓冲里仍然完整保留 300 条（导出能看到全部）', s.size, 300);
}

console.log('\n[5] 级别筛选：只看警告和错误');
{
    const s = createLogStore({ now: fixedClock() });
    s.push('pick', 1, '选中 A');           // info
    s.push('concurrent', 2, '并发了');      // warn
    s.push('ok', 1, '成功');               // info
    s.push('crosstalk', 2, '串台了');       // error
    s.push('bypass', 3, '没走轮询');        // warn

    eq('全部 5 条', s.count('all'), 5);
    eq('警告与错误 3 条', s.count('warn'), 3);
    eq('筛出来的正是诊断用的那几条', s.all('warn').map(e => e.ev),
        ['concurrent', 'crosstalk', 'bypass']);
    check('passes 对 info 在 warn 筛选下返回 false',
        passes({ level: 'info' }, 'warn') === false);
    check('passes 在 all 下全放行', passes({ level: 'debug' }, 'all') === true);
}

console.log('\n[6] 详细模式：debug 级事件默认不落库');
{
    const s = createLogStore({ now: fixedClock() });
    eq('apply 事件的默认级别是 debug', LOG_EVENTS.apply.level, 'debug');

    s.push('apply', 1, '改写全局设置');
    eq('非详细模式下 debug 不记', s.size, 0);

    s.setVerbose(true);
    s.push('apply', 1, '改写全局设置');
    eq('打开详细模式后开始记', s.size, 1);

    s.setVerbose(false);
    s.push('apply', 1, '又改了一次');
    eq('关掉之后又不记了', s.size, 1);
}

console.log('\n[7] 关掉记录开关后不再落库');
{
    const s = createLogStore({ now: fixedClock() });
    s.push('pick', 1, '记一条');
    s.setEnabled(false);
    s.push('pick', 1, '这条不该有');
    s.push('crosstalk', 1, '这条也不该有');
    eq('关掉后一条都不进', s.size, 1);
    s.setEnabled(true);
    s.push('pick', 1, '又能记了');
    eq('打开后恢复', s.size, 2);
}

console.log('\n[8] 生成批次号单调递增');
{
    const s = createLogStore({ now: fixedClock() });
    eq('从 1 开始', s.nextGen(), 1);
    eq('依次递增', [s.nextGen(), s.nextGen()], [2, 3]);
    eq('currentGen 跟得上', s.currentGen, 3);
}

console.log('\n[9] 硬约束：日志里不能出现消息内容');
{
    // 调用方本来只传元信息，这是防止后续改动不小心把整个请求体塞进来的兜底
    const d = sanitizeDetail({
        endpoint: 'A',
        messages: [{ role: 'user', content: '我的隐私聊天内容' }],
        prompt: '系统提示词',
        content: '正文',
        text: '正文',
        history: ['a', 'b'],
        model: 'gpt-4o',
    });
    eq('元信息保留', { endpoint: d.endpoint, model: d.model }, { endpoint: 'A', model: 'gpt-4o' });
    check('messages 被丢弃', !('messages' in d));
    check('prompt 被丢弃', !('prompt' in d));
    check('content 被丢弃', !('content' in d));
    check('text 被丢弃', !('text' in d));
    check('history 被丢弃', !('history' in d));

    const long = sanitizeDetail({ message: 'x'.repeat(500) });
    check('超长字符串被截断', long.message.length <= 201, `实际 ${long.message.length}`);

    const nested = sanitizeDetail({ extra: { a: 1, b: [2, 3] } });
    check('嵌套对象被拍平成字符串', typeof nested.extra === 'string', JSON.stringify(nested));

    eq('空 detail 返回 undefined', sanitizeDetail({}), undefined);
    eq('null 返回 undefined', sanitizeDetail(null), undefined);

    // 走完整链路再确认一次
    const s = createLogStore({ now: fixedClock() });
    s.push('send', 1, '请求带出 A / sk-a…bcd / gpt-4o', { messages: ['绝密'], key: 'sk-a…bcd' });
    check('落库的条目里搜不到消息内容', !JSON.stringify(s.all()).includes('绝密'), JSON.stringify(s.all()));
    check('掩码后的 key 正常保留', JSON.stringify(s.all()).includes('sk-a…bcd'));
}

console.log('\n[10] 序列化往返');
{
    const s = createLogStore({ max: 50, now: fixedClock() });
    s.nextGen(); s.nextGen(); s.nextGen();
    s.push('pick', 3, '选中 A', { endpoint: 'A', key: 'sk-x…yz' });
    s.push('ok', 3, '成功');
    const raw = s.serialize();

    const s2 = createLogStore({ max: 50, now: fixedClock() });
    check('hydrate 返回 true', s2.hydrate(raw) === true);
    eq('条目数一致', s2.size, 2);
    eq('内容一致', s2.all().map(e => [e.ev, e.gen, e.msg]),
        [['pick', 3, '选中 A'], ['ok', 3, '成功']]);
    eq('detail 一致', s2.all()[0].d, { endpoint: 'A', key: 'sk-x…yz' });

    // 序号和批次号必须接着走，否则刷新后新旧条目编号会撞在一起
    eq('批次号接着往上走', s2.nextGen(), 4);
    s2.push('pick', 4, '新的一条');
    eq('条目 id 接着往上走', s2.all().at(-1).id, 3);
}

console.log('\n[11] hydrate 容错');
{
    const s = createLogStore();
    check('空值返回 false', s.hydrate(null) === false);
    check('坏 JSON 返回 false', s.hydrate('{不是 json') === false);
    check('结构不对返回 false', s.hydrate('{"v":1}') === false);
    check('坏数据没把缓冲搞崩', s.size === 0);

    // 缺字段的条目被过滤掉，好的留下
    const ok = s.hydrate(JSON.stringify({
        v: 1, seq: 9, gen: 2,
        entries: [
            { id: 1, t: 123, ev: 'pick', level: 'info', msg: '好的' },
            { id: 2, ev: 'pick' },                      // 缺 t
            { nonsense: true },                          // 完全不对
            { id: 4, t: 456, ev: 'ok', level: '外星级别', msg: '级别不认识' },
        ],
    }));
    check('返回 true', ok === true);
    eq('只留下结构完整的 2 条', s.size, 2);
    eq('不认识的级别回落到 info', s.all()[1].level, 'info');

    // 存的比上限多时要裁掉
    const small = createLogStore({ max: 10 });
    small.hydrate(JSON.stringify({
        v: 1, seq: 25, gen: 1,
        entries: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, t: i, ev: 'pick', level: 'info', msg: `#${i}` })),
    }));
    eq('按当前上限裁到 10 条', small.size, 10);
    eq('留的是最新的', small.all().map(e => e.msg).slice(0, 3), ['#15', '#16', '#17']);
}

console.log('\n[12] 导出文本');
{
    const s = createLogStore({ now: fixedClock() });
    s.push('pick', 1, '选中 端点A / sk-a…bcd / gpt-4o', { endpoint: '端点A', mode: 'nested' });
    s.push('crosstalk', 2, '两次生成串台');
    const txt = s.toText('all', { 端点数: 3 });

    check('有文件头', txt.includes('# st-api-rotator 运行日志'));
    check('写明了不含消息内容', txt.includes('不含任何消息内容'));
    check('带上了调用方给的元信息', txt.includes('# 端点数：3'));
    check('正文里有批次号', txt.includes('#1') && txt.includes('#2'));
    check('细节以 ↳ 单起一行', txt.includes('↳'));
    check('时间是可读的本地时间', txt.includes(fmtStamp(1_700_000_001_000).slice(0, 10)));

    const warnOnly = s.toText('warn');
    check('筛选导出只含警告与错误', !warnOnly.includes('选中 端点A') && warnOnly.includes('串台'));

    // 单条格式
    const line = formatEntry({ id: 1, t: 1_700_000_000_000, gen: 7, ev: 'pick', level: 'info', msg: '选中' });
    check('单条含批次号和级别', line.includes('#7') && line.includes('INFO'), line);
    eq('事件有中文标签', eventLabel('crosstalk'), '串台');
    eq('未知事件回落到原名', eventLabel('不存在的事件'), '不存在的事件');
}

console.log('\n[13] 诊断场景：并发串台在日志里能被一眼筛出来');
{
    // 复现用户报告的现象：两次生成重叠，后一次覆盖了前一次的选择，
    // 结果两个请求都打到了端点 1。
    const s = createLogStore({ now: fixedClock() });
    const g1 = s.nextGen();
    s.push('hook', g1, '拦截器被调用（类型 normal）');
    s.push('pick', g1, '选中 端点1 / sk-a…001 / gpt-4o');
    const g2 = s.nextGen();
    s.push('concurrent', g2, `上一次生成 #${g1} 还没结束就开始了本次 #${g2}`);
    s.push('pick', g2, '选中 端点2 / sk-b…002 / gpt-4o');
    s.push('crosstalk', g1, `本请求绑定的是批次 #${g1}，发出时全局却已切到 #${g2}`);
    s.push('send', g2, '请求带出 端点2 / sk-b…002 / gpt-4o');

    const flagged = s.all('warn');
    eq('筛「警告与错误」正好留下并发与串台两条', flagged.map(e => e.ev), ['concurrent', 'crosstalk']);
    check('串台那条指明了两个批次号',
        flagged[1].msg.includes(`#${g1}`) && flagged[1].msg.includes(`#${g2}`), flagged[1].msg);
    eq('两次生成的条目靠批次号区分得开',
        [s.all().filter(e => e.gen === g1).length, s.all().filter(e => e.gen === g2).length], [3, 3]);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
