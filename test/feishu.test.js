/* services/feishu.js + services/feishu-bridge.js — 加签 / 卡片 / token 缓存 / 发消息 / 拉群消息 / 指令解析 / 协议适配
   全部离线：fetch 用注入的假实现，网络调用与真实抓包解耦 */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const feishu = require('../services/feishu');
const { createFeishuBridge, isFeishuHook, webhookToFeishu } = require('../services/feishu-bridge');
const { validateSchedule, normalizeOut, OUT_TARGETS } = require('../services/scheduler');
const secureKeys = require('../services/secure-keys');

/* 假 Response：只实现 feishu.js 用到的 status/ok/json */
const res = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (typeof body === 'string') { try { return JSON.parse(body); } catch (e) { return null; } }
    return body;
  },
});

/* 假 fetch：按 url 路由到处理表，记录调用（含 body 解析） */
function mkFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const body = init && init.body ? (() => { try { return JSON.parse(init.body); } catch (e) { return init.body; } })() : null;
    calls.push({ url: String(url), init: init || {}, body });
    for (const r of routes) if (r.match(String(url), init || {})) return r.reply(body, String(url), init || {});
    return res(404, { code: 99999, msg: 'no route: ' + url });
  };
  impl.calls = calls;
  return impl;
}

const TOKEN_OK = {
  match: u => u.includes('/auth/v3/tenant_access_token/internal'),
  reply: () => res(200, { code: 0, msg: 'ok', tenant_access_token: 't-abc', expire: 7200 }),
};
const SEND_OK = {
  match: u => u.includes('/im/v1/messages?receive_id_type=chat_id'),
  reply: () => res(200, { code: 0, data: { message_id: 'om_1' } }),
};

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* ---------- 1. 加签 ---------- */
  {
    const ts = 1700000000;
    const sig = feishu.signWebhook('s3cret', ts, '');
    const expect = crypto.createHmac('sha256', ts + '\ns3cret').update('').digest('base64');
    ok(sig === expect, '加签 = HMAC-SHA256(key=timestamp\\nsecret, data=空串) 的 base64');

    /* 带 secret：body 里注入 timestamp 与 sign，且 sign 覆盖的是「去掉 sign 之前」的完整报文 */
    const body = { msg_type: 'interactive', card: { x: 1 } };
    const signed = feishu.buildWebhookBody(body, { secret: 's3cret' }, ts * 1000);
    ok(String(signed.timestamp) === String(ts), 'timestamp 为秒级字符串');
    ok(typeof signed.sign === 'string' && signed.sign.length > 20, 'sign 已写入');
    const { sign, ...rest } = signed;
    ok(sign === feishu.signWebhook('s3cret', signed.timestamp, JSON.stringify(rest)), 'sign 基于含 timestamp 的完整报文');
    ok(!body.sign && !body.timestamp, '不修改入参对象（纯函数）');

    /* 无 secret：原样返回，不带签名字段 */
    const plain = feishu.buildWebhookBody(body, {}, ts * 1000);
    ok(!plain.sign && !plain.timestamp, '未配置密钥时不加签');
  }

  /* ---------- 2. 卡片结构 ---------- */
  {
    const c = feishu.card({ title: 'T', theme: 'green', elements: [feishu.mdText('hi')], url: 'https://x.y/z' });
    ok(c.header.template === 'green' && c.header.title.content === 'T', '卡片 header 标题与主题色');
    ok(c.elements[0].text.tag === 'lark_md', '正文走 lark_md');
    ok(c.elements[c.elements.length - 1].tag === 'action', '带 url 时追加跳转按钮');
    const noAction = feishu.card({ title: 'x', elements: [] });
    ok(!noAction.elements.some(e => e.tag === 'action'), '无 url 时不放按钮');
    ok(feishu.card({ title: 'x', theme: 'not-a-color' }).header.template === 'blue', '非法主题色回落 blue');

    const lng = feishu.textCard('报告', 'A'.repeat(5000), {});
    const bodyText = lng.elements.find(e => e.text && e.text.tag === 'lark_md').text.content;
    ok(bodyText.length < 3400 && bodyText.includes('已截断'), '超长报告按上限截断并标注');
    const md = feishu.textCard('报告', '# 标题\n\n正文', {}).elements.find(e => e.text && e.text.tag === 'lark_md').text.content;
    ok(md.includes('**标题**') && !md.includes('# 标题'), 'markdown 标题降级为加粗（lark_md 不渲染 #）');
  }

  /* 任务卡：事件元信息映射到主题色与关键字段 */
  {
    const task = { key: 'REINS-7', title: '登录改版', status: 'review', pri: 'P0', pr: '交付 #3', assignee: { name: '小 R' } };
    ok(feishu.taskCard('done', task, {}).header.template === 'green', 'done 绿色');
    ok(feishu.taskCard('failed', task, {}).header.template === 'red', 'failed 红色');
    ok(feishu.taskCard('rejected', task, {}).header.template === 'orange', 'rejected 橙色');
    const els = feishu.taskCard('done', task, { space: '我的空间' }).elements;
    const joined = JSON.stringify(els);
    ok(joined.includes('REINS-7') && joined.includes('登录改版') && joined.includes('小 R'), '任务号/标题/经办都进卡片');
    ok(feishu.taskCard('done', task, { space: 'S' }).header.title.content.includes('S'), '标题带空间名');
    ok(feishu.taskCard('done', { key: 'K' }, {}).elements.length >= 1, '缺字段不抛错（任务对象可稀疏）');
  }

  /* ---------- 3. tenant_access_token 缓存 ---------- */
  {
    feishu.clearAllTokens();
    let now = 1700000000000;
    const f = mkFetch([TOKEN_OK, SEND_OK]);
    const cfg = { appId: 'cli_1', appSecret: 'sec', chatId: 'oc_1', baseUrl: 'https://open.feishu.cn' };
    await feishu.sendMessage(cfg, { content: {}, fetchImpl: f, now: () => now });
    ok(f.calls.filter(c => c.url.includes('tenant_access_token')).length === 1, '首次取 token');
    await feishu.sendMessage(cfg, { content: {}, fetchImpl: f, now: () => now });
    ok(f.calls.filter(c => c.url.includes('tenant_access_token')).length === 1, '缓存期内复用 token');

    now += 7200 * 1000 - 6 * 60 * 1000;   // 进入 5 分钟安全窗之前
    await feishu.sendMessage(cfg, { content: {}, fetchImpl: f, now: () => now });
    ok(f.calls.filter(c => c.url.includes('tenant_access_token')).length === 1, '安全窗内仍复用');
    now += 2 * 60 * 1000;                 // 进入 5 分钟安全窗
    await feishu.sendMessage(cfg, { content: {}, fetchImpl: f, now: () => now });
    ok(f.calls.filter(c => c.url.includes('tenant_access_token')).length === 2, '临期前 5 分钟重新取 token');

    /* 不同 appId / 不同域名各持独立缓存 */
    await feishu.sendMessage({ ...cfg, appId: 'cli_2' }, { content: {}, fetchImpl: f, now: () => now });
    ok(f.calls.filter(c => c.url.includes('tenant_access_token')).length === 3, '不同 appId 不复用 token');
    ok(f.calls.some(c => c.url === 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id'), '请求打到正确路径');
    feishu.clearAllTokens();
  }

  /* token 失效（99991663）→ 清缓存重试一次成功 */
  {
    feishu.clearAllTokens();
    let tokenCalls = 0, sendCalls = 0;
    const f = mkFetch([
      { match: u => u.includes('tenant_access_token'), reply: () => { tokenCalls++; return res(200, { code: 0, tenant_access_token: 't-' + tokenCalls, expire: 7200 }); } },
      {
        match: u => u.includes('/im/v1/messages'),
        reply: () => { sendCalls++; return sendCalls === 1 ? res(400, { code: 99991663, msg: 'token invalid' }) : res(200, { code: 0, data: { message_id: 'om_ok' } }); },
      },
    ]);
    const r = await feishu.sendMessage({ appId: 'a', appSecret: 'b', chatId: 'oc' }, { content: {}, fetchImpl: f });
    ok(r.message_id === 'om_ok' && tokenCalls === 2, 'token 失效自动换新并重试成功');

    /* 权限类错误不重试（避免无意义请求把自己打到限流） */
    feishu.clearAllTokens();
    let sends = 0;
    const f2 = mkFetch([
      TOKEN_OK,
      { match: u => u.includes('/im/v1/messages'), reply: () => { sends++; return res(400, { code: 230002, msg: 'bot not in chat' }); } },
    ]);
    let threw = null;
    try { await feishu.sendMessage({ appId: 'a', appSecret: 'b', chatId: 'oc' }, { content: {}, fetchImpl: f2 }); } catch (e) { threw = e; }
    ok(threw && threw.feishuCode === 230002 && sends === 1, '权限错误不重试且抛出带 code 的错误');
    ok(/发送群消息/.test(threw.message) && /bot not in chat/.test(threw.message), '错误信息保留原始 msg，便于排查');
    feishu.clearAllTokens();
  }

  /* 缺配置时给出可操作的中文提示 */
  {
    let e1 = null;
    try { await feishu.getToken({ appId: '', appSecret: '' }, {}); } catch (e) { e1 = e; }
    ok(e1 && /App ID/.test(e1.message), '缺 App ID/Secret 时提示明确');
    let e2 = null;
    try { await feishu.sendMessage({ appId: 'a', appSecret: 'b' }, { content: {}, fetchImpl: mkFetch([]) }); } catch (e) { e2 = e; }
    ok(e2 && /chat_id/.test(e2.message), '缺 chat_id 时提示明确');
  }

  /* ---------- 4. 群机器人：加签重试 / 地址校验 ---------- */
  {
    let bodies = [];
    const f = mkFetch([{
      match: u => u.includes('/bot/v2/hook/'),
      reply: body => { bodies.push(body); return bodies.length === 1 ? res(400, { code: 19021, msg: 'sign match fail' }) : res(200, { code: 0, data: {} }); },
    }]);
    const r = await feishu.sendWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
      { msg_type: 'interactive', card: { a: 1 } }, { secret: 's' }, { fetchImpl: f, now: () => 1700000000000 });
    ok(r.ok && r.signed === false, '签名失败时退回不加签重试成功');
    ok(bodies.length === 2 && bodies[0].sign && !bodies[1].sign, '第一次带 sign、第二次裸发');
    ok(/未加签/.test(r.note || ''), '重试成功会标注签名未通过');

    let e = null;
    try { await feishu.sendWebhook('ftp://x', {}, {}, { fetchImpl: mkFetch([]) }); } catch (err) { e = err; }
    ok(e && /http/.test(e.message), '非 http(s) 地址直接拒绝');
  }

  /* ---------- 5. 消息正文解析与指令识别 ---------- */
  {
    const textMsg = { msg_type: 'text', body: { content: JSON.stringify({ text: '/reins status' }) } };
    ok(feishu.messageText(textMsg) === '/reins status', 'text 正文解析');
    const postMsg = { msg_type: 'post', body: { content: JSON.stringify({ title: '', content: [[{ tag: 'text', text: '/reins new 改版' }]] }) } };
    ok(/\/reins new 改版/.test(feishu.messageText(postMsg)), 'post 富文本拼接');
    ok(feishu.messageText({ msg_type: 'text', body: { content: 'not json' } }) === '', '坏正文不抛错');
    ok(feishu.messageText(null) === '', '空消息返回空串');

    ok(feishu.parseCommand('/reins status').cmd === 'status', '识别 /reins status');
    ok(feishu.parseCommand('/reins new 登录改版 | 加验证码').arg === '登录改版 | 加验证码', 'new 保留完整参数');
    ok(feishu.parseCommand('/reins').cmd === 'help', '裸 /reins 给帮助');
    ok(feishu.parseCommand('/reins 帮助').cmd === 'help', '中文别名');
    ok(feishu.parseCommand('/REINS LIST').cmd === 'list', '大小写不敏感');
    ok(feishu.parseCommand('/reins new 新建')?.cmd === 'new' && feishu.parseCommand('/reins 新建 任务').cmd === 'new', '中文命令 new/新建');
    ok(feishu.parseCommand('/reins 未知指令').cmd === 'unknown', '未知子命令标记 unknown');
    ok(feishu.parseCommand('今天天气不错') === null, '普通聊天不触发');
    ok(feishu.parseCommand('@reins status').cmd === 'status', '@ 前缀也可');

    /* 审批指令（P2）：卡片按钮需要公网回调，改用同一条拉取通道承载审批动作 */
    {
      const a1 = feishu.parseCommand('/reins approve REINS-42');
      ok(a1.cmd === 'approve' && a1.taskKey === 'REINS-42', 'approve 解析出任务号');
      const r1 = feishu.parseCommand('/reins reject reins-42 第二部分缺少来源');
      ok(r1.cmd === 'reject' && r1.taskKey === 'REINS-42' && /第二部分缺少来源/.test(r1.reason), 'reject 解析任务号 + 原因');
      const r2 = feishu.parseCommand('/reins 打回 42');
      ok(r2.cmd === 'reject' && r2.taskKey === 'REINS-42', '裸数字补全 REINS 前缀');
      const r3 = feishu.parseCommand('/reins reject REINS-7');
      ok(r3.cmd === 'reject' && r3.taskKey === 'REINS-7' && r3.reason === '', '不带原因也合法');
      const v1 = feishu.parseCommand('/reins revoke REINS-9');
      ok(v1.cmd === 'revoke' && v1.taskKey === 'REINS-9', 'revoke 解析');
      const a2 = feishu.parseCommand('/reins approve');
      ok(a2.cmd === 'approve' && a2.taskKey === '', '缺任务号时留空（由渲染层给出用法提示）');
      ok(feishu.parseCommand('/reins 通过 REINS-1').cmd === 'approve', '中文别名 通过');
      ok(feishu.parseCommand('/reins 验收 REINS-1').taskKey === 'REINS-1', '中文别名 验收');

      /* 回执卡片：成功/失败两种主题，失败带用法提示 */
      const okCard = feishu.replyCard('approve', { ok: true, task: { key: 'REINS-42', title: 'T' } });
      ok(okCard.header.template === 'green' && /验收通过/.test(okCard.header.title.content), '审批成功卡片为绿色');
      const rejCard = feishu.replyCard('reject', { ok: true, task: { key: 'REINS-1', title: 'T' }, reason: '缺来源' });
      ok(rejCard.header.template === 'orange' && JSON.stringify(rejCard).includes('缺来源'), '打回卡片带原因');
      const badCard = feishu.replyCard('approve', { ok: false, error: '找不到任务' });
      ok(badCard.header.template === 'red' && JSON.stringify(badCard).includes('/reins approve'), '失败卡片给出用法');
      const rvCard = feishu.replyCard('revoke', { ok: true, task: { key: 'REINS-3', title: 'T' } });
      ok(rvCard.header.template === 'grey', '撤回卡片为灰色（低强调）');
    }

    ok(feishu.isHumanTextMessage(textMsg), '人发的文本消息可处理');
    ok(!feishu.isHumanTextMessage({ ...textMsg, sender: { sender_type: 'app' } }), '机器人自己发的消息跳过');
    ok(!feishu.isHumanTextMessage({ msg_type: 'interactive', body: { content: '{}' } }), '卡片消息不解析');
  }

  /* ---------- 6. 拉群消息 ---------- */
  {
    feishu.clearAllTokens();
    let seenUrl = '';
    const f = mkFetch([
      TOKEN_OK,
      {
        match: u => u.includes('container_id_type=chat'),
        reply: (b, url) => {
          seenUrl = url;
          return res(200, {
            code: 0, data: {
              items: [
                { message_id: 'om_1', create_time: '1700000001000', msg_type: 'text', sender: { sender_type: 'user' }, body: { content: JSON.stringify({ text: '/reins status' }) } },
                { message_id: 'om_2', create_time: '1700000003000', msg_type: 'text', sender: { sender_type: 'user' }, body: { content: JSON.stringify({ text: '闲聊' }) } },
              ],
            },
          });
        },
      },
    ]);
    const r = await feishu.fetchMessages({ appId: 'a', appSecret: 'b', chatId: 'oc_9' }, { startTime: 1700000000000, fetchImpl: f });
    ok(r.items.length === 2 && r.nextStart === 1700000003000, '返回消息与下一轮水位（取最新 create_time）');
    ok(seenUrl.includes('container_id_type=chat') && seenUrl.includes('container_id=oc_9'), '按群拉取');
    ok(seenUrl.includes('start_time=1700000000'), 'start_time 用秒级时间戳');
    ok(seenUrl.includes('sort_type=ByCreateTimeAsc'), '按时间正序，便于顺序执行指令');
  }

  /* ---------- 7. 出站统一入口：应用优先、机器人兜底 ---------- */
  {
    feishu.clearAllTokens();
    const card = feishu.card({ title: 'x', elements: [] });
    const withApp = await feishu.push(
      { appId: 'a', appSecret: 'b', chatId: 'oc', webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/y' },
      { card, fetchImpl: mkFetch([TOKEN_OK, SEND_OK]) }
    );
    ok(withApp.via === 'app' && withApp.messageId === 'om_1', '配了应用就走应用');

    const noApp = await feishu.push(
      { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/y' },
      { card, fetchImpl: mkFetch([{ match: u => u.includes('/bot/v2/hook/'), reply: () => res(200, { code: 0, data: {} }) }]) }
    );
    ok(noApp.via === 'webhook', '没配应用回落群机器人');

    let e = null;
    try { await feishu.push({}, { card, fetchImpl: mkFetch([]) }); } catch (err) { e = err; }
    ok(e && /未配置/.test(e.message), '两样都没配时提示明确');
  }

  /* ---------- 8. Webhook 地址协议适配 ---------- */
  {
    ok(isFeishuHook('https://open.feishu.cn/open-apis/bot/v2/hook/abc'), '飞书机器人地址识别');
    ok(isFeishuHook('https://open.larksuite.com/open-apis/bot/v2/hook/abc'), 'Lark 国际版识别');
    ok(!isFeishuHook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), '企微地址不改写');
    ok(!isFeishuHook('https://example.com/webhook'), '自建地址不改写');
    ok(!isFeishuHook(''), '空地址不识别');

    const taskCardMsg = webhookToFeishu({ event: 'task.created', space: 'S', task: { key: 'K-1', title: 't', status: 'todo', pri: 'P1' } });
    ok(taskCardMsg.header && taskCardMsg.elements, '任务事件转成卡片');
    ok(taskCardMsg.header.title.content.includes('新任务'), '按事件给中文标题');

    const report = webhookToFeishu({ event: 'report.weekly', space: 'S', report: '# 周报\n正文', schedule: '周五' });
    ok(JSON.stringify(report).includes('周报'), '报告事件转成文本卡片');

    const ping = webhookToFeishu({ event: 'ping', text: '测试', at: '2026-01-01T00:00:00Z' });
    ok(JSON.stringify(ping).includes('测试') && ping.header, '未知/测试事件兜底为通用卡片');
    ok(webhookToFeishu(null).header, '空 payload 也产出合法卡片（不抛错）');
  }

  /* ---------- 9. 桥：事件开关 / 队列 / 降级 / 状态 ---------- */
  {
    feishu.clearAllTokens();
    const settings = {
      value: {
        feishu: {
          enabled: true, appId: 'a', appSecret: 'b', chatId: 'oc_1', baseUrl: 'https://open.feishu.cn',
          webhookUrl: '', webhookSecret: '', events: { create: true, done: false, reject: true, fail: true },
          inbound: false, lastSyncAt: 0, lastError: '',
        },
      },
    };
    const patches = [];
    const saved = [];
    const bridge = createFeishuBridge({
      getSettings: () => settings.value,
      saveSettings: p => { patches.push(p); settings.value = { ...settings.value, feishu: { ...settings.value.feishu, ...(p.feishu || {}) } }; },
      runCommand: async () => ({ ok: true, space: 'S', doing: 1, todo: 2, review: 0, doneToday: 3 }),
      fetchImpl: null,
      log: () => { },
    });

    let r = await bridge.notify('done', { key: 'K-1', title: 't' }, {});
    ok(r.skipped && /关闭/.test(r.error), '逐事件开关生效（done 已关）');

    /* 推送需要真实 fetch：这里用假 fetch 走「未配置应用/机器人」以外的分支不现实，
       先验证「未启用」与「配置齐全但网络失败」两条降级路径 */
    settings.value.feishu.enabled = false;
    r = await bridge.notify('created', { key: 'K-2', title: 't' }, {});
    ok(r.skipped && /未开启/.test(r.error), '总开关关闭时跳过');

    settings.value.feishu.enabled = true;
    settings.value.feishu.appId = '';
    settings.value.feishu.webhookUrl = '';
    r = await bridge.notify('created', { key: 'K-3', title: 't' }, {});
    ok(r.skipped && /未配置/.test(r.error), '没配置应用也没配置机器人时跳过');

    /* 报告 / 测试同样不抛错（返回 ok:false 由调用方决定是否提示） */
    settings.value.feishu.appId = 'a';
    const st = bridge.status();
    ok(st.enabled === true && st.events.done === false, 'status 反映当前开关');
    ok(Array.isArray(st.recent), 'status 带推送历史');

    /* 入站未开启时空转，不报错 */
    const pr = await bridge.pollOnce();
    ok(pr.skipped && /未开启/.test(pr.error), '未开启群指令同步时 pollOnce 跳过');

    /* cfgOf 归一化：缺字段 / 坏类型都能给出安全默认值 */
    const cfg = bridge.cfgOf({ feishu: { inboundIntervalMs: 1, events: { done: false } } });
    ok(cfg.inboundIntervalMs === 15000, '轮询间隔取下限 15s');
    ok(cfg.events.done === false && cfg.events.create === true, '事件开关逐个合并默认值');
    ok(bridge.cfgOf({}).enabled === false, '无 feishu 字段时默认关闭');
    void patches; void saved;
  }

  /* ---------- 10. 桥：入站轮询 → 指令执行 → 水位推进（全离线） ---------- */
  {
    feishu.clearAllTokens();
    const state = { feishu: { enabled: true, appId: 'a', appSecret: 'b', chatId: 'oc_1', inbound: true, events: {}, lastSyncAt: 0, lastError: '' } };
    const executed = [];
    const replies = [];
    const f = mkFetch([
      TOKEN_OK,
      { match: u => u.includes('/im/v1/messages?receive_id_type=chat_id'), reply: (b) => { replies.push(b); return res(200, { code: 0, data: { message_id: 'om_r' + replies.length } }); } },
      {
        match: u => u.includes('container_id_type=chat'),
        reply: () => res(200, {
          code: 0, data: {
            items: [
              { message_id: 'om_a', create_time: '1700000005000', msg_type: 'text', sender: { sender_type: 'user' }, body: { content: JSON.stringify({ text: '/reins status' }) } },
              { message_id: 'om_b', create_time: '1700000006000', msg_type: 'text', sender: { sender_type: 'app' }, body: { content: JSON.stringify({ text: '/reins new 机器人自己' }) } },
              { message_id: 'om_c', create_time: '1700000007000', msg_type: 'text', sender: { sender_type: 'user' }, body: { content: JSON.stringify({ text: '/reins new 登录改版 | 加验证码' }) } },
            ],
          },
        }),
      },
    ]);
    const bridge = createFeishuBridge({
      getSettings: () => ({ feishu: state.feishu }),
      saveSettings: p => { state.feishu = { ...state.feishu, ...(p.feishu || {}) }; },
      runCommand: async cmd => { executed.push(cmd); return cmd.cmd === 'new' ? { ok: true, task: { key: 'REINS-9', title: cmd.arg } } : { ok: true, space: 'S', doing: 1, todo: 0, review: 0, doneToday: 2 }; },
      fetchImpl: f,
      now: () => 1700000010000,
      log: () => { },
    });

    const r = await bridge.pollOnce();
    ok(r.ok && r.pulled === 3, '拉取到 3 条消息');
    ok(executed.length === 2, '只执行人发的两条指令（机器人消息跳过）');
    ok(executed[0].cmd === 'status' && executed[1].cmd === 'new', '指令按时间顺序执行');
    ok(executed[1].arg === '登录改版 | 加验证码', '参数原样传下去');
    ok(replies.length === 2, '每条指令都回一张卡片');
    /* 发消息请求体：{receive_id, msg_type, content(JSON 字符串)}，卡片在 content 里 */
    const payload = replies[0];
    const card = JSON.parse(payload.content);
    ok(payload.msg_type === 'interactive' && card.header && card.elements, '回执是 interactive 卡片');
    ok(state.feishu.lastSyncAt === 1700000007000, '水位推进到本轮最新消息时间');
    ok(!state.feishu.lastError, '成功后清空最近错误');

    /* 去重：同一批消息再拉一次不会重复执行 */
    const r2 = await bridge.pollOnce();
    ok(r2.ok && executed.length === 2, 'message_id 去重：同一条指令不重复执行');

    /* 失败留痕：拉取报错时保留旧水位并记录 lastError */
    const badBridge = createFeishuBridge({
      getSettings: () => ({ feishu: { ...state.feishu, lastSyncAt: 1700000007000 } }),
      saveSettings: p => { state.feishu = { ...state.feishu, ...(p.feishu || {}) }; },
      runCommand: async () => ({ ok: true }),
      fetchImpl: mkFetch([TOKEN_OK, { match: u => u.includes('container_id_type=chat'), reply: () => res(400, { code: 230002, msg: 'bot not in chat' }) }]),
      now: () => 1700000020000,
      log: () => { },
    });
    const r3 = await badBridge.pollOnce();
    ok(!r3.ok && /bot not in chat/.test(r3.error), '拉取失败如实返回错误');
    ok(state.feishu.lastSyncAt === 1700000007000, '失败不推进水位（下一轮重试同一段）');
    ok(/bot not in chat/.test(state.feishu.lastError), '最近错误写入设置，集成页可见');
  }

  /* ---------- 11. 每日摘要调度类型 ---------- */
  {
    const v = validateSchedule({ kind: 'digest', freq: 'daily', time: '18:00' });
    ok(v.ok && v.schedule.kind === 'digest', 'digest 是合法调度类型');
    ok(v.schedule.out === 'none', '未指定去向时默认只写看板');
    const v2 = validateSchedule({ kind: 'digest', freq: 'daily', time: '18:00', out: 'feishu' });
    ok(v2.ok && v2.schedule.out === 'feishu', '显式 feishu 去向');
    const v3 = validateSchedule({ kind: 'standup', freq: 'daily', time: '09:30', webhook: true });
    ok(v3.ok && v3.schedule.out === 'webhook', '旧字段 webhook=true 兼容为 out=webhook');
    const bad = validateSchedule({ kind: 'digest', freq: 'daily', time: '18:00', out: 'mail' });
    ok(!bad.ok && bad.errors.some(e => /去向/.test(e)), '非法去向被拒');
    ok(normalizeOut({ feishu: true, webhook: true }) === 'both', '对象形态去向归一为 both');
    ok(OUT_TARGETS.includes('none') && OUT_TARGETS.includes('feishu'), '去向往举含 none/feishu');
  }

  /* ---------- 12. 密钥落盘加密覆盖飞书字段 ---------- */
  {
    secureKeys.setBackend({
      encryptString: s => Buffer.from('enc:' + s),
      decryptString: b => String(b).replace(/^enc:/, ''),
    });
    const s = { feishu: { appId: 'cli_x', appSecret: 'sec-live', webhookSecret: 'hook-sec', chatId: 'oc' } };
    const sealed = secureKeys.sealSettings(s, 'auto');
    ok(sealed.sealed === 2, 'appSecret 与 webhookSecret 都加密');
    ok(sealed.state.feishu.appSecret.__encrypted === true && sealed.state.feishu.webhookSecret.__encrypted === true, '密文形态正确');
    ok(sealed.state.feishu.appId === 'cli_x' && sealed.state.feishu.chatId === 'oc', '非密钥字段保持明文');

    const opened = secureKeys.openSettings(sealed.state);
    ok(opened.state.feishu.appSecret === 'sec-live' && opened.state.feishu.webhookSecret === 'hook-sec', '解密还原明文');
    ok(!opened.state.__feishuLocked, '正常解密不标记锁定');

    /* 解密失败：保留密文 + 标记锁定（界面视同未配置） */
    const broken = { feishu: { appSecret: { __encrypted: true, data: Buffer.from('bad').toString('base64') } } };
    secureKeys.setBackend({ encryptString: s => Buffer.from(s), decryptString: () => { throw new Error('keychain'); } });
    const o2 = secureKeys.openSettings(broken);
    ok(o2.state.__feishuLocked === true && o2.failed === 1, '密钥串变更时标记锁定');
    ok(broken.feishu.appSecret && broken.feishu.appSecret.__encrypted, '锁定态保留密文，不静默清空');
    secureKeys.setBackend(null);
  }

  /* ---------- 13. 渲染层接线（源码断言：防后续改动把推送断开） ---------- */
  {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
    ok(SRC.includes('feishuNotify'), '渲染层调用 feishuNotify');
    ok(SRC.includes("notifyFeishu('task.rejected'"), '打回事件接线');
    ok(SRC.includes("notifyFeishu(/超时|timeout/i.test"), '失败/超时事件接线');
    ok(SRC.includes('feishuReport'), '报告推送接线');
    ok(SRC.includes('handleFeishuCall') && SRC.includes('onFeishuCall'), '群指令反向调用接线');
    /* 群内审批接线（P2）：三条指令都要在渲染层真正落到任务状态上 */
    ok(/cmd === 'approve'|cmd === 'approve' \|\|/.test(SRC), '渲染层实现 approve');
    ok(/cmd === 'reject'/.test(SRC), '渲染层实现 reject');
    ok(/cmd === 'revoke'/.test(SRC), '渲染层实现 revoke');
    ok(/TaskFlow\.approve\(t\)/.test(SRC), 'approve 判定走 taskflow 共享规则（含只有待验收可归档的守卫）');
    ok(/undecided-diff/.test(SRC) && /需先在 Reins 客户端确认应用或放弃/.test(SRC), 'approve 拦住未裁决的代码变更（taskflow 共享守卫 + 客户端引导文案）');
    ok(/来自飞书群/.test(SRC), '打回留痕标明来自飞书');
    ok(/TaskFlow\.applyPipelineReset\(t\.pipeline\)/.test(SRC), '流水线打回同样重置（与 doReject 同一共享口径）');
    const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    ok(/taskKey: cmd\.taskKey/.test(MAIN), '主进程把任务号透传给渲染层');
    ok(SRC.includes("kind === 'digest'") && SRC.includes('buildDigest'), '每日摘要生成接线');
    ok(SRC.includes('fs-appid') && SRC.includes('fs-hook'), '集成页飞书表单存在');
    const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    for (const k of ['feishuNotify', 'feishuReport', 'feishuTest', 'feishuStatus', 'feishuSync', 'onFeishuCall']) {
      ok(PRELOAD.includes(k + ':'), 'preload 暴露 ' + k);
    }
  }

  return n;
}

module.exports = { run };
