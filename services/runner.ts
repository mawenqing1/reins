/* ============================================================
   Reins — 真实 Agent 执行引擎
   通过 OpenAI 兼容协议（/chat/completions, SSE 流式）调用
   用户自备的模型服务（GLM / DeepSeek / Kimi / Qwen / OpenAI / 自定义）
   ============================================================ */

const PROVIDERS = {
  glm:     { label: '智谱 GLM',    baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  deepseek:{ label: 'DeepSeek',    baseURL: 'https://api.deepseek.com/v1',           model: 'deepseek-chat' },
  kimi:    { label: '月之暗面 Kimi', baseURL: 'https://api.moonshot.cn/v1',          model: 'moonshot-v1-32k' },
  qwen:    { label: '阿里通义',     baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  openai:  { label: 'OpenAI',      baseURL: 'https://api.openai.com/v1',             model: 'gpt-4o-mini' },
  custom:  { label: '自定义（OpenAI 兼容）', baseURL: '',                              model: '' },
};

const aborts = new Map();   // runKey -> AbortController；并行阶段用 taskId#阶段键 隔离（见 stageKeyOf）

/* 部分服务的 WAF 会按 TLS 指纹丢弃 Node 自带 fetch 的握手（表现为 connect timeout 而 curl 正常）。
   Electron 主进程优先用 net.fetch（Chromium 网络栈，浏览器级指纹），纯 Node 环境回退原生 fetch */
let _netFetch: any = null;
try { _netFetch = require('electron').net.fetch; } catch (e) { }
const pfetch = (...a) => (_netFetch || global.fetch)(...a);

/* 出站 HTTP 统一走共享层：429/5xx/网络超时自动重试（指数退避 + Retry-After）、
   无响应超时（AbortController，与用户取消共用通道）。见 services/http.js */
import http = require('./http');
const { fetchWithRetry } = http;

/* ---------- 模型参数（temperature / max_tokens / top_p）可配置 ----------
   优先级：任务级覆盖（高级选项）> 任务卡配置 > Agent 配置 > 设置页全局默认 > 内置默认。
   任一层给出非法值（非有限数/越界）直接回退下一层，坏配置绝不打断执行。
   字段名容错：maxTokens/max_tokens、topP/top_p 两种拼法都认 */
const MODEL_PARAM_DEFAULTS = { temperature: 0.6, maxTokens: 4096, topP: 1.0 };
const clampNum = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
function resolveModelParams(agent: any, task: any, override: any, defaults: any): any {
  const layers = [
    override || null,
    task && task.modelParams || null,
    agent && agent.modelParams || null,
    defaults || null,
    MODEL_PARAM_DEFAULTS,
  ];
  const pick = (keys, clamp) => {
    for (const layer of layers) {
      if (!layer) continue;
      for (const k of keys) {
        const raw = layer[k];
        if (raw === undefined || raw === null || raw === '') continue;
        const v = clamp(Number(raw));
        if (v !== null) return v;
      }
    }
    return null;   // 不可达：末层内置默认值恒合法，防御性保留
  };
  return {
    temperature: pick(['temperature'], v => clampNum(v, 0, 2)),
    maxTokens: pick(['maxTokens', 'max_tokens'], v => clampNum(Math.round(v), 1, 200000)),
    topP: pick(['topP', 'top_p'], v => clampNum(v, 0.01, 1)),
  };
}
/* OpenAI 兼容载荷字段名 */
const modelParamsBody = p => ({ temperature: p.temperature, max_tokens: p.maxTokens, top_p: p.topP });

/* 并行阶段的取消键：同一任务的多个阶段并发时各持独立键，取消任务时按前缀全量终止 */
const stageKeyOf = (task: any, stage: any): string => (stage && stage.key ? task.id + '#' + stage.key : task.id);

function buildMessages(task, extraPrompt, scenePrompt) {
  /* let：场景/角色设定要拼接到 sys 尾部（const 重赋值会让带角色提示词的 API 执行直接抛
     Assignment to constant variable——流水线角色 × API 引擎组合首次踩中） */
  let sys = [
    '你是团队任务看板中的执行 Agent。你收到一张任务卡片，请直接执行并给出交付物。',
    '要求：',
    '- 先给交付物本体（正文/方案/代码/结论，用 Markdown），再附不超过 5 行的执行说明。',
    '- 不要客套、不要复述任务；信息不足时做合理假设并注明「假设：…」。',
    '- 中文任务用中文交付。'
  ].join('\n');
  if (scenePrompt) sys += '\n【场景/角色设定】\n' + scenePrompt;
  const card = [
    `【任务】${task.key} · ${task.title}`,
    `【类型】${task.type}　【优先级】${task.pri}`,
    task.desc ? `【描述/验收标准】\n${task.desc}` : '【描述/验收标准】（无，按标题理解执行）',
    extraPrompt ? `【团队提示词】\n${extraPrompt}` : '',
  ].filter(Boolean).join('\n\n');

  const msgs = [{ role: 'system', content: sys }];
  // 打回重做：带上历史对话与用户反馈
  if (Array.isArray(task.thread) && task.thread.length) {
    msgs.push(...task.thread.map(m => ({ role: m.role, content: m.content })));
    msgs.push({ role: 'user', content: card + '\n\n（以上是此前对话。这是新一轮执行，请按最新要求给出完整交付物。）' });
  } else {
    msgs.push({ role: 'user', content: card });
  }
  return msgs;
}

/* 流式执行一个任务；onEvent(evt) 回调：
   {type:'start',...} {type:'delta',text} {type:'usage',usage} {type:'retry',retryNo,retries,delayMs,status,reason,text}
   {type:'done',result,usage,credits} {type:'error',message} {type:'cancelled'}
   opts：{ repoRoot, params(任务级模型参数覆盖), modelDefaults(全局默认), http:{timeoutMs,retries}, stage:{key,no} } */
async function runTask(task: any, agent: any, extraPrompt: any, onEvent: (evt: any) => void, opts: any = {}): Promise<void> {
  if (agent.mode === 'cli' && agent.acp) return runAcpSession(task, agent, extraPrompt, onEvent, opts);
  if (agent.mode === 'cli') return runCliTask(task, agent, extraPrompt, onEvent, opts);
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  const key = agent.apiKey || '';
  if (!baseURL || !key) { onEvent({ type: 'error', message: '未配置 baseURL 或 API Key，请在「设置 → 模型与密钥」补全。' }); return; }

  const params = modelParamsBody(resolveModelParams(agent, task, opts.params, opts.modelDefaults));
  const timeoutMs = Number.isFinite(opts.http && opts.http.timeoutMs) ? opts.http.timeoutMs : 120000;
  const retries = Number.isFinite(opts.http && opts.http.retries) ? opts.http.retries : 3;
  const runKey = stageKeyOf(task, opts.stage);
  const ac = new AbortController();
  aborts.set(runKey, ac);
  onEvent({ type: 'start', model, provider: provider.label, baseURL });

  /* 流内断流看门狗：响应已开始（拿到字节）后，每次收到数据重置计时；
     timeoutMs 内无任何字节（服务端挂起/连接静默死亡）→ 中止并如实报错。
     此时已有部分输出上屏，不重试（重放会重复输出），与出站前的"无响应超时可重试"分层处理 */
  let stalled = false;
  let watchdog = null;
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => { stalled = true; ac.abort(); }, timeoutMs);
  };

  try {
    const resp = await fetchWithRetry(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: buildMessages(task, extraPrompt, agent.scenePrompt),
        stream: true,
        stream_options: { include_usage: true },
        ...params,
      }),
    }, {
      fetchImpl: pfetch,
      signal: ac.signal,          // 用户取消与超时共用通道：取消即中止且不重试
      timeoutMs,
      retries,
      onRetry: info => onEvent({
        type: 'retry',
        retryNo: info.retryNo,
        retries: info.retries,
        delayMs: info.delayMs,
        status: info.status,
        reason: info.reason,
        text: '↻ ' + info.reason + '，' + Math.max(1, Math.round(info.delayMs / 1000)) + 's 后自动重试（第 ' + info.retryNo + '/' + info.retries + ' 次）',
      }),
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${text.slice(0, 300)}`);
    }

    let result = '';
    let usage = null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    armWatchdog();
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (stalled) throw new Error('响应流中断：超过 ' + Math.round(timeoutMs / 1000) + 's 无数据（已收到 ' + result.length + ' 字符，不自动重试避免重复输出）');
        throw e;
      }
      if (chunk.done) break;
      armWatchdog();
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch (e) { continue; }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { result += delta; onEvent({ type: 'delta', text: delta }); }
      }
    }
    if (watchdog) clearTimeout(watchdog);
    if (!result && usage) result = '（模型未返回内容）';
    onEvent({ type: 'done', result, usage });
  } catch (e: any) {
    if (e.name === 'AbortError' || ac.signal.aborted) {
      // 看门狗先置 stalled 再 abort；用户取消不会置 stalled——据此区分两种中止
      if (stalled) onEvent({ type: 'error', message: '响应流中断：超过 ' + Math.round(timeoutMs / 1000) + 's 无数据' });
      else onEvent({ type: 'cancelled' });
    }
    else onEvent({ type: 'error', message: e.message });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    aborts.delete(runKey);
  }
}

/* 取消一个任务的全部在途回合：并行阶段共用 taskId 前缀（taskId#阶段键），一次全停 */
function cancelTask(taskId: any): boolean {
  let hit = false;
  for (const k of Array.from(aborts.keys())) {
    if (k === taskId || k.startsWith(taskId + '#')) {
      const c = aborts.get(k);
      try { c.abort(); } catch (e) { }
      aborts.delete(k);
      hit = true;
    }
  }
  return hit;
}

/* 连通性测试：发一个极小请求（出站同样走重试层，但次数收紧：交互式等待不宜过长） */
async function testAgent(agent: any): Promise<any> {
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  if (!baseURL || !agent.apiKey) return { ok: false, message: '未配置 baseURL 或 API Key' };
  try {
    const resp = await fetchWithRetry(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + agent.apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping，请回复 pong' }], max_tokens: 8 }),
    }, { fetchImpl: pfetch, timeoutMs: 30000, retries: 1 });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 200) };
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    return { ok: true, message: `${model} 连接成功：${content.trim().slice(0, 20) || 'ok'}`, usage: data.usage };
  } catch (e: any) { return { ok: false, message: e.message }; }
}

/* AI 分诊：让 API Agent 对单个任务给出 类型/优先级/经办 建议（一次性调用，严格 JSON） */
async function triageTask(task: any, agent: any, roster: any): Promise<any> {
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  const key = agent.apiKey || '';
  if (!baseURL || !key) return { ok: false, message: '未配置 baseURL 或 API Key' };
  const sys = [
    '你是团队任务分诊助手。根据任务信息判断类型与优先级，并从给出的名单中挑选最合适的经办人。',
    '只输出一个 JSON 对象，不要任何其他文字、不要代码块标记。格式：',
    '{"type":"req|bug|support|test|chore|research|writing|data","pri":"P0|P1|P2","assignee":{"kind":"agent|role|human|null","id":"Agent或角色的id或null","name":"名字或null"},"reason":"一句话理由"}',
    '选不出合适经办人时 assignee 用 {"kind":"null","id":null,"name":null}。理由用中文。',
  ].join('\n');
  const agentList = (roster.agents || []).map(a => `◆${a.name}（id=${a.id}${a.mode === 'api' ? '，API 模型' : a.mode === 'cli' ? '，本机 CLI' : '，演示引擎'}）`).join('；') || '无';
  const roleList = (roster.roles || []).map(r => `☆${r.name}（kind=role，id=${r.id}，AI 角色 · 用 ${r.agentName || 'Agent'} 执行，自带专属提示词）`).join('；') || '无';
  const memberList = (roster.members || []).join('、') || '无';
  const card = [
    `【任务】${task.key} · ${task.title}`,
    `【当前标记】类型 ${task.type}　优先级 ${task.pri}`,
    task.desc ? `【描述】\n${task.desc}` : '【描述】（无）',
    `【可选经办】Agent：${agentList}。AI 角色：${roleList}。团队成员：${memberList}。`,
  ].join('\n\n');
  try {
    const resp = await fetchWithRetry(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: card }], temperature: 0.2, max_tokens: 300 }),
    }, { fetchImpl: pfetch });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 150) };
    const data = await resp.json();
    let raw = String(data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const sug = JSON.parse(m ? m[0] : raw);
    const TYPES = ['req', 'bug', 'support', 'test', 'chore', 'research', 'writing', 'data'];
    const asg = sug.assignee;
    return {
      ok: true,
      suggestion: {
        type: TYPES.includes(sug.type) ? sug.type : 'chore',
        pri: ['P0', 'P1', 'P2'].includes(sug.pri) ? sug.pri : 'P2',
        assignee: asg && asg.kind === 'agent' && asg.id ? { kind: 'agent', id: String(asg.id), name: String(asg.name || '') }
          : asg && asg.kind === 'role' && asg.id ? { kind: 'role', id: String(asg.id), name: String(asg.name || '') }
          : asg && asg.kind === 'human' && asg.name ? { kind: 'human', name: String(asg.name) } : null,
        reason: String(sug.reason || '').slice(0, 120),
      },
      engine: model, usage: data.usage || null,
    };
  } catch (e: any) { return { ok: false, message: e.message }; }
}

/* ---------- 流水线（虚拟团队）：项目经理的两个结构化决策点 ----------
   planPipeline：拿到任务卡后把流程拆成阶段链（谁做/做什么/什么顺序）
   judgePipelineGate：QA 报告出来后裁决——通过交付，还是打回谁改、改什么
   与 triageTask 同款一次性 API 调用（严格 JSON）；agent 须为 API 模式 */
const PIPELINE_ROLE_KEYS = {
  pmgr: '项目经理（总控：拆解流程、分配成员、裁决测试结果、汇总交付）',
  pm: '产品经理（产品文档：背景/目标/用户故事/验收标准）',
  be: '后端开发（接口、数据模型与业务逻辑实现）',
  fe: '前端开发（页面与交互实现）',
  qa: '测试工程师（测试用例与执行、测试报告）',
  ui: 'UI 设计师（视觉与布局方案）',
  doc: '技术文档（README/变更说明）',
};
async function planPipeline(task: any, agent: any): Promise<any> {
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  const key = agent.apiKey || '';
  if (!baseURL || !key) return { ok: false, message: '规划引擎未配置 baseURL 或 API Key' };
  const sys = [
    '你是项目经理。把用户的任务拆成一条可执行的流水线，每个阶段指定一个负责角色，并声明阶段间依赖。',
    '可用角色（roleKey → 职责）：',
    ...Object.entries(PIPELINE_ROLE_KEYS).map(([k, v]) => '- ' + k + '：' + v),
    '规则：研发类任务的标准链是 产品文档(pm) → 后端(be) → 前端(fe) → 测试(qa)；可按任务性质增删（如纯文案任务不需要 be/fe/qa）。交付阶段由系统自动追加（项目经理汇总），不要输出。',
    '依赖声明：默认串行——每个阶段 dependsOn 填它所依赖阶段的序号数组（第 1 个阶段填 []，第 3 个阶段若依赖第 1、2 个阶段填 [1,2]）。只有当两个阶段确实互不依赖、可以同时开工时（例如后端与前端可并行），才让其中一方只依赖共同的上游（如后端与前端都只填 [1]）。',
    '只输出一个 JSON 对象，不要任何其他文字、不要代码块标记。格式：',
    '{"stages":[{"roleKey":"pm","name":"产品文档","goal":"这一阶段要产出什么（一句话）","dependsOn":[]}],"reason":"一句话拆分理由"}',
    '阶段数量 2-6 个；name 与 goal 用中文，简洁；dependsOn 用阶段序号数组（从 1 开始）。',
  ].join('\n');
  const lastUser = (Array.isArray(task.thread) ? task.thread : []).filter(m => m && m.role === 'user').pop();
  const card = [
    `【任务】${task.key} · ${task.title}`,
    `【类型】${task.type}　【优先级】${task.pri}`,
    task.desc ? `【描述/验收标准】\n${task.desc}` : '【描述/验收标准】（无，按标题理解）',
    lastUser ? `【用户最新反馈】\n${lastUser.content}` : '',
  ].filter(Boolean).join('\n\n');
  try {
    const resp = await fetchWithRetry(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: card }], temperature: 0.3, max_tokens: 600 }),
    }, { fetchImpl: pfetch });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 150) };
    const data = await resp.json();
    let raw = String(data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const sug = JSON.parse(m ? m[0] : raw);
    /* dependsOn 清洗 + 稳定阶段 id（'s'+序号）：PM 输出的依赖序号不可信，
       越界/自引用剔除；未声明 dependsOn 的历史结构原样透传（渲染层按串行处理） */
    const stages = (Array.isArray(sug.stages) ? sug.stages : [])
      .map(s => ({ roleKey: String(s.roleKey || '').trim(), name: String(s.name || '').trim().slice(0, 24), goal: String(s.goal || '').trim().slice(0, 160), dependsOn: s.dependsOn }))
      .filter(s => PIPELINE_ROLE_KEYS[s.roleKey])
      .slice(0, 6);
    const total = stages.length;
    const withDeps = stages.map((s, i) => {
      const id = 's' + (i + 1);
      if (!Array.isArray(s.dependsOn)) return { ...s, id };   // 未声明依赖：保持无字段（串行兼容）
      const deps = [];
      for (let d of s.dependsOn) {
        const n = parseInt(d, 10);
        if (Number.isFinite(n) && n >= 1 && n <= total && n !== i + 1 && !deps.includes('s' + n)) deps.push('s' + n);
      }
      return { ...s, id, dependsOn: deps };
    });
    if (!withDeps.length) return { ok: false, message: '拆分结果中没有可用阶段' };
    return { ok: true, stages: withDeps, reason: String(sug.reason || '').slice(0, 160), engine: model, usage: data.usage || null };
  } catch (e: any) { return { ok: false, message: e.message }; }
}

async function judgePipelineGate(task: any, agent: any, { qaReport, round, maxRework, prevFeedback }: any): Promise<any> {
  const provider = PROVIDERS[agent.provider] || PROVIDERS.custom;
  const baseURL = (agent.baseURL || provider.baseURL).replace(/\/+$/, '');
  const model = agent.model || provider.model;
  const key = agent.apiKey || '';
  if (!baseURL || !key) return { ok: false, message: '裁决引擎未配置 baseURL 或 API Key' };
  const sys = [
    '你是项目经理。测试工程师刚提交测试报告，你来裁决下一步。',
    '只输出一个 JSON 对象，不要任何其他文字、不要代码块标记。格式：',
    '{"action":"pass"|"rework","targets":["be","fe"],"feedback":"交付遗留清单或修改要求","evidence":"打回依据","reason":"一句话理由"}',
    '硬规则（违反即错误裁决）：',
    '- rework 的唯一依据是测试报告中【明确执行失败/未通过的用例或验收项】。报告断言全部通过、只列风险提示/优化建议时，必须输出 pass——风险提示属于交付遗留清单（写入 feedback），永远不算缺陷。外部依赖类风险（API 可用性、额度、ffmpeg 缺失、环境差异）更不算。',
    '- action=rework 时 evidence 必须逐条引用报告中失败项的编号与内容；引用不出失败项的打回是无效裁决。',
    '- pass 时 targets 为空数组，feedback 汇总遗留风险/建议供交付总结引用。',
    '- targets 从 "pm","be","fe" 中选（文档问题 pm，后端 be，前端 fe，可多选）。',
    `当前第 ${round} 轮，返工上限 ${maxRework} 轮${round >= maxRework - 1 ? '，已是最后机会：除非存在真正的阻塞性失败项，否则应 pass 并把剩余问题列入遗留清单' : ''}。`,
  ].join('\n');
  const card = [
    `【任务】${task.key} · ${task.title}`,
    `【描述/验收标准】\n${task.desc || '（无）'}`,
    prevFeedback ? `【上一轮（第 ${Math.max(1, round - 1)} 轮）打回意见】${prevFeedback}\n（仅当本报告显示这些问题仍未解决、或出现了新的失败项时才可再次 rework；已修复的不要重复打回）` : '',
    `【测试报告（第 ${round} 轮）】\n${String(qaReport || '').slice(0, 8000)}`,
  ].filter(Boolean).join('\n\n');
  try {
    const resp = await fetchWithRetry(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: card }], temperature: 0.2, max_tokens: 500 }),
    }, { fetchImpl: pfetch });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 150) };
    const data = await resp.json();
    let raw = String(data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const sug = JSON.parse(m ? m[0] : raw);
    const action = sug.action === 'rework' ? 'rework' : 'pass';
    const targets = (Array.isArray(sug.targets) ? sug.targets : []).map(t => String(t).trim()).filter(t => ['pm', 'be', 'fe'].includes(t));
    return {
      ok: true,
      verdict: {
        action: action === 'rework' && targets.length ? 'rework' : 'pass',
        targets: action === 'rework' ? targets : [],
        feedback: String(sug.feedback || '').slice(0, 600),
        evidence: String(sug.evidence || '').slice(0, 400),
        reason: String(sug.reason || '').slice(0, 160),
      },
      engine: model, usage: data.usage || null,
    };
  } catch (e: any) { return { ok: false, message: e.message }; }
}

/* ---------- Jev 决策模型（System One：state + 类型化问题 → 结构化判断 + 概率，用于分诊等高频判别） ---------- */
const JEV_TYPES = {
  req: '新功能、接口、页面、配置类开发需求',
  bug: '报错、异常、崩溃、数据丢失等需要修复的缺陷',
  support: '客户咨询、工单、投诉、售后回复',
  test: '测试用例、回归、冒烟、端到端验证',
  chore: '无明显专业特征的琐碎整理、杂务',
  research: '调研、竞品分析、行业研究、信息收集',
  writing: '文案、文章、初稿、周报等内容创作',
  data: '数据清洗、整理、核对、表格处理',
};
/* 出站与 API Agent 同走共享重试层（429/5xx/无响应超时可重试，尊重 Retry-After）；
   保留 15s 短超时（决策模型应秒级返回），retries=2 平衡交互等待与瞬态容错 */
async function callJev(cfg, state, questions, opts: any = {}) {
  const url = String(cfg.jevUrl || 'https://api.typesafe.ai/v1/systemone').trim().replace(/\/+$/, '');
  if (!cfg.jevKey) return { ok: false, message: '未配置 Jev API Key' };
  if (!/^https?:\/\//.test(url)) return { ok: false, message: 'Jev 地址需以 http:// 或 https:// 开头' };
  try {
    const resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.jevKey },
      body: JSON.stringify({ state, model: cfg.jevModel || 'jev-latest', questions }),
    }, {
      fetchImpl: opts.fetchImpl || pfetch,
      timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15000,
      retries: Number.isFinite(opts.retries) ? opts.retries : 2,
    });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}：` + (await resp.text().catch(() => '')).slice(0, 150) };
    const data = await resp.json();
    if (!data || !data.answers) return { ok: false, message: '响应缺少 answers 字段，请确认接入地址正确' };
    return { ok: true, data };
  } catch (e: any) { return { ok: false, message: e.message + (e.cause && e.cause.code ? '（' + e.cause.code + '）' : '') }; }
}
async function triageJev(task: any, roster: any, cfg: any, opts: any = {}): Promise<any> {
  const agents = ((roster && roster.agents) || []).slice(0, 200);
  const roles = ((roster && roster.roles) || []).slice(0, 100);
  const members = ((roster && roster.members) || []).slice(0, Math.max(0, 240 - agents.length - roles.length));
  const cand = { none: '以上都不合适，保持未指派待人工处理' };
  const idx = {};
  agents.forEach(a => { const k = 'a' + a.id; cand[k] = `${a.name}（${a.mode === 'api' ? 'API 模型' : a.mode === 'cli' ? '本机 CLI' : '演示引擎'}）`; idx[k] = { kind: 'agent', id: a.id, name: a.name }; });
  roles.forEach(r => { const k = 'ro' + r.id; cand[k] = `☆ ${r.name}（AI 角色 · 用 ${r.agentName || 'Agent'} 执行，自带专属提示词）`; idx[k] = { kind: 'role', id: r.id, name: r.name }; });
  members.forEach(n => { const k = 'm' + n; cand[k] = `${n}（团队成员）`; idx[k] = { kind: 'human', name: n }; });
  const state = [
    `【任务】${task.key} · ${task.title}`,
    `【当前标记】类型 ${task.type}　优先级 ${task.pri}`,
    task.desc ? `【描述】\n${task.desc}` : '【描述】（无）',
    `【候选经办】${Object.keys(cand).filter(k => k !== 'none').map(k => cand[k]).join('、') || '无'}`,
  ].join('\n\n');
  const r = await callJev(cfg, state, {
    type: { type: 'choice', instructions: '判断这条任务的所属类型', criteria: JEV_TYPES },
    pri: { type: 'choice', instructions: '判断处理优先级', criteria: { P0: '线上事故、紧急、需立即处理', P1: '重要或有明确时限，应尽快安排', P2: '常规事项，按正常排期处理' } },
    assignee: { type: 'choice', instructions: '从候选人中挑选最合适的经办人', criteria: cand },
  }, opts);
  if (!r.ok) return r;
  const ans = r.data.answers;
  const type = Object.keys(JEV_TYPES).includes(ans.type && ans.type.choice) ? ans.type.choice : 'chore';
  const pri = ['P0', 'P1', 'P2'].includes(ans.pri && ans.pri.choice) ? ans.pri.choice : 'P2';
  const ak = ans.assignee && ans.assignee.choice;
  const assignee = idx[ak] ? { ...idx[ak] } : null;
  const pct = v => Math.round((Number(v) || 0) * 100);
  const reason = `决策概率：类型 ${type} ${pct(ans.type?.probabilities?.[type])}% · 优先级 ${pri} ${pct(ans.pri?.probabilities?.[pri])}% · 经办 ${assignee ? assignee.name : '待指派'} ${pct(ans.assignee?.probabilities?.[ak])}%`.slice(0, 150);
  return {
    ok: true,
    suggestion: { type, pri, assignee, reason },
    engine: r.data.model || cfg.jevModel || 'jev-latest',
    usage: r.data.usage ? { total_tokens: (r.data.usage.input_tokens || 0) + (r.data.usage.output_tokens || 0) } : null,
  };
}
async function testJev(cfg: any, opts: any = {}): Promise<any> {
  const r = await callJev(cfg, '这是一条来自 Reins的连通性测试消息。', {
    ping: { type: 'noul', instructions: '这句话表达了一个测试断言' },
  }, opts);
  if (!r.ok) return r;
  const mdl = r.data.model || cfg.jevModel || 'jev';
  const brand = /startlux/i.test(mdl) ? 'StartLux' : /^jev/i.test(mdl) ? 'Jev' : '决策引擎';
  const p = r.data.answers?.ping?.noul;
  return { ok: true, message: `${brand} 连接成功（${mdl}）· 测试断言概率 ${typeof p === 'number' ? Math.round(p * 1000) / 1000 : 'ok'}` };
}

/* managed-runtimes（借鉴统一运行时层）：扫描本机已安装应用自带的 Agent 运行时，
   生成"免安装即可接入"的预置（绝对路径 + 配套 node）。机器上装了什么就发现什么。
   注意：模板经 splitTplArgs 解析，含空格的路径须加双引号 */
function discoverAppRuntimes(): any[] {
  const fs = require('fs'), path = require('path'), os = require('os');
  const found = [];
  const exists = p => { try { return fs.existsSync(p); } catch (e) { return false; } };
  const home = os.homedir();
  const nodeBin = bestNodeDir() ? path.join(bestNodeDir(), 'node') : 'node';
  // 语义化版本比较（'22.22.2-6' > '20.18.0'），用于"取最新"类目录扫描
  const cmpVer = (a, b) => {
    const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  // 在指定目录里按版本号命名的子目录中挑最新的满足条件项
  const newest = (dir, filter) => {
    try {
      return fs.readdirSync(dir).filter(filter).sort(cmpVer).reverse()[0] || null;
    } catch (e) { return null; }
  };

  // ZCode 桌面应用内置无头 CLI（app-server 协议；上游 headless 回归修复后即可执行）
  const zcodeCjs = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  if (exists(zcodeCjs)) {
    found.push({
      id: 'zcode-app', label: 'ZCode（应用内置）', cliId: 'zcode', detected: true,
      cliCommand: nodeBin, cliTemplate: `${nodeBin} ${zcodeCjs} -p {prompt} --no-color`,
      note: '检测到 ZCode.app 内置 CLI，已配好配套 Node',
    });
  }

  // WorkBuddy 桌面应用包内自带 CLI 引擎（app.asar.unpacked/cli/bin/codebuddy）+ 随应用分发的 node，
  // 需 CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 固定 lite-wb 变体（应用包未带完整 TUI 产物）
  const wbCli = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
  const wbNodeVer = newest(path.join(home, '.workbuddy/binaries/node/versions'), d => exists(path.join(home, '.workbuddy/binaries/node/versions', d, 'bin', 'node')));
  if (exists(wbCli) && wbNodeVer) {
    const wbNode = path.join(home, '.workbuddy/binaries/node/versions', wbNodeVer, 'bin', 'node');
    found.push({
      id: 'workbuddy-app', label: 'WorkBuddy（应用内置）', cliId: 'workbuddy', detected: true,
      cliCommand: wbNode, cliTemplate: `${wbNode} ${wbCli} -y -p {prompt} --output-format text`,
      cliEnv: { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' },
      note: `检测到 WorkBuddy.app 内置 CLI 引擎 + 自带 Node ${wbNodeVer}，绝对路径直连`,
    });
  }

  // CodeBuddy 无头 CLI 是独立 npm 包（@tencent-ai/codebuddy-code），桌面应用包内不含。
  // 优先用安装器维护的稳定垫片 ~/.local/bin/codebuddy（npm 包原地升级垫片不变，HiFox 同款策略），
  // 垫片缺再用 lib 包路径 + node 兜底
  const cbcShim = path.join(home, '.local/bin/codebuddy');
  const cbcJs = path.join(home, '.local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy');
  if (exists(cbcShim)) {
    found.push({
      id: 'codebuddy-cli', label: 'CodeBuddy（本机 CLI）', cliId: 'codebuddy', detected: true,
      cliCommand: cbcShim, cliTemplate: `${cbcShim} -y -p {prompt} --output-format text`,
      note: '检测到 CodeBuddy Code CLI，走稳定入口直连（升级不改路径）',
    });
  } else if (exists(cbcJs)) {
    found.push({
      id: 'codebuddy-cli', label: 'CodeBuddy（本机 CLI）', cliId: 'codebuddy', detected: true,
      cliCommand: nodeBin, cliTemplate: `${nodeBin} ${cbcJs} -y -p {prompt} --output-format text`,
      note: '检测到 CodeBuddy Code CLI（npm 包），绝对路径直连',
    });
  }

  // Qoder 家族两条独立线路（对齐 HiFox 的 qoder / qoder-cn 双 agent）：
  // 国际版 qodercli、CN 版 qoderclicn。都优先官方稳定垫片 ~/.local/bin/<name>（跨版本不变），
  // 垫片缺失再扫 ~/.qoder[-cn]/bin 下的版本目录（仅此情形会拿到带版本号的路径）
  const qEntry = (binPath, cn, note) => ({
    id: cn ? 'qodercn-cli' : 'qoder-cli',
    label: cn ? 'Qoder CN（本机 CLI）' : 'Qoder（本机 CLI）',
    cliId: cn ? 'qoder-cn' : 'qoder', detected: true,
    /* accept_edits：无头 -p 模式下默认权限档会拒掉全部文件写入（需交互确认），
       PM/文档阶段的产物因此落不了盘只能走正文兜底；编辑类写入放行——执行本身在
       隔离 worktree（独立分支，验收后才应用回仓库），风险已被工作区隔离兜住 */
    cliCommand: binPath, cliTemplate: `${binPath} -p {prompt} --permission-mode accept_edits`, note,
  });
  const qIntlShim = path.join(home, '.local/bin/qodercli');
  const qIntlVer = newest(path.join(home, '.qoder/bin/qodercli'), f => /^qodercli-[\d.]+$/.test(f));
  const qIntl = exists(qIntlShim) ? qIntlShim : (qIntlVer && path.join(home, '.qoder/bin/qodercli', qIntlVer));
  if (qIntl) found.push(qEntry(qIntl, false, '检测到 Qoder CLI，走稳定入口直连（升级不改路径）'));
  const qcnShim = path.join(home, '.local/bin/qoderclicn');
  const qcnVer = newest(path.join(home, '.qoder-cn/bin/qoderclicn'), f => /^qoderclicn-[\d.]+$/.test(f));
  const qcn = exists(qcnShim) ? qcnShim : (qcnVer && path.join(home, '.qoder-cn/bin/qoderclicn', qcnVer));
  if (qcn) found.push(qEntry(qcn, true, '检测到 Qoder CN CLI（qoderclicn），走稳定入口直连'));

  // Codex：ChatGPT 桌面应用包内置 codex 二进制（HiFox 发现层的 macOsChatGptApp 同款探测位）
  const codexBin = '/Applications/ChatGPT.app/Contents/Resources/codex';
  if (exists(codexBin)) {
    found.push({
      id: 'codex-app', label: 'Codex（ChatGPT.app 内置）', cliId: 'codex', detected: true,
      cliCommand: codexBin, cliTemplate: `${codexBin} exec --skip-git-repo-check {prompt}`,
      note: '检测到 ChatGPT.app 内置 Codex CLI，应用路径稳定直连',
    });
  }

  /* ACP 会话运行时（Agent Client Protocol，照抄 HiFox 适配器层架构）：
     统一会话协议（ndjson JSON-RPC over stdio）替代各家 CLI 模板 spawn */
  // codebuddy 家族原生 --acp（帮助原文：stdin/stdout using ndJsonStream）
  if (exists(cbcShim)) {
    found.push({
      id: 'codebuddy-acp', label: 'CodeBuddy（ACP 会话）', cliId: 'codebuddy', detected: true,
      acp: { cmd: cbcShim, args: ['--acp', '--permission-mode', 'acceptEdits'] },
      cliCommand: cbcShim, cliTemplate: `ACP 会话 · ${cbcShim} --acp（统一协议，不走命令模板）`,
      note: '原生 ACP 模式：权限请求结构化上屏、会话可取消（HiFox 同款架构）',
    });
  }
  // 本机已装的 HiFox ACP 适配器（zcode/codex/claude）同协议直接复用：哈希目录内 <name>.cjs + 自带 node
  const hfRoot = path.join(home, '.hifox/managed-runtimes');
  if (process.platform === 'darwin' && exists(hfRoot)) {
    const hfNodeVer = newest(path.join(hfRoot, 'node'), d => exists(path.join(hfRoot, 'node', d, 'darwin-' + process.arch, 'bin', 'node')));
    const hfNode = hfNodeVer && path.join(hfRoot, 'node', hfNodeVer, 'darwin-' + process.arch, 'bin', 'node');
    const hfAdapter = name => {
      try {
        const dir = path.join(hfRoot, name);
        const h = fs.readdirSync(dir).find(x => exists(path.join(dir, x, name + '.cjs')));
        return h && path.join(dir, h, name + '.cjs');
      } catch (e) { return null; }
    };
    if (hfNode && hfAdapter('zcode-acp') && exists('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')) {
      found.push({
        id: 'zcode-acp', label: 'ZCode（ACP · HiFox 适配器）', cliId: 'zcode', detected: true,
        acp: { cmd: hfNode, args: [hfAdapter('zcode-acp')] },
        cliCommand: hfNode, cliTemplate: `ACP 会话 · zcode-acp 适配器（统一协议，不走命令模板）`,
        note: '复用本机 HiFox 的 zcode ACP 适配器；zcode 上游 headless 缺陷仍可能影响执行',
      });
    }
    if (hfNode && hfAdapter('codex-acp') && exists(codexBin)) {
      found.push({
        id: 'codex-acp', label: 'Codex（ACP · HiFox 适配器）', cliId: 'codex', detected: true,
        acp: { cmd: hfNode, args: [hfAdapter('codex-acp')] },
        cliCommand: hfNode, cliTemplate: `ACP 会话 · codex-acp 适配器（统一协议，不走命令模板）`,
        note: '复用本机 HiFox 的 codex ACP 适配器；需 ChatGPT.app 运行中（本地 8327 服务）',
      });
    }
  }

  return found;
}

/* （原 module.exports 在此；全量合并导出见文件末尾的 export = 语句） */

/* ============================================================
   本机 CLI Agent 执行（Claude Code / Codex / CodeBuddy …）
   通过命令模板 {prompt} 占位，spawn 子进程并流式读取 stdout
   ============================================================ */
import cp = require('child_process');
const { spawn, spawnSync } = cp;
import os = require('os');

const CLI_PRESETS: any[] = [
  { id: 'claude-code', label: 'Claude Code', cmd: 'claude', template: 'claude -p {prompt} --output-format text', streamJson: true, install: 'curl -fsSL https://claude.ai/install.sh | bash', modelFlag: '--model' },
  { id: 'codex', label: 'Codex CLI', cmd: 'codex', template: 'codex exec --skip-git-repo-check {prompt}', install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', modelFlag: '-m' },
  { id: 'codebuddy', label: '腾讯 CodeBuddy Code', cmd: 'codebuddy', template: 'codebuddy -y -p {prompt} --output-format text', streamJson: true, install: 'npm install -g @tencent-ai/codebuddy-code', modelFlag: '--model' },
  { id: 'workbuddy', label: '腾讯 WorkBuddy', cmd: 'workbuddy', template: 'workbuddy -y -p {prompt} --output-format text', modelFlag: '--model' },
  { id: 'zcode', label: 'ZCode', cmd: 'zcode', template: 'zcode -p {prompt} --no-color' },
  { id: 'opencode', label: 'OpenCode', cmd: 'opencode', template: 'opencode run {prompt}', install: 'curl -fsSL https://opencode.ai/install | bash' },
  { id: 'gemini-cli', label: 'Gemini CLI', cmd: 'gemini', template: 'gemini {prompt}', install: 'npm install -g @google/gemini-cli' },
  { id: 'cursor-cli', label: 'Cursor CLI', cmd: 'cursor-agent', template: 'cursor-agent {prompt}', install: 'curl https://cursor.com/install -fsS | bash' },
  { id: 'qwen-code', label: 'Qwen Code', cmd: 'qwen', template: 'qwen {prompt}', install: 'npm install -g @qwen-code/qwen-code@latest' },
  { id: 'copilot', label: 'GitHub Copilot CLI', cmd: 'copilot', template: 'copilot -p {prompt}', install: 'npm install -g @github/copilot' },
  { id: 'droid', label: 'Droid', cmd: 'droid', template: 'droid {prompt}', install: 'curl -fsSL https://app.factory.ai/cli | sh' },
  { id: 'amp', label: 'Amp', cmd: 'amp', template: 'amp {prompt}' },
  { id: 'openclaw', label: 'OpenClaw', cmd: 'openclaw', template: 'openclaw {prompt}', install: 'curl -fsSL https://openclaw.ai/install.sh | bash' },
  { id: 'cline', label: 'Cline', cmd: 'cline', template: 'cline {prompt}', install: 'npm install -g cline' },
  { id: 'goose', label: 'Goose', cmd: 'goose', template: 'goose run {prompt}', install: 'brew install block-goose-cli' },
  { id: 'grok', label: 'Grok CLI', cmd: 'grok', template: 'grok {prompt}', install: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
  { id: 'kimi-cli', label: 'Kimi CLI', cmd: 'kimi', template: 'kimi -p {prompt}', install: 'npm install -g @moonshot-ai/kimi-code' },
  { id: 'kilo', label: 'Kilo Code', cmd: 'kilo', template: 'kilo {prompt}', install: 'npm install -g @kilocode/cli' },
  { id: 'kiro', label: 'Kiro', cmd: 'kiro', template: 'kiro {prompt}', install: 'curl -fsSL https://cli.kiro.dev/install | bash' },
  { id: 'trae', label: 'Trae', cmd: 'trae', template: 'trae {prompt}', install: 'sh -c "$(curl -fsSL https://trae.cn/trae-cli/install_v2.sh)"' },
  { id: 'qoder', label: 'Qoder', cmd: 'qodercli', template: 'qodercli -p {prompt}', streamJson: true, install: 'npm install -g @qoder-ai/qodercli', modelFlag: '-m', modelListFlag: '--list-models' },
  { id: 'qoder-cn', label: 'Qoder CN', cmd: 'qoderclicn', template: 'qoderclicn -p {prompt}', streamJson: true, install: 'npm install -g @qodercn-ai/qoderclicn', modelFlag: '-m', modelListFlag: '--list-models' },
  { id: 'auggie', label: 'Auggie', cmd: 'auggie', template: 'auggie {prompt}', install: 'npm install -g @augmentcode/auggie' },
  { id: 'qwenpaw', label: 'QwenPaw', cmd: 'qwenpaw', template: 'qwenpaw {prompt}', install: 'pip install qwenpaw' },
  { id: 'hermes', label: 'Hermes', cmd: 'hermes', template: 'hermes {prompt}', install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash' },
  { id: 'pi', label: 'Pi', cmd: 'pi', template: 'pi {prompt}', install: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent' },
];

/* 无头模式模型参数（preset.modelFlag 逐个实测标注）：
   codebuddy/workbuddy --model（0.16 系实测）；qoder/qoder-cli 家族 -m 且支持 --list-models；
   codex -m；claude --model。CLI_MODEL_FLAG 旧表保留兜底 */
const CLI_MODEL_FLAG = { codebuddy: '--model', workbuddy: '--model' };
const cliModelArgs = agent => {
  const p = CLI_PRESETS.find(x => x.id === agent.cliId) || {};
  const flag = p.modelFlag || CLI_MODEL_FLAG[agent.cliId];
  const m = String(agent.cliModel || '').trim();
  return flag && m ? [flag, m] : [];
};

/* codebuddy/workbuddy 引擎支持列表（帮助原文标注，无 --list-models 类命令，静态维护） */
const CLI_STATIC_MODELS = { codebuddy: true, workbuddy: true };
const _modelCache = new Map(); // cliId → { at, list }
/* 取某 Agent 可用模型列表（任务指派时的模型下拉用）：
   - qoder 家族：CLI 自带 --list-models，实时拉取（5 分钟缓存）
   - codebuddy/workbuddy：静态表（渲染层 CB_MODELS 同源）
   - 其余/ACP 会话：空表（渲染层回退为可自由输入） */
async function listAgentModels(agent: any): Promise<any> {
  if (!agent || agent.mode !== 'cli' || agent.acp) return [];
  const p = CLI_PRESETS.find(x => x.id === agent.cliId) || {};
  if (CLI_STATIC_MODELS[agent.cliId]) return ['hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'space-bunny', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3-pay', 'minimax-m2.7', 'kimi-k3-2', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'];
  if (!p.modelListFlag) return [];
  const cached = _modelCache.get(agent.cliId);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.list;
  // 命令解析优先级：Agent 配置的绝对路径（运行时卡接入）> 预设命令名（走登录 shell PATH）
  const fs = require('fs');
  let cmd = agent.cliCommand;
  if (!cmd || !cmd.includes('/') || !fs.existsSync(cmd)) cmd = p.cmd;
  const pathEnv = loginPath() ? loginPath() + ':' + (process.env.PATH || '') : process.env.PATH;
  const r = spawnSync(cmd, [p.modelListFlag], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: pathEnv, NO_COLOR: '1' } });
  const list = String(r.stdout || '').split('\n').map(l => l.trim()).filter(l => l && l !== 'MODEL' && !/^(Available|可用)/i.test(l)).slice(0, 60);
  if (list.length) _modelCache.set(agent.cliId, { at: Date.now(), list });
  return list;
}
const cliRunLabel = (cmd, agent) => cmd + (String(agent.cliModel || '').trim() ? ' · ' + String(agent.cliModel).trim() : '');

// GUI 进程 PATH 常缺 homebrew 等用户目录，登录 shell 取一次补齐
let fixedPath: any = null;
function loginPath() {
  if (fixedPath) return fixedPath;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-ilc', 'echo $PATH'], { encoding: 'utf8', timeout: 8000 });
    if (r.stdout) fixedPath = r.stdout.trim();
  } catch (e) { }
  return fixedPath;
}
function detectClis(cmds: any): any {
  const pathEnv = loginPath() ? loginPath() + ':' + (process.env.PATH || '') : process.env.PATH;
  const found = {};
  for (const c of cmds) {
    try {
      const r = spawnSync('/bin/sh', ['-c', 'command -v ' + JSON.stringify(c)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: pathEnv } });
      found[c] = r.status === 0 && !!r.stdout.trim();
    } catch (e) { found[c] = false; }
  }
  return found;
}

function buildCliPrompt(task, extraPrompt, scenePrompt) {
  const parts = [];
  parts.push(`【任务】${task.key} · ${task.title}\n【类型】${task.type}　【优先级】${task.pri}`);
  if (task.desc) parts.push(`【描述/验收标准】\n${task.desc}`);
  if (scenePrompt) parts.push(`【场景要求】\n${scenePrompt}`);
  if (extraPrompt) parts.push(`【团队提示词】\n${extraPrompt}`);
  parts.push('【工作方式】直接动手：在当前工作目录里把任务真正做完——创建/修改代码、文档、配置文件，需要时运行命令验证。不要只写说明文字，不要把成果只放在回复里。');
  if (Array.isArray(task.thread) && task.thread.length) {
    parts.push('【此前对话】\n' + task.thread.map(m => (m.role === 'user' ? '用户: ' : 'Agent: ') + m.content).join('\n---\n'));
    parts.push('（以上是此前对话，请按最新反馈继续实际修改文件并完成交付。）');
  }
  parts.push('【完成后输出】改动报告：逐个列出你创建/修改的文件路径 + 一句话说明改了什么；如有运行验证，附上结果。除此之外不要多余解释。');
  return parts.join('\n\n');
}

/* 恢复会话续跑提示词（借鉴 HiFox handoffFile 的精简交接）：引擎侧已带完整会话上下文
   （ACP session/load），只给任务卡 + 最新一轮要求，不重喂全量历史 */
function buildResumePrompt(task, extraPrompt, scenePrompt) {
  const parts = [];
  parts.push(`【任务】${task.key} · ${task.title}\n【类型】${task.type}　【优先级】${task.pri}`);
  if (scenePrompt) parts.push(`【场景要求】\n${scenePrompt}`);
  if (extraPrompt) parts.push(`【团队提示词】\n${extraPrompt}`);
  const lastUser = (Array.isArray(task.thread) ? task.thread : []).filter(m => m && m.role === 'user').pop();
  parts.push('【本轮要求】会话上下文已恢复，此前交付与反馈你都已知晓。请直接按以下最新要求继续修改并完成交付：\n'
    + (lastUser ? lastUser.content.replace(/^【验收反馈】/, '').trim() : '按原任务要求继续完善交付。'));
  parts.push('【完成后输出】改动报告：逐个列出本轮你创建/修改的文件路径 + 一句话说明改了什么；如有运行验证，附上结果。');
  return parts.join('\n\n');
}

/* CLI 家族（codebuddy/zcode 等）要求 node ≥18.20，而系统 PATH 可能只有旧版或垫片丢失——
   给子进程固定垫一个可用 node 目录（优先 18–23：兼容 zcode bundle；其次任意 ≥18），缓存一次 */
let _bestNodeDir;
function bestNodeDir() {
  if (_bestNodeDir !== undefined) return _bestNodeDir;
  _bestNodeDir = '';
  const path = require('path'), fs = require('fs'), os = require('os');
  const cands = [];
  try {
    const base = path.join(os.homedir(), '.workbuddy/binaries/node/versions');
    for (const d of fs.readdirSync(base).sort().reverse()) cands.push(path.join(base, d, 'bin'));
  } catch (e) { }
  cands.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const dir of cands) {
    try {
      const v = require('child_process').execFileSync(path.join(dir, 'node'), ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
      const major = Number((v.match(/^v(\d+)/) || [])[1] || 0);
      if (major >= 18 && major <= 23) { _bestNodeDir = dir; break; }  // 18–23 全兼容
      if (major >= 18 && !_bestNodeDir) _bestNodeDir = dir;           // 兜底 ≥18（zcode 启动器会自选）
    } catch (e) { }
  }
  return _bestNodeDir;
}

/* 执行后收集真实文件改动（worktree 内 git status），作为"实质进展"凭证随 done 事件带回 */
function worktreeChanges(cwd) {
  if (!cwd) return null;
  try {
    const out = require('child_process').execSync('git status --porcelain', { cwd, encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({
      flag: l.slice(0, 2).trim(),
      file: l.slice(3).trim().replace(/^"|"$/g, ''),
    })).slice(0, 100);
  } catch (e) { return null; }
}

/* 把 CLI 事件流（stream-json NDJSON 帧）翻译成人能读的执行过程日志行；返回 null 表示该帧不上屏
   只展示两类信息：工具调用（执行流）与模型叙述文本；thinking/system/快照等噪声全部略过 */
function fmtCliFrame(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.type === 'system' || j.type === 'file-history-snapshot' || j.type === 'result') return null;
  if (j.type === 'user') {
    const arr = Array.isArray(j.message?.content) ? j.message.content : [];
    const errs = arr.filter(b => b.type === 'tool_result' && b.is_error);
    if (!errs.length) return null; // 工具正常返回不上屏，出错才报
    const txt = errs.map(b => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join(' ').slice(0, 160);
    return '  ↳ 出错 ' + txt.replace(/\n/g, ' ');
  }
  if (j.type === 'assistant') {
    const arr = Array.isArray(j.message?.content) ? j.message.content : [];
    const lines = [];
    for (const b of arr) {
      if (b.type === 'tool_use') {
        const inp = b.input || {};
        const f = String(inp.file_path || inp.path || inp.notebook_path || '');
        const base = f.replace(/^.*\//, '');
        let arg;
        if (/^(Bash|PowerShell)$/.test(b.name)) arg = String(inp.command || '').replace(/\n/g, ' ').slice(0, 90);
        else if (b.name === 'Grep' || b.name === 'Glob') arg = String(inp.pattern || '');
        else if (b.name === 'WebFetch') arg = String(inp.url || '');
        else if (b.name === 'WebSearch') arg = String(inp.query || '');
        else if (base) arg = base;
        else arg = JSON.stringify(inp).slice(0, 70);
        lines.push('⚙ ' + b.name + (arg ? '  ' + arg : ''));
      } else if (b.type === 'text' && b.text && b.text.trim()) {
        lines.push(b.text.trim());
      }
    }
    return lines.length ? lines.join('\n') : null;
  }
  return null;
}


/* 模板参数切分：支持双/单引号包裹的含空格路径（如 "/Applications/CodeBuddy CN.app/…"），
   引号内不切分、引号本身剥离；不含引号的模板行为与按空白切分完全一致 */
function splitTplArgs(s) {
  const out = []; let cur = '', q = null;
  for (const ch of String(s || '').trim()) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/* 运行时自愈（借鉴 HiFox 发现缓存思路）：接入向导快照的绝对路径会随 CLI 升级/卸载失效
   （实例：qodercli-1.1.72 升到 1.1.73 后旧路径消失，Agent 表现为"检测成功但无法启动"）。
   启动前发现模板 cmd 是路径且已不存在时，按 runtimeId（精确）→ cliId（同族，qoder↔qoder-cn）
   重新解析当前发现结果；路径仍有效时不干预，保留用户在模板里的自定义参数 */
function healCliRuntime(agent) {
  try {
    if (!agent || agent.mode !== 'cli') return null;
    const fs = require('fs');
    const cmd0 = splitTplArgs(String(agent.cliTemplate || '').split('{prompt}')[0])[0];
    if (!cmd0 || !cmd0.includes('/') || fs.existsSync(cmd0)) return null;
    const fam = id => String(id || '').replace(/-cn$/, '');
    const list = discoverAppRuntimes();
    const rt = list.find(r => r.id === agent.runtimeId)
      || list.find(r => fam(r.cliId) === fam(agent.cliId));
    if (!rt || !rt.cliTemplate) return null;
    const nc = splitTplArgs(String(rt.cliTemplate).split('{prompt}')[0])[0];
    if (!nc || !fs.existsSync(nc)) return null;
    return { ...agent, runtimeId: rt.id, cliCommand: rt.cliCommand, cliTemplate: rt.cliTemplate, cliEnv: rt.cliEnv, detected: true };
  } catch (e) { return null; }
}

/* 登录态识别：无头 CLI"能启动但干不了活"的最常见原因是认证缺失（codebuddy 家族实测输出
   "Authentication required. Please use /login command to sign in to your account"，桌面版登录不覆盖 CLI）。
   命中时给可操作指引，而不是裸退出码或把报错文本当交付物 */
const AUTH_FAIL_RE = /authentication required|please (use |run )?\/?login|not logged in|please sign in|login required|请先登录/i;
const authFailHint = (text, cmd) => AUTH_FAIL_RE.test(String(text || ''))
  ? 'CLI 尚未登录：请在终端运行一次 ' + cmd + '（交互模式下按提示完成登录）后重试'
  : null;

/* ACP 会话执行（Agent Client Protocol，架构照抄 HiFox 适配器层）：
   agent.acp = {cmd, args}，统一会话协议替代各家 CLI 的模板 spawn——
   权限请求结构化上屏自动放行、过程事件流式回传、会话可取消、可恢复（session/load）。
   隔离工作区约定与 runCliTask 一致 */
async function runAcpSession(task, agent, extraPrompt, onEvent, opts: any = {}) {
  const repoRoot = opts.repoRoot;
  const acp = agent.acp || {};
  // 会话恢复锚点：同一 Agent 的上一轮 ACP 会话（打回重跑续会话，不重喂全量历史）
  const prevSid = task.acpSessionId && task.acpAgentId === agent.id ? task.acpSessionId : null;
  const prompt = prevSid ? buildResumePrompt(task, extraPrompt, agent.scenePrompt) : buildCliPrompt(task, extraPrompt, agent.scenePrompt);
  let cwd: any = null;
  if (repoRoot) {
    cwd = prepareWorktree(repoRoot, task.key, line => onEvent({ type: 'note', text: line }));
    if (!cwd) { onEvent({ type: 'error', message: '隔离工作区准备失败，已中止执行（避免 Agent 误改其他目录）。请检查仓库状态：' + repoRoot }); return; }
  } else {
    cwd = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reins-acp-'));
    onEvent({ type: 'note', text: '⚠ 空间未配置代码仓库，本次在临时目录执行：' + cwd });
  }
  onEvent({ type: 'start', model: (agent.name || 'ACP Agent') + '（ACP 会话协议）', provider: '本机命令', cli: true });
  const runKey = stageKeyOf(task, opts.stage);
  await require('./acp').runAcpTask({
    cmd: acp.cmd, args: acp.args || [], env: agent.cliEnv, cwd,
    prompt, promptFallback: buildCliPrompt(task, extraPrompt, agent.scenePrompt),
    resumeSessionId: prevSid, onEvent,
    timeoutMs: 20 * 60 * 1000,   // 大型集成任务 10 分钟不够（REINS-126 前端阶段两连超时实证），放宽到 20 分钟
    onSpawn: child => { aborts.set(runKey, { abort: () => { try { child.kill('SIGTERM'); } catch (e) { } } }); },
  });
  aborts.delete(runKey);
}

async function runCliTask(task, agent, extraPrompt, onEvent, opts: any = {}) {
  const repoRoot = opts.repoRoot;
  const runKey = stageKeyOf(task, opts.stage);
  const healed = healCliRuntime(agent);
  if (healed) {
    agent = healed;
    onEvent({ type: 'note', text: '↻ 原路径已失效（CLI 升级/重装？），已自动切换到当前安装：' + splitTplArgs(String(agent.cliTemplate).split('{prompt}')[0])[0] });
  }
  const preset = CLI_PRESETS.find(p => p.id === agent.cliId) || { cmd: agent.cliCommand || 'echo', template: '{prompt}' };
  const template = agent.cliTemplate || preset.template;
  if (!template.includes('{prompt}')) { onEvent({ type: 'error', message: '命令模板缺少 {prompt} 占位符' }); return; }
  const [head, tail = ''] = template.split('{prompt}');
  const argv = splitTplArgs(head);
  const prompt = buildCliPrompt(task, extraPrompt, agent.scenePrompt);
  let args = [...argv.slice(1), prompt, ...splitTplArgs(tail), ...cliModelArgs(agent)];
  const cmd = argv[0] || preset.cmd;
  // 事件流模式：CLI 输出 NDJSON 帧而非纯文本，主进程逐帧翻译成实时执行日志（模板自带的 --output-format 一律剥掉）
  const streamJson = preset.streamJson === true;
  if (streamJson) {
    args = args.filter((a, i) => a !== '--output-format' && args[i - 1] !== '--output-format');
    args.push('--output-format', 'stream-json');
  }

  const env = { ...process.env };
  const lp = loginPath();
  const nd = bestNodeDir();
  env.PATH = [nd, lp].filter(Boolean).join(':') + ':' + (env.PATH || '');
  // 运行时级环境变量（应用内置引擎常需，如 WorkBuddy 包的 CODEBUDDY_FORCE_LITE_WB_BUNDLE）
  Object.assign(env, agent.cliEnv || {});

  // 任务级实例约定（TASK_ENV_*）：每任务派生固定 CDP 端口（50000-59999 区间）与独立数据目录，
  // 为 per-task IDE/CDP 实例与配置隔离铺路；现有 CLI 不识别也无副作用
  const pathMod = require('path'), osMod = require('os');
  const taskPort = 50000 + (Number(String(task.key).replace(/\D/g, '')) % 10000);
  env.TASK_ENV_KEY = String(task.key || '');
  env.TASK_ENV_INSTANCE_NUMBER = String(taskPort);
  env.TASK_ENV_DAEMON_HEALTH_PORT = String(taskPort + 1);
  env.TASK_ENV_ELECTRON_USER_DATA = pathMod.join(env.APPDATA || pathMod.join(osMod.homedir(), 'Library', 'Application Support'), 'Reins', 'tasks', task.key || 'run');

  onEvent({ type: 'start', model: cliRunLabel(cmd, agent) + (streamJson ? '（本机 CLI · 过程实时回传）' : '（本机 CLI）'), provider: '本机命令', cli: true });
  onEvent({ type: 'model', model: String(agent.cliModel || '').trim() || '默认模型' });
  onEvent({ type: 'note', text: `▸ 任务实例 ${task.key} · 端口 ${taskPort} · 独立数据目录已注入` });

  // 隔离执行：空间配置了仓库根目录时，为任务准备独立 worktree（分支 reins/<KEY>），CLI 在其中改动互不干扰
  // 安全规则：配置了仓库但 worktree 准备失败 → 中止执行，绝不退化到应用目录裸跑；未配置仓库 → 落到独立临时目录
  let cwd: any = null;
  if (repoRoot) {
    cwd = prepareWorktree(repoRoot, task.key, line => onEvent({ type: 'note', text: line }));
    if (!cwd) {
      onEvent({ type: 'error', message: '隔离工作区准备失败，已中止执行（避免 Agent 误改其他目录）。请检查仓库状态：' + repoRoot });
      return;
    }
  } else {
    cwd = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reins-run-'));
    onEvent({ type: 'note', text: '⚠ 空间未配置代码仓库，本次在临时目录执行：' + cwd });
  }

  // IDE 派发型 CLI（如 buddycn）：启动 IDE 会话后不退出、stdout 不回传——存活即视为派发成功
  const presetObj = CLI_PRESETS.find(p => p.id === agent.cliId) || {};
  const ideLaunch = presetObj.ideLaunch || agent.cliCommand === 'buddycn';
  const child = spawn(cmd, args, {
    env, cwd: cwd || undefined, detached: ideLaunch,
    // stdin 必须关闭：CLI 型 Agent 会探测 stdin，保持打开的管道会让它一直等待输入
    stdio: ideLaunch ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  });
  const ac = new AbortController();
  aborts.set(runKey, { abort: () => { try { child.kill('SIGTERM'); } catch (e) { } } });

  if (ideLaunch) {
    await new Promise<void>(resolve => {
      const t = setTimeout(() => {
        // 6 秒仍存活：IDE 已带着提示词打开会话
        onEvent({ type: 'note', text: '✓ 已在 CodeBuddy IDE 中打开会话（IDE 模式：执行在 IDE 内进行）' });
        onEvent({ type: 'done', result: '【IDE 派发】任务提示词已在 CodeBuddy IDE 中打开（工作目录' + (cwd ? '：' + cwd : '为本机默认') + '）。请在 IDE 中查看与接管执行；此模式不回传输出，请在完成后手动验收。', usage: null, worktree: cwd || null });
        try { child.unref(); } catch (e) { }
        resolve();
      }, 6000);
      child.on('error', e => { clearTimeout(t); onEvent({ type: 'error', message: '无法启动 ' + cmd + '：' + e.message + '（CodeBuddy 未安装或 CLI 未链接？命令应在 ~/.codebuddy/bin）' }); resolve(); });
      child.on('close', code => {
        clearTimeout(t);
        if (code === 0) {
          // VS Code 式启动器：把会话交给已运行的 IDE 后自身退出，码 0 即派发成功
          onEvent({ type: 'note', text: '✓ 已在 CodeBuddy IDE 中打开会话（IDE 模式：执行在 IDE 内进行）' });
          onEvent({ type: 'done', result: '【IDE 派发】任务提示词已在 CodeBuddy IDE 中打开（工作目录' + (cwd ? '：' + cwd : '为本机默认') + '）。请在 IDE 中查看与接管执行；此模式不回传输出，请在完成后手动验收。', usage: null, worktree: cwd || null });
        } else {
          onEvent({ type: 'error', message: cmd + ' 启动失败（退出码 ' + code + '），请检查 CodeBuddy 登录状态' });
        }
        resolve();
      });
    });
    aborts.delete(runKey);
    return;
  }

  let out = '';
  let errTail = '';
  let buf = '';
  let sawInit = false;      // 首个 system/init 帧含真实模型，只取一次
  let finalResult: any = null;   // result 帧的干净交付文本
  let cliUsage: any = null;      // result 帧的 usage（归一后随 done 上报，供 token/成本记账）
  let cliCredits = 0;            // result 帧的 total_credits（qoder 家族按积分计费，token 全零时这就是真实消耗）
  let resultError = false;
  let resultAt = 0;         // result 帧到达时间：事件流模式下进程可能因 MCP/后台任务滞留，宽限后主动收尾
  await new Promise<void>(resolve => {
    let finished = false;
    const finish = fn => { if (!finished) { finished = true; clearInterval(linger); fn(); resolve(); } };
    const linger = setInterval(() => {
      if (resultAt && Date.now() - resultAt > 8000) { try { child.kill('SIGTERM'); } catch (e) { } resultAt = 0; }
    }, 2000);
    if (streamJson) {
      child.stdout!.on('data', d => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let j = null;
          try { j = JSON.parse(line); } catch (e) { }
          if (!j) { out += line + '\n'; onEvent({ type: 'delta', text: line + '\n' }); continue; }
          // init 帧带着本次会话真实使用的模型（连默认模型都能识别），第一时间上报给界面
          if (j.type === 'system' && j.subtype === 'init' && j.model && !sawInit) {
            sawInit = true;
            onEvent({ type: 'model', model: String(j.model), final: true });
            onEvent({ type: 'note', text: '▸ 执行模型 ' + j.model + ' · 会话已建立' });
            continue;
          }
          if (j.type === 'result') {
            finalResult = typeof j.result === 'string' ? j.result : String(j.result ?? '');
            if (j.is_error) resultError = true;
            if (j.usage) cliUsage = require('./acp').normUsageTokens(j.usage);
            if (Number.isFinite(+j.total_credits) && +j.total_credits > 0) cliCredits = +j.total_credits;
            resultAt = Date.now();
            continue;
          }
          const f = fmtCliFrame(j);
          if (f) { out += f + '\n'; onEvent({ type: 'delta', text: f + '\n' }); }
        }
      });
    } else {
      child.stdout!.on('data', d => { const s = d.toString(); out += s; onEvent({ type: 'delta', text: s }); });
    }
    child.stderr!.on('data', d => { errTail = (errTail + d.toString()).slice(-500); }); // stderr 不计入交付物，仅用于排错
    child.on('error', e => finish(() => onEvent({ type: 'error', message: '无法启动命令 ' + cmd + '：' + e.message + '（本机未安装？可在配置中修改命令）' })));
    child.on('close', code => finish(() => {
      const authHint = authFailHint(out + '\n' + errTail, cmd);
      if (authHint) onEvent({ type: 'error', message: authHint });
      else if (resultError) onEvent({ type: 'error', message: (finalResult || '执行失败').slice(0, 300) });
      else if (code !== 0 && !out && finalResult === null) onEvent({ type: 'error', message: cmd + ' 退出码 ' + code + (errTail ? '：' + errTail.slice(-200) : '') });
      else onEvent({ type: 'done', result: (finalResult !== null ? finalResult : out.trim()) || '（无输出）', usage: cliUsage, credits: cliCredits || undefined, worktree: cwd || null, changes: worktreeChanges(cwd) });
    }));
  });
  aborts.delete(runKey);
}

/* ==================== 交付物体系（借鉴 HiFox 四层交付） ====================
   done 事件从单个 result 字符串升级为类型化交付：
   - markdown 报告（result 原文）+ 落盘 report.md
   - diff 交付：worktree 未提交改动解析成按文件 diff（新增文件经 add -N 纳入），落盘 changes.patch
   - 文件统一存 userData/deliveries/<任务KEY>/，供交付页预览/下载/在访达中显示
   应用/放弃是显式动作：改动默认"未确认写入生效"，验收人确认后才 patch 进仓库（拟议变更确认墙） */

/* 统一 diff → 按文件结构（path/增删行数/内容行），行数截断防止巨型 diff 撑爆渲染层 */
function parseDiff(patch: any): any[] {
  const files = [];
  let cur: any = null;
  for (const line of String(patch || '').split('\n')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (m) { cur = { path: m[2], add: 0, del: 0, lines: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (/^\+\+\+|^---|^index |^old mode|^new mode|^similarity|^rename|^copy|^deleted file|^new file/.test(line)) continue;
    if (/^@@/.test(line)) { cur.lines.push(line); continue; }
    if (line.startsWith('+')) { cur.add++; cur.lines.push(line); }
    else if (line.startsWith('-')) { cur.del++; cur.lines.push(line); }
    else cur.lines.push(line);
  }
  return files.map(f => ({ path: f.path, add: f.add, del: f.del, lines: f.lines.slice(0, 500), truncated: f.lines.length > 500 }));
}

/* Reins 注入 worktree 的 node_modules 符号链接（宿主是真实目录）绝不能进交付 diff：
   无 .gitignore 的仓库会把它当"拟议变更"，应用时 git 试图把真实目录覆盖成符号链接必然失败 */
const nmInjected = wt => {
  try { return require('fs').lstatSync(require('path').join(wt, 'node_modules')).isSymbolicLink(); } catch (e) { return false; }
};
const diffPathspec = wt => (nmInjected(wt) ? ['--', '.', ':(exclude)node_modules'] : []);

/* ==================== 会话日志落盘（第八轮，借鉴 HiFox 会话记录留痕） ====================
   主进程 emit 处 tee 全部执行事件（引擎无关：API/CLI/ACP/云端四条通路同构），
   done/error/cancelled 时追加写入 deliveries/<KEY>/session.log——打回重跑续写在同一文件。
   过程行超限（400KB）时保头尾截中间，防长任务把日志写成无底洞 */
function appendSessionLog(dir: any, { task, agent, evt, lines, ms, model }: any): any {
  const fs = require('fs'), path = require('path');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return null; }
  const file = path.join(dir, 'session.log');
  const agentKind = agent?.mode === 'cli' ? (agent.acp ? 'ACP 会话' : '本机 CLI') : agent?.mode === 'api' ? 'API' : agent?.mode === 'sim' ? '演示' : '未知';
  const outcome = evt.type === 'done' ? '执行完成' : evt.type === 'cancelled' ? '已终止' : '执行失败';
  let body = lines.join('');
  if (body.length > 400 * 1024) {
    const head = body.slice(0, 100 * 1024), tail = body.slice(-280 * 1024);
    body = head + '\n…（过程超长，中间部分已截断）…\n' + tail;
  }
  const block = [
    `──── ${new Date().toLocaleString('zh-CN')} · ${outcome} · 用时 ${(ms / 1000).toFixed(1)}s ────`,
    `任务: ${task.key} ${task.title}`,
    `Agent: ${agent?.name || '（未指名）'}（${agentKind}${model ? ' · ' + model : ''}）`,
    evt.acpSessionId ? `会话: ${evt.acpSessionId}${evt.resumed ? '（恢复续跑）' : ''}` : '',
    '──── 过程 ────',
    body.trimEnd(),
    evt.type === 'done' ? '──── 交付 ────\n' + String(evt.result || '').slice(0, 40000) : '──── ' + String(evt.message || '') + ' ────',
    '',
  ].filter(x => x !== '').join('\n');
  try { fs.appendFileSync(file, block, 'utf8'); } catch (e) { return null; }
  return { file };
}

/* worktree 的宿主仓库根：worktree 的 git 公共目录指向主仓库 .git */
function wtRepoRoot(worktree) {
  try {
    const r = spawnSync('git', ['-C', worktree, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 8000 });
    const gd = String(r.stdout || '').trim();
    if (!gd) return null;
    if (gd === '.git') return worktree;                    // 非 worktree（直接在仓库里跑）
    return require('path').resolve(worktree, gd.replace(/\/\.git$/, ''));
  } catch (e) { return null; }
}

/* done 时构建交付：解析 diff + 落盘 report.md / changes.patch；dir 为交付目录（可为空跳过落盘） */
function buildDelivery(evt: any, dir: any): any {
  const fs = require('fs'), path = require('path');
  const out: any = { dir: dir || null, items: [], diff: null, files: [] };
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { out.dir = null; }
  }
  if (out.dir && evt.result) {
    try { fs.writeFileSync(path.join(out.dir, 'report.md'), String(evt.result), 'utf8'); out.items.push({ kind: 'markdown', file: 'report.md', name: '交付报告.md' }); } catch (e) { }
  }
  if (evt.worktree) {
    try {
      const ps = diffPathspec(evt.worktree);
      const git = (...a) => spawnSync('git', ['-C', evt.worktree, ...a], { encoding: 'utf8', timeout: 20000 });
      git('add', '-A', '-N', ...ps);   // 意向添加：新建文件也进 diff（不落对象库、无副作用）；注入的 node_modules 链接排除在外
      const d = git('diff', ...ps);
      if (d.stdout && d.stdout.trim()) {
        out.diff = { patch: d.stdout, files: parseDiff(d.stdout) };
        if (out.dir) {
          try { fs.writeFileSync(path.join(out.dir, 'changes.patch'), d.stdout, 'utf8'); out.items.push({ kind: 'diff', file: 'changes.patch', name: '代码变更.patch', files: out.diff.files.length }); } catch (e) { }
        }
      }
      const st = git('status', '--porcelain');
      out.files = String(st.stdout || '').split('\n').map(l => l.trim()).filter(Boolean)
        .filter(l => !/^..\s+node_modules\/?$/.test(l))   // 注入的依赖链接不上屏
        .slice(0, 100)
        .map(l => ({ flag: l.slice(0, 2).trim(), file: l.slice(3).trim().replace(/^"|"$/g, '') }));
    } catch (e) { }
  }
  return out;
}

/* 确认应用：worktree 的未提交改动 patch 进宿主仓库工作区（拟议变更生效）。
   git apply 非原子——必须先 --check 预检，套用失败时反向回滚，保证仓库要么全应用要么零改动 */
function applyDelivery(worktree: any): any {
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    const repoRoot = wtRepoRoot(worktree);
    if (!repoRoot) return { ok: false, message: '无法定位宿主仓库' };
    const git = (root, ...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 30000 });
    const ps = diffPathspec(worktree);
    git(worktree, 'add', '-A', '-N', ...ps);
    const d = git(worktree, 'diff', ...ps);
    if (!d.stdout || !d.stdout.trim()) return { ok: false, message: '隔离工作区没有可应用的改动' };
    const tmp = path.join(os.tmpdir(), 'reins-apply-' + Date.now() + '.patch');
    fs.writeFileSync(tmp, d.stdout);
    const rm = () => { try { fs.unlinkSync(tmp); } catch (e) { } };
    const chk = git(repoRoot, 'apply', '--check', '--whitespace=nowarn', tmp);
    if (chk.status !== 0) {
      rm();
      return { ok: false, message: '预检未通过：仓库当前状态与变更冲突，未做任何改动。' + String(chk.stderr || '').trim().slice(0, 180) };
    }
    const ap = git(repoRoot, 'apply', '--whitespace=nowarn', tmp);
    rm();
    if (ap.status !== 0) {
      git(repoRoot, 'apply', '-R', '--whitespace=nowarn', tmp);   // 极少见的并发冲突：尽力回滚，不留半截状态
      return { ok: false, message: '应用失败，已回滚全部改动（仓库保持原状）。' + String(ap.stderr || '').trim().slice(0, 180) };
    }
    return { ok: true, applied: d.stdout.split('\n').filter(l => /^diff --git/.test(l)).length };
  } catch (e: any) { return { ok: false, message: '应用异常：' + e.message }; }
}

/* 放弃变更：移除隔离 worktree 与分支（git status 脏文件随 worktree 目录一并清除） */
function discardDelivery(worktree: any): any {
  try {
    const path = require('path');
    const repoRoot = wtRepoRoot(worktree);
    if (!repoRoot) return { ok: false, message: '无法定位宿主仓库' };
    const key = path.basename(worktree);
    const git = (...a) => spawnSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8', timeout: 30000 });
    git('worktree', 'remove', '--force', worktree);
    git('branch', '-D', 'reins/' + key);
    git('worktree', 'prune');
    return { ok: true };
  } catch (e: any) { return { ok: false, message: '放弃异常：' + e.message }; }
}

/* 在 <仓库>/../.reins-wt/<任务KEY> 创建（或复用）worktree + 分支 reins/<KEY>；
   返回工作目录路径，失败时回报原因并返回 null（退化为当前目录直接执行） */
function prepareWorktree(repoRoot, key, note) {
  try {
    const fs = require('fs');
    const path = require('path');
    const git = (...a) => spawnSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8', timeout: 20000 });

    const chk = git('rev-parse', '--is-inside-work-tree');
    if (!chk || chk.status !== 0 || String(chk.stdout || '').trim() !== 'true') {
      note('⚠ ' + repoRoot + ' 不是 git 仓库，无法创建隔离工作区');
      return null;
    }
    const wtRoot = path.join(repoRoot, '..', '.reins-wt');
    const wt = path.join(wtRoot, key);
    git('worktree', 'prune'); // 清理目录已不存在但注册仍在的陈旧 worktree（否则 add 会失败）
    if (fs.existsSync(wt)) {
      note('↻ 复用隔离工作区 .reins-wt/' + key + '（分支 reins/' + key + '）');
      return wt;
    }
    fs.mkdirSync(wtRoot, { recursive: true });
    let r = git('worktree', 'add', '-b', 'reins/' + key, wt);
    if (r.status !== 0) {
      // 分支已存在（历史任务遗留）：直接按既有分支挂载，不重置
      r = git('worktree', 'add', wt, 'reins/' + key);
      if (r.status !== 0) { note('⚠ 无法创建 worktree：' + String(r.stderr || '').trim().slice(0, 140)); return null; }
      note('✓ 挂载既有分支 reins/' + key);
    } else {
      note('✓ 已创建隔离工作区 .reins-wt/' + key + '（新分支 reins/' + key + '）');
    }
    const nm = path.join(repoRoot, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, 'node_modules'))) {
      try { fs.symlinkSync(nm, path.join(wt, 'node_modules'), 'dir'); note('✓ 已链接 node_modules（免重装依赖）'); } catch (e) { }
    }
    return wt;
  } catch (e: any) {
    note('⚠ 工作区准备异常：' + e.message + '，改为直接执行');
    return null;
  }
}
/* ---------- 云端执行：派发到远端节点（reins-node/server.js） ---------- */
async function runCloudTask(task, agent, extraPrompt, onEvent, opts: any = {}) {
  const cfg = opts.cloud || {};
  const base = String(cfg.url || '').replace(/\/+$/, '');
  if (!base || !cfg.token) { onEvent({ type: 'error', message: '未配置云端节点地址或令牌（设置 → 云端节点）' }); return; }
  const auth = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token };

  const preset = CLI_PRESETS.find(p => p.id === agent.cliId) || { cmd: agent.cliCommand || 'echo', template: '{prompt}' };
  const template = agent.cliTemplate || preset.template;
  const [head, tail = ''] = template.split('{prompt}');
  const argv = head.trim().split(/\s+/).filter(Boolean);
  const prompt = buildCliPrompt(task, extraPrompt, agent.scenePrompt);
  const args = [...argv.slice(1), prompt, ...tail.trim().split(/\s+/).filter(Boolean), ...cliModelArgs(agent)];
  const cmd = argv[0] || preset.cmd;
  const runId = task.id + '-' + Date.now();

  onEvent({ type: 'start', model: cliRunLabel(cmd, agent) + '（云端节点' + (cfg.name ? ' ' + cfg.name : '') + '）', provider: '云端执行', cli: true, cloud: true });

  /* 派发与事件流出站同走共享重试层（429/5xx/无响应超时自动重试，见 services/http.js）。
     重试安全性：节点对同一 runId 的重复派发幂等拒绝（400 runId 已存在）——首次响应丢失的
     重试不会双跑任务，收到该错误按"已派发"续接事件流。
     取消通道先行登记（派发阶段即可取消）：断开本地事件流等待 + 通知节点终止；
     pfetch 在纯 Node（无 global.fetch）下同步抛错，须吞掉不能打断取消链路 */
  const http = opts.http || {};
  const ac = new AbortController();
  const runKey = stageKeyOf(task, opts.stage);
  const cancelUrl = base + '/run/' + encodeURIComponent(runId) + '/cancel';
  const ropts = {
    fetchImpl: http.fetchImpl || pfetch,
    timeoutMs: Number.isFinite(http.timeoutMs) ? http.timeoutMs : 30000,
    retries: Number.isFinite(http.retries) ? http.retries : 2,
    signal: ac.signal,   // 用户取消（与超时共用通道）：外部 signal 进 opts 而非 fetch init——init.signal 会被共享层的每次尝试信号覆盖
  };
  aborts.set(runKey, { abort: () => {
    try { ac.abort(); } catch (e) { }
    try { ropts.fetchImpl(cancelUrl, { method: 'POST', headers: auth }).catch(() => { }); } catch (e) { }
  } });

  try {
    let resp;
    try {
      resp = await fetchWithRetry(base + '/run', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ runId, taskKey: task.key, cmd, args, repoRoot: opts.repoRoot || '', timeoutMs: 20 * 60 * 1000 }),
      }, ropts);
    } catch (e: any) {
      if (e.name === 'AbortError' || ac.signal.aborted) { onEvent({ type: 'cancelled' }); return; }
      onEvent({ type: 'error', message: '云端节点连接失败：' + e.message }); return;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      /* runId 已存在 = 本轮重试的首次派发实际已落地（响应丢失），续接而非报错 */
      if (!/runId\s*已存在/.test(text)) { onEvent({ type: 'error', message: '云端节点拒绝派发：HTTP ' + resp.status + ' ' + text.slice(0, 120) }); return; }
    }

    /* 事件流（SSE）：建连（含响应头）由重试层的每次尝试超时兜底；进入流读取后由断流看门狗接管——
       超过 stallMs 无任何字节（连接静默死亡/半开）掐断本次连接。
       断流自动续读：流中断/断流先自动重连（默认 2 次，http.resume 可调）——节点每次重连整段回放
       事件缓冲（天然支持续读），客户端按事件 seq 去重（旧节点无 seq 时按「已消费条数」跳过回放前缀），
       已上屏输出不会重播；重连用尽才如实报错。用户取消（外部 ac）仍立即终止、绝不重连 */
    const stallMs = Number.isFinite(http.stallMs) ? http.stallMs : 10 * 60 * 1000;
    const resumes = Number.isFinite(http.resume) ? Math.max(0, Math.floor(http.resume)) : 2;
    const eventsUrl = base + '/run/' + encodeURIComponent(runId) + '/events';
    let out = '', errTail = '';
    let lastSeq = 0;       // 已消费的最大事件序号（节点 ≥1.1 每个事件带 seq）
    let consumed = 0;      // 旧节点（无 seq）兼容：已消费事件计数，重连后跳过回放前缀
    let stallTimer: any = null;

    /* 单事件消费：返回 'end' 表示终态已上抛（done/killed/gone） */
    const consume = ev => {
      if (Number.isFinite(ev.seq)) {
        if (ev.seq <= lastSeq) return null;   // 回放重收：已消费过，去重
        lastSeq = ev.seq;
      } else if (skip > 0) { skip--; return null; }
      else consumed++;
      if (ev.t === 'out') { out += ev.text; onEvent({ type: 'delta', text: ev.text }); }
      else if (ev.t === 'note') onEvent({ type: 'note', text: '[云端] ' + ev.text });
      else if (ev.t === 'err') errTail = (errTail + ev.text).slice(-500);
      else if (ev.t === 'gone') { onEvent({ type: 'error', message: '云端节点已无此任务记录（可能已结束并被清理，无法续读）' }); return 'end'; }
      else if (ev.t === 'killed') { onEvent({ type: 'cancelled' }); return 'end'; }
      else if (ev.t === 'done') {
        if (ev.code !== 0 && !out && ev.error) onEvent({ type: 'error', message: '云端执行失败：' + ev.error });
        else if (ev.code !== 0 && !out) onEvent({ type: 'error', message: cmd + ' 云端退出码 ' + ev.code + (errTail ? '：' + errTail.slice(-200) : '') });
        else onEvent({ type: 'done', result: out.trim() || '（无输出）', usage: null, worktree: ev.worktree || null });
        return 'end';
      }
      return null;
    };

    let skip = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        let drop: any = null, stalled = false;
        skip = consumed;   // 本连接回放前缀中「已消费」的条数（无 seq 节点）
        /* 每次连接独立控制器：断流只作废本次连接（stall 计时器 abort 它），
           用户取消经外部 ac 传播进来——两者在 catch 里可区分 */
        const sc = new AbortController();
        const onOuter = () => { try { sc.abort(); } catch (e) { } };
        if (ac.signal.aborted) onOuter(); else ac.signal.addEventListener('abort', onOuter, { once: true });
        const armStall = () => { if (stallTimer) clearTimeout(stallTimer); stallTimer = setTimeout(() => { stalled = true; try { sc.abort(); } catch (e) { } }, stallMs); };
        try {
          const es = await fetchWithRetry(eventsUrl, { headers: auth }, { ...ropts, signal: sc.signal });
          if (!es.ok || !es.body) throw new Error('HTTP ' + es.status);
          const reader = es.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          armStall();
          for (;;) {
            let chunk;
            try { chunk = await reader.read(); }
            catch (e) { throw stalled ? new Error('事件流超时：超过 ' + Math.round(stallMs / 1000) + 's 无数据') : e; }
            if (chunk.done) { drop = '事件流被节点关闭'; break; }
            armStall();
            buf += dec.decode(chunk.value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const piece = buf.slice(0, idx); buf = buf.slice(idx + 2);
              const line = piece.split('\n').find(l => l.startsWith('data: '));
              if (!line) continue;
              let ev; try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
              if (consume(ev) === 'end') return;
            }
          }
        } catch (e) {
          if (ac.signal.aborted) { onEvent({ type: 'cancelled' }); return; }
          drop = '事件流' + (stalled ? '超时：超过 ' + Math.round(stallMs / 1000) + 's 无数据' : '读取失败：' + e.message);
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
          ac.signal.removeEventListener('abort', onOuter);
        }
        if (ac.signal.aborted) { onEvent({ type: 'cancelled' }); return; }
        if (attempt >= resumes) {
          onEvent({ type: 'error', message: '云端' + drop + (resumes > 0 ? '（已自动重连 ' + resumes + ' 次仍未恢复，任务可能仍在节点上执行）' : '（任务可能仍在节点上执行）') });
          return;
        }
        onEvent({ type: 'note', text: '[云端] ' + drop + '，自动重连续读（第 ' + (attempt + 1) + '/' + resumes + ' 次）…' });
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  } finally {
    aborts.delete(runKey);
  }
}

export = { PROVIDERS, runTask, runCloudTask, cancelTask, testAgent, triageTask, triageJev, testJev, planPipeline, judgePipelineGate, discoverAppRuntimes, listAgentModels, buildDelivery, applyDelivery, discardDelivery, parseDiff, appendSessionLog, resolveModelParams, stageKeyOf, CLI_PRESETS, detectClis };
