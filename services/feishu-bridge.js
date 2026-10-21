/* ============================================================
   Reins — 飞书桥（主进程常驻）
   ------------------------------------------------------------
   与 services/feishu.js 的分工：feishu.js 只做协议（签名 / 卡片 / 接口），
   本模块负责「接线」——读设置、事件去重排队、失败降级、入站轮询与指令回执。

   出站：
     notify(kind, task, opts)  任务事件 → 卡片 → 自建应用群消息 / 群机器人
     pushReport(title, text…)   站报 / 周报 / 每日摘要 → markdown 卡片
     webhook(payload)          沿用「集成」页 Webhook：地址是飞书机器人（含 hook/ 或
                               open.feishu.cn 域名）时自动转成飞书卡片协议，
                               其它地址保持原有 JSON POST 行为（向后兼容）
   入站：
     startInbound / stopInbound  按同步间隔轮询群历史消息，解析 /reins 指令，
     交宿主执行（runCommand）后回写卡片；message_id 去重 + 水位重叠窗口防漏防重

   设计约束：
   - 所有推送串行排队（单条在途），飞书机器人有频控，并发打过去只会一起失败；
   - 失败只记录到 lastError / 日志，绝不影响任务执行主流程；
   - 设置每轮现读，改配置无需重启客户端。
   ============================================================ */
const feishu = require('./feishu');

const EVENTS = ['create', 'done', 'reject', 'fail'];
const MAX_LOG = 60;
const PUSH_TIMEOUT_MS = 15000;

/* 站报/周报卡片正文上限之外，卡片标题也要控制长度 */
const clip = (s, n) => (String(s == null ? '' : s).length > n ? String(s).slice(0, n) + '…' : String(s == null ? '' : s));

/* 拉群消息失败的错误码里，这些说明「应用没配 chat_id / 未入群 / 权限未开」 */
function inboundHint(e) {
  const msg = String((e && e.message) || e || '');
  if (/chat_id/.test(msg)) return msg + '（「集成」页填写群的 chat_id，形如 oc_xxx）';
  if (/permission|权限|99991/i.test(msg)) return msg + '（飞书应用需开通 im:message 相关权限并发布版本）';
  return msg;
}

function createFeishuBridge(dep) {
  const d = dep || {};
  const fetchImpl = d.fetchImpl || undefined;
  const now = d.now || Date.now;
  const log = (...a) => { try { if (d.log) d.log(...a); else console.log(...a); } catch (e) { } };
  const getSettings = () => (d.getSettings ? d.getSettings() : {}) || {};
  const saveSettings = (patch) => { try { d.saveSettings && d.saveSettings(patch); } catch (e) { log('[feishu] 设置回写失败:', e.message); } };

  /* 事件开关默认值：开启接入即全开，用户可在集成页逐项关闭 */
  function cfgOf(settings) {
    const s = settings || {};
    const f = s.feishu && typeof s.feishu === 'object' ? s.feishu : {};
    const events = Object.assign({ create: true, done: true, reject: true, fail: true }, f.events && typeof f.events === 'object' ? f.events : {});
    return {
      enabled: !!f.enabled,
      appId: typeof f.appId === 'string' ? f.appId.trim() : '',
      appSecret: typeof f.appSecret === 'string' ? f.appSecret : '',
      chatId: typeof f.chatId === 'string' ? f.chatId.trim() : '',
      baseUrl: typeof f.baseUrl === 'string' ? f.baseUrl.trim() : '',
      webhookUrl: typeof f.webhookUrl === 'string' ? f.webhookUrl.trim() : '',
      webhookSecret: typeof f.webhookSecret === 'string' ? f.webhookSecret : '',
      events,
      inbound: f.inbound === true,
      inboundIntervalMs: Math.min(Math.max(Number(f.inboundIntervalMs) || 45000, 15000), 10 * 60 * 1000),
      lastSyncAt: Number(f.lastSyncAt) || 0,
      lastError: typeof f.lastError === 'string' ? f.lastError : '',
    };
  }
  const appReady = c => !!(c.appId && c.appSecret && c.chatId);
  const webhookReady = c => !!c.webhookUrl;
  const usable = c => c.enabled && (appReady(c) || webhookReady(c));
  const secret = c => (c.webhookSecret ? { secret: c.webhookSecret } : {});

  /* ---------- 推送队列 ---------- */
  let queue = Promise.resolve();
  const recent = [];            // 最近推送（集成页日志用）
  function record(item) {
    recent.unshift(Object.assign({ at: now() }, item));
    if (recent.length > MAX_LOG) recent.length = MAX_LOG;
  }
  function enqueue(label, run) {
    queue = queue.then(async () => {
      const t0 = now();
      try {
        const r = await run();
        record({ ok: true, label, via: r && r.via, msg: r && r.note || '' });
        return r;
      } catch (e) {
        record({ ok: false, label, error: String((e && e.message) || e) });
        log('[feishu] 推送失败（' + label + '）：', (e && e.message) || e);
        return { ok: false, error: String((e && e.message) || e) };
      } finally {
        void t0;
      }
    }).catch(e => { log('[feishu] 队列异常:', e.message); });
    return queue;
  }

  /* 统一出站：应用优先，回落群机器人；配置缺失返回 skipped，真实发送失败照常抛出
     （enqueue 负责记录失败并转成 ok:false，调用方拿到的一律是结构化结果） */
  async function send(cfg, card, opts) {
    const o = opts || {};
    if (!cfg.enabled) return { ok: false, skipped: true, error: '飞书推送未开启' };
    if (!(appReady(cfg) || webhookReady(cfg))) return { ok: false, skipped: true, error: '飞书未配置（应用信息或机器人地址）' };
    const withTimeout = (fn, ms) => {
      let timer = null;
      const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('推送超时（' + Math.round(ms / 1000) + 's）')), ms); });
      return Promise.race([fn(), guard]).finally(() => clearTimeout(timer));
    };
    const r = await withTimeout(() => feishu.push(cfg, { card, uuid: o.uuid, fetchImpl, now }), PUSH_TIMEOUT_MS);
    return r && r.ok === false ? { ok: false, error: r.error || '推送失败' } : r;
  }

  /* ---------- 出站 API ---------- */
  function notify(kind, task, opts) {
    const o = opts || {};
    const s = getSettings();
    const cfg = cfgOf(s);
    if (!usable(cfg)) return Promise.resolve({ ok: false, skipped: true, error: '飞书未开启或未配置' });
    const evKey = kind === 'done' ? 'done' : kind === 'rejected' ? 'reject' : kind === 'created' ? 'create' : (kind === 'failed' || kind === 'timeout') ? 'fail' : null;
    if (evKey && cfg.events[evKey] === false) return Promise.resolve({ ok: false, skipped: true, error: '该事件已关闭' });

    const card = feishu.taskCard(kind, task, {
      space: o.space, url: o.url, reason: o.reason,
      extra: o.extra,
      actionText: o.actionText,
    });
    const label = {
      created: '任务创建', done: '任务归档', rejected: '验收打回',
      failed: '执行失败', timeout: '执行超时',
    }[kind] || kind;
    return enqueue(label + ' ' + ((task && task.key) || ''), () => send(cfg, card, { uuid: o.uuid }));
  }

  /* 报告（站报 / 周报 / 每日摘要）：标题 + markdown 正文 */
  function pushReport(title, text, opts) {
    const o = opts || {};
    const cfg = cfgOf(getSettings());
    if (!usable(cfg)) return Promise.resolve({ ok: false, skipped: true, error: '飞书未开启或未配置' });
    const card = feishu.textCard(title, text, { meta: o.meta, theme: o.theme, url: o.url, actionText: o.actionText });
    return enqueue('报告 ' + clip(title, 24), () => send(cfg, card, {}));
  }

  /* 连通测试：直接用页面上的临时配置（不要求先保存） */  async function test(override) {
    const cfg = Object.assign(cfgOf(getSettings()), override || {});
    const card = feishu.card({
      title: '🔗 Reins 飞书连通测试',
      theme: 'grey',
      elements: [
        feishu.mdText('收到这张卡片说明 **Reins → 飞书** 链路已打通。\n后续任务创建、归档、打回、执行失败与每日摘要都会推送到这里。'),
        feishu.hr(),
        feishu.noteLine('发送时间：' + new Date(now()).toLocaleString('zh-CN', { hour12: false }) + ' · 由「集成」页手动触发'),
      ],
    });
    try {
      const r = await send(cfg, card, {});
      if (r && r.ok) return { ok: true, via: r.via, note: r.note || '' };
      return { ok: false, error: (r && r.error) || '发送失败' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /* ---------- 入站：群指令 ---------- */
  let inboundTimer = null;
  let inboundBusy = false;
  let seen = new Set();        // message_id 去重（保留最近 500 条）
  const seenPush = id => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    return true;
  };
  function resetSeen() { seen = new Set(); }

  /* ---------- 就绪排队：控制台未就绪时的指令回放 ----------
     状态权威在渲染层（页面加载/重载期间指令执行不了）。此前未就绪只回一张错误卡，
     水位照常推进——指令被消费掉，用户必须重发。现在 runCommand 报 notReady 时：
     指令进待办队列 + 回「已排队」卡；渲染层就绪信号（notifyReady，宿主接线）后逐条
     回放执行并回真实结果卡。去重靠 message_id（seenPush），回放不会被下一轮轮询重复执行 */
  const pendingCmds = [];
  const PENDING_MAX = 20;
  const PENDING_MAX_TRIES = 3;
  function queuedCard(cmdName) {
    return feishu.card({
      title: '⏳ 指令已排队 · /reins ' + cmdName,
      theme: 'turquoise',
      elements: [feishu.mdText('控制台正在启动，指令将在就绪后自动执行，结果另行回执。')],
    });
  }
  /* 就绪回放：逐条重执行；仍报 notReady 则重新入队（有限次），超限回失败卡并放弃 */
  async function notifyReady() {
    if (!pendingCmds.length) return { ok: true, replayed: 0, requeued: 0, dropped: 0 };
    const cfg = cfgOf(getSettings());
    const batch = pendingCmds.splice(0, pendingCmds.length);
    let replayed = 0, requeued = 0, dropped = 0;
    for (const item of batch) {
      let payload = null;
      try { payload = await (d.runCommand ? d.runCommand(item.cmd, { message: item.message }) : null); }
      catch (e) { payload = { error: '执行指令失败：' + ((e && e.message) || e) }; }
      if (payload && payload.notReady) {
        item.tries = (item.tries || 1) + 1;
        if (item.tries < PENDING_MAX_TRIES) { pendingCmds.push(item); requeued++; continue; }
        dropped++;
        payload = { error: '控制台持续未就绪，请打开 Reins 客户端后重发指令' };
      }
      replayed++;
      try {
        await send(cfg, feishu.replyCard(item.cmd.cmd, payload || {}), {});
      } catch (e) {
        log('[feishu] 排队指令回执发送失败:', (e && e.message) || e);
      }
    }
    if (replayed || requeued || dropped) log('[feishu] 就绪回放：执行 ' + replayed + ' / 重新排队 ' + requeued + ' / 放弃 ' + dropped);
    return { ok: true, replayed, requeued, dropped };
  }

  /* 一轮轮询：拉增量消息 → 过滤人发的文本 → 解析指令 → 交宿主执行（未就绪转排队）→ 回执卡片 */
  async function pollOnce() {
    const cfg = cfgOf(getSettings());
    if (!cfg.enabled || !cfg.inbound || !appReady(cfg)) return { ok: false, skipped: true, error: '未开启群指令同步或应用未配置' };
    if (inboundBusy) return { ok: false, skipped: true, error: '上一轮同步尚未结束' };
    inboundBusy = true;
    try {
      const overlapMs = 60 * 1000;
      const start = cfg.lastSyncAt ? Math.max(0, cfg.lastSyncAt - overlapMs) : now() - 10 * 60 * 1000;
      const r = await feishu.fetchMessages(cfg, { startTime: start, pageSize: 30, fetchImpl, now });
      const handled = [];
      for (const msg of r.items || []) {
        const id = String(msg && (msg.message_id || msg.id) || '');
        if (!id || !seenPush(id)) continue;
        if (!feishu.isHumanTextMessage(msg)) continue;
        const cmd = feishu.parseCommand(feishu.messageText(msg));
        if (!cmd) continue;
        let payload = null;
        try {
          payload = await (d.runCommand ? d.runCommand(cmd, { message: msg }) : null);
        } catch (e) {
          payload = { error: '执行指令失败：' + ((e && e.message) || e) };
        }
        let queued = false;
        if (payload && payload.notReady) {
          pendingCmds.push({ cmd, message: msg, tries: 1 });
          if (pendingCmds.length > PENDING_MAX) pendingCmds.shift();
          queued = true;
          payload = { ok: true, queued: true };
        }
        if (queued) handled.push({ cmd: cmd.cmd, queued: true });
        else if (payload && payload.error && cmd.cmd !== 'new') handled.push({ cmd: cmd.cmd, error: payload.error });
        else handled.push({ cmd: cmd.cmd, ok: payload ? payload.ok !== false : false });
        try {
          await send(cfg, queued ? queuedCard(cmd.cmd) : feishu.replyCard(cmd.cmd, payload || {}), {});
        } catch (e) {
          log('[feishu] 指令回执发送失败:', (e && e.message) || e);
        }
      }
      /* 水位推进：拉到的最新消息时间与「当前时间」取较小值，防服务端时钟超前把后续消息跳过。
         排队中的指令不挡水位——它们的去重靠 message_id，与轮询无關 */
      const nextAt = Math.min(r.nextStart || start, now());
      saveSettings({ feishu: { lastSyncAt: nextAt, lastError: '' } });
      return { ok: true, pulled: (r.items || []).length, handled };
    } catch (e) {
      const msg = inboundHint(e);
      saveSettings({ feishu: { lastError: clip(msg, 300) } });
      log('[feishu] 群消息同步失败:', msg);
      return { ok: false, error: msg };
    } finally {
      inboundBusy = false;
    }
  }

  function scheduleInbound() {
    const cfg = cfgOf(getSettings());
    const on = cfg.enabled && cfg.inbound && appReady(cfg);
    if (!on) {
      if (inboundTimer) { clearTimeout(inboundTimer); inboundTimer = null; }
      return false;
    }
    if (inboundTimer) return true;
    const loop = async () => {
      inboundTimer = null;
      await pollOnce();
      const c2 = cfgOf(getSettings());
      if (c2.enabled && c2.inbound && appReady(c2)) inboundTimer = setTimeout(loop, c2.inboundIntervalMs);
    };
    inboundTimer = setTimeout(loop, 3000);   // 首轮延后：等窗口与渲染层就绪
    return true;
  }
  function startInbound() { return scheduleInbound(); }
  function stopInbound() { if (inboundTimer) { clearTimeout(inboundTimer); inboundTimer = null; } }
  /* 设置变更后重排：关掉 / 改间隔 / 换群都即时生效。
     settings:set 是全局通道（改任何设置都会走到这里），用配置指纹去重——
     飞书相关字段没变就不重排同步器、也不丢 token 缓存 */
  let lastSig = '';
  function refresh() {
    const cfg = cfgOf(getSettings());
    const sig = [cfg.enabled, cfg.appId, cfg.appSecret ? '1' : '0', cfg.baseUrl, cfg.chatId, cfg.inbound, cfg.inboundIntervalMs].join('|');
    if (sig === lastSig) return false;
    const tokenChanged = lastSig === '' || sig.split('|').slice(0, 5).join('|') !== lastSig.split('|').slice(0, 5).join('|');
    lastSig = sig;
    if (cfg.enabled && cfg.inbound && appReady(cfg)) {
      stopInbound();
      scheduleInbound();
    } else stopInbound();
    if (tokenChanged) feishu.clearToken(cfg);   // 应用身份/域名可能变了：丢弃旧 token 缓存
    return true;
  }

  /* 会话诊断：集成页「同步状态」卡展示（不触发网络请求） */
  function status() {
    const cfg = cfgOf(getSettings());
    return {
      enabled: cfg.enabled,
      appReady: appReady(cfg),
      webhookReady: webhookReady(cfg),
      inbound: cfg.inbound,
      inboundRunning: !!inboundTimer,
      lastSyncAt: cfg.lastSyncAt,
      lastError: cfg.lastError,
      events: cfg.events,
      appId: cfg.appId,
      chatId: cfg.chatId,
      webhookUrl: cfg.webhookUrl,
      webhookSecretSet: !!cfg.webhookSecret,
      appSecretSet: !!cfg.appSecret,
      recent: recent.slice(0, 30),
    };
  }

  return {
    EVENTS,
    cfgOf, notify, pushReport, test, pollOnce,
    startInbound, stopInbound, refresh, status, resetSeen,
    notifyReady,   /* 渲染层就绪信号：回放排队中的群指令（宿主在 ready IPC 里接线） */
    /* 裸发群机器人：供「集成」页 Webhook 地址填了飞书机器人时复用（不要求开启飞书总开关） */
    sendRawWebhook: (url, body, opts) => feishu.sendWebhook(url, body, { secret: (opts && opts.secret) || '' }, { fetchImpl, now }),
    _enqueue: enqueue,
  };
}

/* ---------- Webhook 协议适配：地址是飞书机器人就转卡片 ---------- */
/* 判定：open.feishu.cn / open.larksuite.com 域名，或 /open-apis/bot/v2/hook/ 路径。
   仅此类地址改写协议，其它地址（企微、Slack、n8n、自建）保持原样 JSON POST */
function isFeishuHook(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  return /(^|\.)open\.feishu\.cn\//i.test(s) || /open\.larksuite\.com\//i.test(s) || /\/open-apis\/bot\/v2\/hook\//i.test(s);
}

/* 把 Reins 的通用事件 payload 转成飞书卡片（bot 加签需要富文本，纯 JSON 机器人只显示一行字） */
function webhookToFeishu(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const event = String(p.event || 'ping');
  const kindMap = {
    'task.created': 'created', 'task.done': 'done', 'task.rejected': 'rejected',
    'task.failed': 'failed', 'task.timeout': 'timeout',
  };
  const task = p.task || null;
  const meta = feishu.KIND_META;
  if (kindMap[event] && task) {
    return feishu.taskCard(kindMap[event], {
      key: task.key, title: task.title, status: task.status, pri: task.pri,
      pr: task.deliver || task.pr, assigneeName: task.assigneeName,
    }, { space: p.space, reason: p.reason });
  }
  if (event === 'report.weekly' || event === 'report.standup' || event === 'report.digest') {
    const label = event === 'report.weekly' ? '周报' : event === 'report.digest' ? '每日摘要' : '站会报告';
    return feishu.textCard(label + ' · ' + (p.space || 'Reins'), p.report || '', {
      meta: (p.schedule ? p.schedule + ' · ' : '') + new Date().toLocaleString('zh-CN', { hour12: false }),
      theme: event === 'report.weekly' ? 'violet' : 'turquoise',
    });
  }
  /* 其它事件：标题 + 一段人话，debug 信息折叠进 note */
  const info = meta.ping;
  const lines = [];
  if (p.text) lines.push(p.text);
  else {
    lines.push('**事件**：' + event);
    if (p.space) lines.push('**空间**：' + p.space);
    if (p.at) lines.push('**时间**：' + new Date(p.at).toLocaleString('zh-CN', { hour12: false }));
  }
  return feishu.card({
    title: info.icon + ' ' + info.label + ' · Reins',
    theme: info.theme,
    elements: [feishu.mdText(lines.join('\n')), feishu.noteLine('由 Reins Webhook 通道推送')],
  });
}

module.exports = { createFeishuBridge, isFeishuHook, webhookToFeishu, EVENTS };
