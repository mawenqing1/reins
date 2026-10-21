/* ============================================================
   Reins — 飞书接入（自建应用 + 群机器人）
   ------------------------------------------------------------
   双向同步分两条链路，都不依赖公网回调地址：

   【出站】Reins → 飞书
     - 自建应用：tenant_access_token（缓存到过期前 5 分钟）→ im/v1/messages 发群卡片
     - 群机器人：自定义机器人 webhook，支持「加签」校验（timestamp + \n + secret 为
       HMAC-SHA256 密钥，内容为空，base64），失败时可退回不加签重试一次
     - 卡片统一走 interactive 消息（header 主题色 + lark_md 正文 + 跳转按钮），
       文本类事件（报告 / 摘要）走 markdown 卡片，长文按飞书单条上限截断

   【入站】飞书 → Reins
     - 飞书自建应用收消息事件需要公网回调地址或长连接，内网桌面端都不可靠；
       这里用「轮询群历史消息」：GET /open-apis/im/v1/messages?container_id_type=chat
       增量拉取（start_time 按上次水位，重叠 60s）+ message_id 去重，解析群内指令：
         /reins status | /reins list | /reins new <标题> | /reins help
     - 指令由宿主（main.js）执行并回写成飞书卡片，形成「群里派活、群里看进度」闭环

   本模块零依赖（只用 Node 内置 crypto + 注入的 fetch），可在裸 Node 单测：
   所有网络调用通过 opts.fetchImpl 注入，token 缓存按 host+appId 隔离。
   ============================================================ */
const crypto = require('crypto');

const BASE = 'https://open.feishu.cn';

/* ---------- 签名 / 请求体构造 ---------- */
/* 群机器人加签：以 `timestamp\nsecret` 为密钥，对空串做 HMAC-SHA256，再 base64。
   注意是「字符串做密钥、空内容做消息」，方向反了飞书会一直报 19021 签名校验失败 */
function signWebhook(secret, timestamp, content) {
  const stringToSign = String(timestamp) + '\n' + String(secret);
  return crypto.createHmac('sha256', stringToSign).update(String(content || '')).digest('base64');
}

/* 机器人消息体：有 secret 时带 sign（按完整 body 参与签名），否则裸 body */
function buildWebhookBody(body, cfg, nowMs) {
  const c = cfg || {};
  const payload = JSON.parse(JSON.stringify(body || {}));
  if (!c.secret) return payload;
  const ts = String(Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000));
  payload.timestamp = ts;
  payload.sign = signWebhook(c.secret, ts, JSON.stringify(payload));
  return payload;
}

/* ---------- 卡片 ---------- */
const THEME = {
  blue: 'blue', green: 'green', red: 'red', orange: 'orange',
  grey: 'grey', turquoise: 'turquoise', violet: 'violet', yellow: 'yellow',
};

function mdText(content) {
  return { tag: 'div', text: { tag: 'lark_md', content: String(content == null ? '' : content) } };
}
function plainRow(content) {
  return { tag: 'div', text: { tag: 'plain_text', content: String(content == null ? '' : content).slice(0, 200) } };
}
function hr() { return { tag: 'hr' }; }

/* 单行「字段：值」小号说明行 */
function noteLine(content) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content: String(content == null ? '' : content).slice(0, 300) }] };
}

/* 卡片骨架：header（标题 + 主题色）+ elements；url 存在时追加「打开 Reins」按钮 */
function card(opts) {
  const o = opts || {};
  const title = String(o.title || 'Reins').slice(0, 100);
  const elements = (o.elements || []).filter(Boolean);
  if (o.url) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button', text: { tag: 'plain_text', content: o.actionText || '打开 Reins' },
        type: 'default', url: String(o.url),
      }],
    });
  }
  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      template: THEME[o.theme] || 'blue',
      title: { tag: 'plain_text', content: title },
    },
    elements,
  };
}

/* 纯文本 → 卡片：报告类长文用；超长按行截断，尾巴标明省略 */
function textCard(title, text, opts) {
  const o = opts || {};
  const LIMIT = 3200;
  let body = String(text == null ? '' : text);
  if (body.length > LIMIT) {
    const cut = body.slice(0, LIMIT);
    body = cut.slice(0, Math.max(0, cut.lastIndexOf('\n'))) + '\n\n…（内容较长已截断，完整版见 Reins 客户端）';
  }
  const els = [];
  if (o.meta) els.push(noteLine(o.meta));
  /* markdown 标题/表格在 lark_md 里不渲染，降级为加粗行与原文，保持可读 */
  const cleaned = body
    .replace(/^#{1,6}\s+(.*)$/gm, '**$1**')
    .replace(/^>\s?/gm, '')
    .replace(/^---+$/gm, '──────────');
  els.push(mdText(cleaned));
  return card({ title, theme: o.theme || 'blue', elements: els, url: o.url, actionText: o.actionText });
}

/* ---------- 事件卡片（任务创建 / 归档 / 打回 / 失败） ---------- */
const STATUS_CN = { todo: '待处理', doing: '进行中', review: '待验收', done: '已归档' };
const KIND_META = {
  created: { theme: 'blue', icon: '📋', label: '新任务' },
  done: { theme: 'green', icon: '✅', label: '任务归档' },
  rejected: { theme: 'orange', icon: '↩️', label: '验收打回' },
  failed: { theme: 'red', icon: '⚠️', label: '执行失败' },
  timeout: { theme: 'orange', icon: '⏱️', label: '执行超时' },
  standup: { theme: 'turquoise', icon: '☰', label: '站会报告' },
  weekly: { theme: 'violet', icon: '▤', label: '周报' },
  digest: { theme: 'blue', icon: '📊', label: '每日摘要' },
  ping: { theme: 'grey', icon: '🔗', label: '连通测试' },
};

/* 任务事件卡片：kind = created/done/rejected/failed/timeout */
function taskCard(kind, task, opts) {
  const o = opts || {};
  const meta = KIND_META[kind] || KIND_META.created;
  const t = task || {};
  const rows = [];
  const line = (k, v) => rows.push(mdText('**' + k + '**：' + (v == null || v === '' ? '—' : v)));
  line('任务', (t.key || '') + ' ' + (t.title || ''));
  if (t.pri) line('优先级', t.pri);
  if (t.status) line('状态', STATUS_CN[t.status] || t.status);
  const who = t.assignee && t.assignee.name ? t.assignee.name : (t.assigneeName || '');
  if (who) line('经办', who);
  if (t.pr) line('交付', t.pr);
  if (o.extra) line(o.extra.label, o.extra.value);
  if (o.reason) rows.push(noteLine('原因：' + String(o.reason).slice(0, 260)));

  const elements = [rows[0], ...rows.slice(1)];
  return card({
    title: meta.icon + ' ' + meta.label + (o.space ? ' · ' + o.space : ''),
    theme: meta.theme,
    elements,
    url: o.url,
    actionText: o.actionText || '在 Reins 处理',
  });
}

/* ---------- API 调用 ---------- */
function normalizeBase(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return BASE;
  if (!/^https?:\/\//.test(b)) return BASE;
  /* 兼容用户填 https://open.feishu.cn 或 https://open.feishu.cn/open-apis */
  return b.replace(/\/open-apis$/, '');
}

function tokenCacheKey(cfg) {
  return normalizeBase(cfg && cfg.baseUrl) + '|' + String((cfg && cfg.appId) || '');
}

/* tenant_access_token 缓存：按 host+appId 独立；提前 5 分钟视为过期（单测可注入 now()） */
const tokenStore = new Map();
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

function clearToken(cfg) { tokenStore.delete(tokenCacheKey(cfg)); }
function clearAllTokens() { tokenStore.clear(); }

/* 统一处理飞书 {code,msg,data} 应答：code!==0 抛带 code 的错误（调用方转中文提示） */
function unwrap(json, action) {
  const code = json && (json.code !== undefined ? json.code : json.StatusCode);
  if (code !== undefined && Number(code) !== 0) {
    const e = new Error((action || '飞书接口') + '失败：' + (json.msg || json.StatusMessage || ('code ' + code)));
    e.feishuCode = Number(code);
    e.feishuMsg = json.msg || json.StatusMessage || '';
    throw e;
  }
  return json && json.data !== undefined ? json.data : json;
}

function defaultFetch() {
  return typeof global.fetch === 'function' ? global.fetch : null;
}

async function request(cfg, path, init, opts) {
  const o = opts || {};
  const f = o.fetchImpl || defaultFetch();
  if (!f) throw new Error('当前环境无可用 fetch');
  const url = normalizeBase(cfg && cfg.baseUrl) + '/open-apis' + path;
  const res = await f(url, {
    method: (init && init.method) || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, (init && init.headers) || {}),
    body: init && init.body ? JSON.stringify(init.body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (!res.ok && !json) throw new Error('飞书接口 HTTP ' + res.status);
  return unwrap(json, o.action);
}

/* tenant_access_token：缓存命中直接用；401/99991663 等失效码由调用方 clear 后重取 */
async function getToken(cfg, opts) {
  const c = cfg || {};
  if (!c.appId || !c.appSecret) throw new Error('未配置飞书应用 App ID / App Secret');
  const nowFn = (opts && opts.now) || Date.now;
  const key = tokenCacheKey(c);
  const hit = tokenStore.get(key);
  const now = nowFn();
  if (hit && hit.expireAt - TOKEN_SAFETY_MS > now) return hit.token;

  const data = await request(c, '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    body: { app_id: c.appId, app_secret: c.appSecret },
  }, Object.assign({}, opts, { action: '获取 tenant_access_token ' }));
  const token = data && data.tenant_access_token;
  const expire = Number(data && data.expire) || 7200;
  if (!token) throw new Error('飞书未返回 tenant_access_token（检查 App ID / Secret）');
  tokenStore.set(key, { token, expireAt: now + expire * 1000 });
  return token;
}

/* ---------- 出站：发消息 ---------- */
/* 发群消息（自建应用）。msgType: interactive / text / post；content 为消息体对象 */
async function sendMessage(cfg, opts) {
  const o = opts || {};
  const chatId = String(o.chatId || (cfg && cfg.chatId) || '').trim();
  if (!chatId) throw new Error('未配置群 chat_id');
  const msgType = o.msgType || 'interactive';
  const body = {
    receive_id: chatId,
    msg_type: msgType,
    content: JSON.stringify(o.content === undefined ? {} : o.content),
  };
  if (o.uuid) body.uuid = String(o.uuid).slice(0, 50);

  const token = await getToken(cfg, o);
  try {
    return await request(cfg, '/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body,
    }, { fetchImpl: o.fetchImpl, action: '发送群消息 ' });
  } catch (e) {
    /* token 失效类错误：清缓存重试一次（权限类错误不重试，避免无意义请求） */
    if (isTokenError(e)) {
      clearToken(cfg);
      const retry = await getToken(cfg, o);
      return request(cfg, '/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + retry },
        body,
      }, { fetchImpl: o.fetchImpl, action: '发送群消息 ' });
    }
    throw e;
  }
}

function isTokenError(e) {
  const c = e && e.feishuCode;
  return c === 99991661 || c === 99991663 || c === 99991668 || c === 99991677;
}

/* 群机器人 webhook 发送：带 sign 失败（19021/签名类）时退回不加签重试一次 */
async function sendWebhook(webhookUrl, body, cfg, opts) {
  const o = opts || {};
  const url = String(webhookUrl || '').trim();
  if (!url) throw new Error('未配置群机器人 Webhook 地址');
  if (!/^https?:\/\//.test(url)) throw new Error('Webhook 地址需以 http:// 或 https:// 开头');
  const f = o.fetchImpl || defaultFetch();
  if (!f) throw new Error('当前环境无可用 fetch');

  const post = async payload => {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok && !json) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
    return { status: res.status, json, data: unwrap(json, '群机器人推送 ') };
  };

  const first = buildWebhookBody(body, cfg, o.now);
  try {
    const r = await post(first);
    return { ok: true, status: r.status, signed: !!cfg.secret, data: r.data };
  } catch (e) {
    /* 签名错（19021）/ 时间戳过期（19022）：去掉签名再试一次——有的机器人并未开加签 */
    const signIssue = e && (e.feishuCode === 19021 || e.feishuCode === 19022);
    if (cfg && cfg.secret && signIssue) {
      const r = await post(JSON.parse(JSON.stringify(body)));
      return { ok: true, status: r.status, signed: false, data: r.data, note: '加签未通过，已按未加签重试成功' };
    }
    throw e;
  }
}

/* 统一出站入口：应用优先（能发群、能读消息），否则回落群机器人 */
async function push(cfg, opts) {
  const o = opts || {};
  const c = cfg || {};
  if (c.appId && c.appSecret && c.chatId) {
    const r = await sendMessage(c, {
      chatId: c.chatId, msgType: 'interactive', content: o.card, uuid: o.uuid, fetchImpl: o.fetchImpl, now: o.now,
    });
    return { ok: true, via: 'app', messageId: r && r.message_id };
  }
  if (c.webhookUrl) {
    const r = await sendWebhook(c.webhookUrl, { msg_type: 'interactive', card: o.card }, { secret: c.webhookSecret }, o);
    return { ok: true, via: 'webhook', signed: r.signed, note: r.note };
  }
  throw new Error('飞书未配置：请填写应用 App ID/Secret + chat_id，或群机器人 Webhook 地址');
}

/* ---------- 入站：拉群消息 + 指令解析 ---------- */
/* 飞书消息正文是 JSON 字符串：text → {text}；post → {content:[[{tag,text}]]}；
   interactive → 卡片（无需解析）；其余类型给占位文案 */
function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const type = msg.msg_type || msg.message_type || '';
  let body = msg.body;
  if (body && typeof body === 'object' && typeof body.content === 'string') body = body.content;
  if (typeof body !== 'string') return '';
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { return ''; }
  if (type === 'text') return String(parsed.text || '');
  if (type === 'post') {
    const out = [];
    const walk = node => {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node === 'object') {
        if (typeof node.text === 'string') out.push(node.text);
        if (node.content) walk(node.content);
      }
    };
    walk(parsed.content || parsed);
    return out.join(' ');
  }
  return '';
}

/* 增量水位：从 startTime 起取（秒级），成功返回下一轮水位（本轮最新 create_time，毫秒）；
   失败抛错，由宿主保留旧水位下一轮重试 */
async function fetchMessages(cfg, opts) {
  const o = opts || {};
  const chatId = String(o.chatId || (cfg && cfg.chatId) || '').trim();
  if (!chatId) throw new Error('未配置群 chat_id');
  const nowMs = o.now ? o.now() : Date.now();
  const startSec = Math.max(0, Math.floor((Number(o.startTime) || nowMs - 10 * 60 * 1000) / 1000));
  const token = await getToken(cfg, o);
  const qs = new URLSearchParams({
    container_id_type: 'chat',
    container_id: chatId,
    start_time: String(startSec),
    sort_type: 'ByCreateTimeAsc',
    page_size: String(Math.min(Math.max(Number(o.pageSize) || 20, 1), 50)),
  });
  const data = await request(cfg, '/im/v1/messages?' + qs.toString(), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token },
  }, { fetchImpl: o.fetchImpl, action: '拉取群消息 ' });
  const items = (data && (data.items || data.messages)) || [];
  let newest = Number(o.startTime) || 0;
  for (const m of items) {
    const ct = Number(m && m.create_time);
    if (Number.isFinite(ct) && ct > newest) newest = ct;
  }
  return { items, nextStart: newest || startSec * 1000 };
}

/* 指令解析：仅识别 `/reins <cmd> [rest]`，其余消息忽略（群里闲聊不该触发动作）。
   返回 {cmd, arg, raw, taskKey, reason} 或 null；
   cmd ∈ status|list|new|approve|reject|revoke|help
   · approve/reject/revoke 带任务号：/reins approve REINS-42
   · reject 可带原因：/reins reject REINS-42 第二部分缺少来源
   设计说明：飞书卡片按钮回调需要公网可访问地址（card.action.trigger），与
   「客户端轮询」的内网架构冲突；改用同样语义的群指令，落到同一条拉取通道里。 */
function parseCommand(text) {
  const s = String(text == null ? '' : text).trim();
  const m = s.match(/^[/@][\s]*reins\b[\s:,，]*(.*)$/i);
  if (!m) return null;
  const rest = String(m[1] || '').trim();
  if (!rest) return { cmd: 'help', arg: '', raw: s };
  const sp = rest.match(/^(\S+)\s*([\s\S]*)$/);
  const cmd = String(sp[1] || '').toLowerCase();
  const arg = String(sp[2] || '').trim();
  if (cmd === 'new' || cmd === 'create' || cmd === '新建') return { cmd: 'new', arg, raw: s };
  if (cmd === 'list' || cmd === 'ls' || cmd === '列表') return { cmd: 'list', arg, raw: s };
  if (cmd === 'status' || cmd === '状态') return { cmd: 'status', arg, raw: s };
  /* 审批类：首个 token 是任务号（REINS-42 / reins-42 / 42 都认），其余作为原因 */
  if (['approve', 'pass', '通过', '验收'].includes(cmd)) {
    const p = splitTaskArg(arg);
    return { cmd: 'approve', arg, taskKey: p.key, reason: p.rest, raw: s };
  }
  if (['reject', '打回', '驳回'].includes(cmd)) {
    const p = splitTaskArg(arg);
    return { cmd: 'reject', arg, taskKey: p.key, reason: p.rest, raw: s };
  }
  if (['revoke', '待审', '撤回'].includes(cmd)) {
    const p = splitTaskArg(arg);
    return { cmd: 'revoke', arg, taskKey: p.key, reason: p.rest, raw: s };
  }
  if (cmd === 'help' || cmd === '帮助' || cmd === '?') return { cmd: 'help', arg: '', raw: s };
  return { cmd: 'unknown', arg: rest, raw: s };
}

/* 任务号归一：REINS-42 / reins-42 / 42 → REINS-42；同时拆出后面剩余的原因文本 */
function splitTaskArg(arg) {
  const s = String(arg || '').trim();
  const m = s.match(/^([A-Za-z]+-)?(\d+)\b[\s:：,，]*(.*)$/);
  if (!m) return { key: '', rest: s };
  const prefix = (m[1] || 'REINS-').toUpperCase();
  return { key: prefix + m[2], rest: String(m[3] || '').trim() };
}

/* 只处理「人发的」文本消息：机器人自己发的卡片/系统消息跳过 */
function isHumanTextMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const type = msg.msg_type || msg.message_type || '';
  if (!['text', 'post'].includes(type)) return false;
  const sender = msg.sender || {};
  if (sender.sender_type && sender.sender_type !== 'user') return false;
  if (sender.type && sender.type !== 'user') return false;
  return !!messageText(msg);
}

/* 指令回执卡片 */
function replyCard(cmd, payload) {
  const p = payload || {};
  if (cmd === 'help') {
    return card({
      title: '🤖 Reins 指令',
      theme: 'grey',
      elements: [
        mdText('在群里 @Reins 或用 `/reins` 前缀下发指令，Reins 会读群消息并执行（需在「集成」页开启「读取群指令」）：'),
        hr(),
        mdText('**/reins status** 空间概况：进行中 / 待验收 / 最近归档'),
        mdText('**/reins list** 列出当前未完成任务（含待验收）'),
        mdText('**/reins new 标题** 在 Reins 创建任务（可用 `|` 追加描述）'),
        mdText('**/reins approve REINS-42** 验收通过并归档（仅待验收任务）'),
        mdText('**/reins reject REINS-42 原因** 打回重做（原因会写进任务反馈）'),
        mdText('**/reins revoke REINS-42** 撤回验收，回到进行中'),
        mdText('**/reins help** 显示本帮助'),
        hr(),
        noteLine('任务创建后会回执任务号；归档 / 打回 / 失败等事件也会自动推送到本群。'),
      ],
    });
  }
  if (cmd === 'status') {
    const els = [mdText('**空间**：' + (p.space || '—'))];
    const rows = [
      ['进行中', p.doing], ['待处理', p.todo], ['待验收', p.review], ['今日归档', p.doneToday],
    ];
    els.push(hr());
    els.push(mdText(rows.map(([k, v]) => '**' + k + '**：' + (v == null ? 0 : v)).join('\n')));
    if (p.recent && p.recent.length) {
      els.push(hr());
      els.push(mdText('**最近归档**\n' + p.recent.slice(0, 5).map(t => '· ' + t).join('\n')));
    }
    return card({ title: '📊 Reins 空间概况', theme: 'blue', elements: els, url: p.url, actionText: '打开 Reins' });
  }
  if (cmd === 'list') {
    const tasks = p.tasks || [];
    const els = [];
    if (!tasks.length) els.push(mdText('当前没有未完成任务 ✅'));
    else {
      els.push(mdText(tasks.slice(0, 15).map(t =>
        '**' + t.key + '** [' + (t.pri || 'P2') + '] ' + t.title + ' — ' + (STATUS_CN[t.status] || t.status) + (t.assignee ? ' · ' + t.assignee : '')
      ).join('\n')));
      if (tasks.length > 15) els.push(noteLine('仅显示前 15 条，共 ' + tasks.length + ' 条'));
    }
    return card({ title: '🗂 Reins 未完成任务', theme: 'blue', elements: els, url: p.url, actionText: '打开 Reins' });
  }
  if (cmd === 'approve' || cmd === 'reject' || cmd === 'revoke') {
    const label = { approve: '验收通过', reject: '已打回', revoke: '已撤回验收' }[cmd];
    if (!p.ok) {
      return card({
        title: '⚠️ 审批未执行',
        theme: 'red',
        elements: [
          mdText(p.error || '未知原因'),
          hr(),
          noteLine('用法：/reins ' + cmd + ' REINS-42' + (cmd === 'reject' ? ' 打回原因' : '')),
        ],
      });
    }
    const t = p.task || {};
    const els = [mdText('**' + (t.key || '') + '** ' + (t.title || ''))];
    if (p.reason) els.push(mdText('**原因**：' + String(p.reason).slice(0, 300)));
    els.push(hr());
    els.push(noteLine('由飞书群指令触发 · ' + (p.operator || '群成员')));
    return card({
      title: ({ approve: '✅ ', reject: '↩️ ', revoke: '↪️ ' }[cmd] || '') + label,
      theme: ({ approve: 'green', reject: 'orange', revoke: 'grey' }[cmd] || 'blue'),
      elements: els,
      url: p.url, actionText: '在 Reins 查看',
    });
  }
  if (cmd === 'new') {
    if (!p.ok) {
      return card({ title: '⚠️ 创建任务失败', theme: 'red', elements: [mdText(p.error || '未指定任务标题'), noteLine('用法：/reins new 任务标题 | 可选描述')] });
    }
    return card({
      title: '📋 已在 Reins 创建任务',
      theme: 'green',
      elements: [
        mdText('**' + (p.task.key || '') + '** ' + (p.task.title || '')),
        p.task.desc ? mdText(p.task.desc) : null,
        hr(),
        noteLine('来自飞书群指令 · ' + (p.operator || '群成员')),
      ].filter(Boolean),
      url: p.url, actionText: '在 Reins 查看',
    });
  }
  return card({ title: '🤖 Reins', theme: 'grey', elements: [mdText(p.error || '无法识别的指令，发送 `/reins help` 查看用法')] });
}

module.exports = {
  BASE, normalizeBase, THEME,
  signWebhook, buildWebhookBody,
  card, textCard, taskCard, mdText, noteLine, hr, replyCard,
  getToken, clearToken, clearAllTokens, tokenStore, TOKEN_SAFETY_MS,
  sendMessage, sendWebhook, push, isTokenError, unwrap,
  messageText, fetchMessages, parseCommand, isHumanTextMessage,
  STATUS_CN, KIND_META,
};
