/* ============================================================
   Reins — 控制台逻辑
   · 桌面客户端：状态经 IPC 落盘 userData/reins-data.json；
    执行引擎分两档——「真实 API」（OpenAI 兼容协议，主进程流式调用）
    与「演示引擎」（本地模拟，零配置可玩）。浏览器打开时自动降级
    localStorage + 仅演示引擎。
   ============================================================ */
'use strict';

const STORE_KEY = 'reins-state-v1';
const $ = (s: any): any => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* —— 大文本引用（state 瘦身）：超过 8KB 的正文由主进程外置到 deliveries/text/，
   state 里存 {__text,ref,bytes,preview}。界面优先用 preview（不读盘就能显示摘要），
   需要全文时再异步取回并重渲染。旧档的纯字符串不受影响。 —— */
const isTextRef = v => !!(v && typeof v === 'object' && v.__text === true && typeof v.ref === 'string');
/* 同步取「可显示文本」：引用给 preview，字符串原样。渲染路径一律走它，避免 [object Object] */
const textOf = (v, limit?) => {
  if (isTextRef(v)) return String(v.preview || '');
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  const n = Number.isFinite(Number(limit)) ? Number(limit) : 0;
  return n > 0 && s.length > n ? s.slice(0, n) + '…' : s;
};
/* 已外置文本的全文缓存，避免同一份正文反复读盘。
   缓存键必须带 bytes：同一任务重跑时阶段 id 不变（stage-s1），ref 也就没变，
   但正文已经换了——只用 ref 做键会一直返回上一轮的旧内容（实测复现）。
   引用对象里的 bytes 就是写入时的字节数，正文一变缓存自然失效。 */
const textCache = new Map();          // key = ref::bytes
let textPending = new Set();          // key 同缓存键，防并发重复读
const textKeyOf = v => isTextRef(v) ? v.ref + '::' + (Number(v.bytes) || 0) : '';
/* 异步取全文：拿到后写入缓存并回调（用于预览弹窗、下载、喂给下游阶段） */
async function textFull(v, onReady?) {
  if (!isTextRef(v)) return typeof v === 'string' ? v : '';
  const key = textKeyOf(v);
  if (textCache.has(key)) return textCache.get(key);
  if (!window.reins?.textRead) return String(v.preview || '');
  if (textPending.has(key)) return String(v.preview || '');   // 同一份并发请求只发一次
  textPending.add(key);
  try {
    const r = await window.reins.textRead(v.ref).catch(() => null);
    textPending.delete(key);
    if (r && r.ok) {
      textCache.set(key, r.text);
      /* 缓存上限：正文可能很大，保留最近 50 份足够覆盖正常浏览，避免长会话吃内存 */
      if (textCache.size > 50) textCache.delete(textCache.keys().next().value);
      if (typeof onReady === 'function') onReady(r.text);
      return r.text;
    }
    return String(v.preview || '');
  } catch (e) { textPending.delete(key); return String(v.preview || ''); }
}
/* 引用摘要徽标：让用户知道「这里显示的是摘要，点开有全文」 */
const textRefNote = v => isTextRef(v) ? `<span class="txt-ref" title="正文已外置（${(Number(v.bytes) / 1024).toFixed(0)}KB），点击预览可读全文">摘要 · ${(Number(v.bytes) / 1024).toFixed(0)}KB</span>` : '';

/* —— 轻量 Markdown 渲染（零依赖，覆盖交付报告常用语法；先转义再生成受控标签，链接仅放行 http(s)） —— */
function mdToHtml(src) {
  if (!src) return '';
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = String(src).replace(/\r/g, '').split('\n');
  let html = '', i = 0, p = [];
  const flushP = () => { if (p.length) html += '<p>' + p.map(inline).join('<br>') + '</p>'; p = []; };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flushP(); const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushP(); const lv = h[1].length + 1; html += `<h${lv}>${inline(h[2])}</h${lv}>`; i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      flushP();
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
      html += `<${ordered ? 'ol' : 'ul'}>` + items.map(x => `<li>${inline(x)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushP();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      const head = rows.shift(); rows.shift();
      html += '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { flushP(); html += '<hr>'; i++; continue; }
    if (/^\s*>\s?/.test(l)) { flushP(); html += '<blockquote>' + inline(l.replace(/^\s*>\s?/, '')) + '</blockquote>'; i++; continue; }
    if (!l.trim()) { flushP(); i++; continue; }
    p.push(l); i++;
  }
  flushP();
  return html;
}
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[rnd(0, arr.length - 1)];

const TYPE_LABEL = { req: '需求', bug: '缺陷', support: '支持', test: '测试', chore: '杂务', research: '调研', writing: '文案', data: '数据' };
const STATUS_LABEL = { todo: '待处理', doing: '进行中', review: '待审查', done: '已归档' };
const STATUS_FLOW = ['todo', 'doing', 'review', 'done'];

const PROVIDER_PRESETS = [
  { id: 'glm', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7', glyph: '❋' },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', glyph: '⬢' },
  { id: 'kimi', label: '月之暗面 Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', glyph: '✦' },
  { id: 'qwen', label: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', glyph: '◈' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', glyph: '⬡' },
  { id: 'siliconflow', label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', glyph: '⌁' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseURL: '', model: '', glyph: '⊕' },
];
/* 浏览器预览模式的离线兜底清单；桌面端启动时会被主进程 cliList() 覆盖——新增 CLI 只改 services/runner.js */
const CLI_PRESETS = [
  { id: 'claude-code', label: 'Claude Code', cmd: 'claude', template: 'claude -p {prompt} --output-format text', install: 'curl -fsSL https://claude.ai/install.sh | bash', modelFlag: '--model' },
  { id: 'codex', label: 'Codex CLI', cmd: 'codex', template: 'codex exec --skip-git-repo-check {prompt}', install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', modelFlag: '-m' },
  { id: 'codebuddy', label: '腾讯 CodeBuddy Code', cmd: 'codebuddy', template: 'codebuddy -y -p {prompt} --output-format text', install: 'npm install -g @tencent-ai/codebuddy-code', modelFlag: '--model' },
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
  { id: 'qoder', label: 'Qoder', cmd: 'qodercli', template: 'qodercli -p {prompt}', install: 'npm install -g @qoder-ai/qodercli', modelFlag: '-m', modelListFlag: '--list-models' },
  { id: 'qoder-cn', label: 'Qoder CN', cmd: 'qoderclicn', template: 'qoderclicn -p {prompt}', install: 'npm install -g @qodercn-ai/qoderclicn', modelFlag: '-m', modelListFlag: '--list-models' },
  { id: 'auggie', label: 'Auggie', cmd: 'auggie', template: 'auggie {prompt}', install: 'npm install -g @augmentcode/auggie' },
  { id: 'qwenpaw', label: 'QwenPaw', cmd: 'qwenpaw', template: 'qwenpaw {prompt}', install: 'pip install qwenpaw' },
  { id: 'hermes', label: 'Hermes', cmd: 'hermes', template: 'hermes {prompt}', install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash' },
  { id: 'pi', label: 'Pi', cmd: 'pi', template: 'pi {prompt}', install: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent' },
];
const providerLabel = id => (PROVIDER_PRESETS.find(p => p.id === id) || {}).label || id;

/* 无头 CLI 的执行模型（codebuddy/workbuddy 引擎 --model 实测支持）；派发与 Agent 配置共用 */
const CLI_CAN_MODEL = ['codebuddy', 'workbuddy'];
const CB_MODELS = ['hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'space-bunny', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3-pay', 'minimax-m2.7', 'kimi-k3-2', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'];

/* 模型选择通用化（CLI_PRESETS.modelFlag 逐个实测标注）：qoder 家族 -m、codex -m、claude --model、
   codebuddy/workbuddy --model。ACP 会话 Agent 暂不支持模型参数（协议层 setModel 后续接入） */
const cliCanModel = a => !!(a && a.mode === 'cli' && !a.acp && (CLI_PRESETS.find(p => p.id === a.cliId) || {}).modelFlag);
/* 模型列表：优先主进程动态获取（qoder 家族走 --list-models 实时拉取），渲染层缓存；
   codebuddy/workbuddy 用静态表兜底；其余 CLI 空表（仅手输） */
const _modelOpts = {};
function modelOptsSync(a) {
  const k = a && a.cliId;
  if (k && _modelOpts[k]) return _modelOpts[k];
  return CLI_CAN_MODEL.includes(k) ? CB_MODELS : [];
}
function hydrateModelSelect(selId, a, curVal) {
  if (!window.reins || !a) return;
  window.reins.cliModels(a).then(list => {
    if (!Array.isArray(list) || !list.length) return;
    _modelOpts[a.cliId] = list;
    const sel = $('#' + selId);
    if (!sel) return;
    const cur = curVal || sel.value || '';
    sel.innerHTML = `<option value="">${esc(a.cliModel ? a.cliModel + '（Agent 默认）' : '默认模型')}</option>`
      + list.map(m => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('');
  }).catch(() => { });
}

/* ==================== AI 角色（人设层）====================
   角色 = 专用 Agent + 专属模型 + 独有提示词的打包预设（产品经理/开发/测试…），
   指派任务时直接选角色；执行时角色提示词与 Agent 场景提示词叠加注入 */
const ROLE_TEMPLATES = [
  { key: 'pmgr', name: '项目经理', glyph: '⬢', prompt: '你是资深项目经理，负责把控整体交付流程。职责：把需求拆成按顺序执行的阶段链并指定负责成员；在测试报告出来后裁决下一步（通过交付 / 打回谁修改、怎么改）；最后汇总全流程产出形成交付说明。\n工作方式：结论先行，裁决必须给出明确动作与理由；关注风险、依赖与进度；不亲自写代码或文档正文。\n输出要求：结构化、简短、可执行；每个判断都给出依据。' },
  { key: 'pm', name: '产品经理', glyph: '▣', prompt: '你是资深产品经理。职责：把需求拆成可执行的任务卡（背景/目标/验收标准），识别风险与依赖，平衡业务价值与实现成本。\n工作方式：输出结论先行；需求描述含用户故事与边界条件；不写代码实现细节。\n输出要求：给出结构化清单（任务/优先级/验收标准），不超过必要篇幅。' },
  { key: 'fe', name: '前端开发', glyph: '◈', prompt: '你是资深前端工程师。职责：实现页面与交互，保证代码与现有工程风格一致（框架、命名、目录结构、注释密度）。\n工作方式：改动最小化，优先复用现有组件与工具函数；涉及样式走设计令牌；自测通过再交付。\n输出要求：列出改动文件清单与一句话说明，附验证结果。' },
  { key: 'be', name: '后端开发', glyph: '◇', prompt: '你是资深后端工程师。职责：实现接口、数据模型与业务逻辑，重视边界条件、事务与错误处理。\n工作方式：遵循现有分层与命名约定；不引入新依赖除非必要并说明理由；关键路径写注释。\n输出要求：列出改动文件与接口变化（入参/出参），附自测结果。' },
  { key: 'qa', name: '测试工程师', glyph: '◎', prompt: '你是资深测试工程师。职责：设计测试用例与回归方案，覆盖正常路径、边界与异常分支。\n工作方式：用表格输出用例（编号/前置/步骤/预期/优先级）；先冒烟后细节；发现问题给出最小复现步骤。\n输出要求：用例表 + 风险提示，不写与测试无关的实现建议。' },
  { key: 'ui', name: 'UI 设计师', glyph: '◐', prompt: '你是资深 UI 设计师。职责：界面视觉与布局方案，遵循现有设计系统（颜色令牌、字号、间距、圆角）。\n工作方式：先给方案要点再给细节；改动说明具体到组件与属性；保持品牌一致性。\n输出要求：结构化描述方案（布局/色彩/组件变化），可直接交给前端落地。' },
  { key: 'doc', name: '技术文档', glyph: '❏', prompt: '你是技术文档工程师。职责：把实现改写成清晰的文档/README/变更说明。\n工作方式：面向读者组织信息（是什么/怎么用/为什么）；命令与配置用代码块；不臆造未实现的行为。\n输出要求：Markdown 交付，标题层级清晰，删掉一切不改变读者行为的句子。' },
];
const roleById = id => (O().roles || []).find(r => r.id === id);
const roleAgent = r => r && agentById(r.agentId);
const roleUsable = r => { const a = roleAgent(r); return !!(a && a.status !== 'offline' && agentUsable(a)); };
/* 角色解析为有效 Agent：角色提示词与 Agent 场景提示词叠加；模型取值优先级 任务级 > 角色级 > Agent 默认 */
function resolveRoleAgent(t) {
  const r = roleById(t.assignee && t.assignee.id);
  const a = roleAgent(r);
  if (!a) return null;
  const scene = [a.scenePrompt, r.prompt].filter(Boolean).join('\n\n');
  let eff = { ...a, scenePrompt: scene || a.scenePrompt };
  if (r.cliModel && cliCanModel(a)) eff.cliModel = r.cliModel;
  return { role: r, agent: eff };
}

/* —— 品牌 logo（simple-icons 官方 SVG）与 monogram 兜底：不用自制符号 —— */
const CLI_LOGO = {
  'claude-code': 'si-claude.svg', 'codex': 'si-openai.svg', 'opencode': 'si-opencode.svg', 'gemini-cli': 'si-googlegemini.svg',
  'cursor-cli': 'si-cursor.svg', 'qwen-code': 'si-qwen.svg', 'copilot': 'si-githubcopilot.svg',
  'amp': 'si-amp.svg', 'kimi-cli': 'si-kimi.svg', 'trae': 'si-trae.svg', 'hermes': 'si-hermes.svg',
  'zcode': 'zcode.png',
};
const PROVIDER_LOGO = { deepseek: 'si-deepseek.svg', kimi: 'si-kimi.svg', qwen: 'si-qwen.svg', openai: 'si-openai.svg' };
/* 品牌 SVG 已内联（brands.js，fill=currentColor 随底色）；位图 logo（zcode.png）仍走 img */
const brandIcon = file => {
  if (!file) return '';
  if (/\.png$/.test(file)) return `<img class="brand-ico" src="assets/icons/${file}" alt="" draggable="false">`;
  return (typeof window !== 'undefined' && typeof bi === 'function') ? bi(file.replace(/^si-/, '').replace(/\.svg$/, '')) : '';
};
/* 无官方图标的品牌兜底：单个汉字或两个字母，单行居中（不再双字挤压） */
const brandMono = name => {
  const s = String(name).replace(/[（(].*$/, '').trim();
  const cjk = s.match(/[\u4e00-\u9fff]/);
  const t = cjk ? cjk[0] : (s.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || s.slice(0, 1));
  return `<span class="brand-mono">${esc(t)}</span>`;
};
const brandOf = a => brandIcon(a.mode === 'cli' ? CLI_LOGO[a.cliId] : a.mode === 'api' ? PROVIDER_LOGO[a.provider] : '') || brandMono(a.name);

/* —— 自绘下拉：替换原生 select（原生弹出菜单是系统渲染、样式无法统一）
   对外保持原生语义：值存隐藏 input（id 不变，$('#id').value 读写照旧），
   选中后派发 change 事件，onchange 表达式里的 this.value 继续可用。opts: [{v, l, dis}] —— */
function ds(id, opts, val, onchange = '', cls = '') {
  const cur = opts.find(o => o.v === val) || opts[0] || { v: '', l: '—' };
  const optBtn = (o, i) => `<button type="button" class="ds-opt${o.v === cur.v ? ' on' : ''}${o.dis ? ' dis' : ''}"${o.dis ? ' disabled' : ''} data-v="${esc(o.v)}" onclick="dsPick('${id}',${i})">${esc(o.l)}</button>`;
  return `<div class="ds${cls ? ' ' + cls : ''}" data-ds="${id}">
    <input type="hidden" id="${id}" value="${esc(cur.v)}"${onchange ? ` onchange="${esc(onchange)}"` : ''}>
    <button type="button" class="ds-btn" onclick="dsToggle('${id}')"><span class="ds-val">${esc(cur.l)}</span>${ic('chevron-down', 'ic-ds')}</button>
    <div class="ds-pop">${opts.map(optBtn).join('')}</div>
  </div>`;
}
function dsToggle(id) {
  const wrap = document.querySelector(`.ds[data-ds="${id}"]`);
  if (!wrap) return;
  document.querySelectorAll('.ds.open').forEach(d => { if (d !== wrap) d.classList.remove('open'); });
  wrap.classList.toggle('open');
}
function dsPick(id, i) {
  const wrap = document.querySelector(`.ds[data-ds="${id}"]`);
  if (!wrap) return;
  const opt = wrap.querySelectorAll('.ds-opt')[i];
  if (!opt || opt.disabled) return;
  const inp = document.getElementById(id);
  inp.value = opt.dataset.v;
  wrap.querySelector('.ds-val').textContent = opt.textContent;
  wrap.querySelectorAll('.ds-opt').forEach(o => o.classList.toggle('on', o === opt));
  wrap.classList.remove('open');
  inp.dispatchEvent(new Event('change'));
}
/* 程序化重设选项与当前值（动态场景用） */
function dsSet(id, opts, val) {
  const wrap = document.querySelector(`.ds[data-ds="${id}"]`);
  if (!wrap) return;
  const cur = opts.find(o => o.v === val) || opts[0] || { v: '', l: '—' };
  document.getElementById(id).value = cur.v;
  wrap.querySelector('.ds-val').textContent = cur.l;
  wrap.querySelector('.ds-pop').innerHTML = opts.map((o, i) => `<button type="button" class="ds-opt${o.v === cur.v ? ' on' : ''}${o.dis ? ' dis' : ''}"${o.dis ? ' disabled' : ''} data-v="${esc(o.v)}" onclick="dsPick('${id}',${i})">${esc(o.l)}</button>`).join('');
}

const FILES = ['src/api/orders.ts', 'src/services/payment.ts', 'docs/竞品分析.md', 'data/suppliers_2026Q3.xlsx',
  'docs/周报模板.md', 'src/hooks/useAuth.ts', 'tickets/高频工单.csv', 'src/views/Checkout.tsx'];

/* ============ 状态 ============ */
let state = null;
const runs = {};          // taskId -> 运行实例（演示引擎步进 / 真实 API 流式）
let curView = 'dash';   // 在役面板（仪表先行）：打开即在概览读到全局健康
let drawerTaskId = null;
let filters = { type: '', who: '', search: '', iter: '', lane: '' };

function now() { return Date.now(); }
/* 本地时区 YYYY-MM-DD（日切锚点用；自带纯函数，不依赖 ExecLog 全局） */
function dayStr(ms) { const d = new Date(ms), p = n => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

/* —— 当前空间访问器（数据按空间隔离；Agent/密钥为全局） —— */
const O = () => state.orgs?.find(x => x.id === state.activeOrgId) || state.orgs?.[0];
const S = () => O()?.spaces.find(x => x.id === state.activeSpaceId) || O()?.spaces[0];
const memberNames = () => S().members.map(m => m.name);
const ROLE_LABEL = { owner: '管理员', member: '成员', guest: '访客' };

function seedAgents() { return []; }
function seedPrompts() { return []; }

function seed() {
  // 空白起步：不带任何演示内容；三个例程（站会/周报/AI 分诊）为真实计算功能，随工作区提供
  const space = {
    id: 'sp1', name: '我的空间', badge: '我', sprint: '',
    iterations: [], epics: [],
    members: [{ name: '我', role: 'owner' }],
    tasks: [], prompts: [], autos: seedAutos(),
    chart: [0, 0, 0, 0, 0, 0, 0],
    integ: { jira: { connected: false, host: '', lastSync: 0 } },
    activity: [{ at: now(), icon: '✳', text: '工作区已创建，可新建任务或接入 Agent' }],
    seq: 1, deliverSeq: 1, repoRoot: '', readAt: 0, chartDay: dayStr(now()),
  };
  return {
    version: 3, activeOrgId: 'og1', activeSpaceId: 'sp1',
    orgs: [{ id: 'og1', name: '我的团队', badge: '团', agents: [], roles: [], spaces: [space] }],
  };
}

function seedAutos() {
  return [
    { id: 'au1', name: '每日站会报告', trigger: '手动运行 · 也可按例程定时', icon: '☰', desc: '汇总昨日归档、今日进行中与阻塞，生成站会材料。', enabled: true, lastRun: 0, runnable: true },
    { id: 'au2', name: 'AI 分诊', trigger: '手动运行 · 也可按例程定时', icon: '✦', desc: '对待办任务判断类型与优先级，建议经办人并逐条给出理由，确认后应用。', enabled: true, lastRun: 0, runnable: true },
    { id: 'au3', name: '周报生成', trigger: '手动运行 · 也可按例程定时', icon: '▤', desc: '按空间维度汇总近 7 天吞吐、验收队列、迭代进度与产能。', enabled: true, lastRun: 0, runnable: true },
  ];
}

/* v2（顶层 agents+spaces）→ v3（组织层：agents 与 spaces 归入组织） */
function toV3(v2, orgName) {
  return {
    version: 3, activeOrgId: 'og1', activeSpaceId: v2.activeSpaceId || (v2.spaces[0] && v2.spaces[0].id),
    orgs: [{ id: 'og1', name: orgName || '我的组织', badge: (orgName || '组')[0], agents: v2.agents || [], spaces: v2.spaces }],
  };
}

/* v1（单空间扁平结构）→ v2 迁移：保留已配置的 Agent（含密钥） */
function migrateV1(old) {
  const fix = t => t;   // 人物志已统一为「我」，不再改名
  (old.tasks || []).forEach(fix);
  return {
    version: 2, activeSpaceId: 'sp1',
    agents: Array.isArray(old.agents) && old.agents.length ? old.agents : seedAgents(),
    spaces: [{
      id: 'sp1', name: 'Reins 团队', badge: 'R', sprint: 'Sprint 24 · 10.13 – 10.24',
      members: [{ name: '我', role: 'owner' }],
      seq: old.seq || 107, deliverSeq: old.deliverSeq || 219,
      tasks: old.tasks || [], prompts: old.prompts || seedPrompts(), autos: old.autos || seedAutos(),
      chart: old.chart || [2, 3, 1, 4, 3, 5, 2],
      integ: old.integ || { jira: { connected: true, host: 'jira.yourteam.cn', lastSync: now() } },
      activity: old.activity || [],
    }],
  };
}

async function loadState() {
  if (window.reins) {
    try { return await window.reins.stateLoad(); } catch (e) { return null; }
  }
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { return null; }
}
function save() {
  if (window.reins) { try { window.reins.stateSave(state); } catch (e) { } }
  else { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { } }
}
const byId = id => S().tasks.find(t => t.id === id);
const agentById = id => O().agents.find(a => a.id === id);
/* 密钥取值：safeStorage 解锁失败的 Key 在状态档里保留为密文对象（__keyLocked 标记）——
   对界面与执行一律视同"未配置"：既不把 [object Object] 当 Bearer 发出去，
   也不让表单回显/保存把密文副本覆盖成字符串（重配一次 Key 即恢复） */
const keyOf = a => (a && typeof a.apiKey === 'string' && a.apiKey) || '';
const agentUsable = a => a && (a.mode === 'sim' || a.mode === 'cli' ? a.status !== 'offline' : !!(keyOf(a) && a.status !== 'offline'));
/* 设置档密钥（cloudToken / jevKey / gitTokens 成员）取值：解锁失败时同样是密文对象，
   keyOf 同语义——视同未配置（表单回显空值、真值判定跳过），防 [object Object] 回显进输入框或当 Bearer 发出 */
const secretOf = v => (typeof v === 'string' && v) || '';
const secretLocked = v => !!v && typeof v === 'object';
/* 密钥输入框收集：留空且现值是密文对象 → 原样带回（不抹密文副本），重填或明文清空才覆盖 */
const secretPick = (v, cur) => (typeof v === 'string' ? v.trim() : '') || (secretLocked(cur) ? cur : '');

/* ============ 时间 ============ */
function fmtRel(ts) {
  const d = new Date(ts), n = new Date();
  const diff = n.getTime() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === n.toDateString()) return hm;
  const yd = new Date(n.getTime() - 864e5);
  if (d.toDateString() === yd.toDateString()) return '昨天 ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}
const today = () => new Date().toDateString();
const fmtTokens = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0);

/* ============ 导航 ============ */
const VIEWS = [
  { id: 'dash', ic: 'layout-dashboard', label: '概览', sub: '任务、Agent 与近期动态', group: 'work' },
  { id: 'kanban', ic: 'kanban', label: '看板', sub: '拖动卡片流转状态，指派 Agent 的任务自动执行', group: 'work' },
  { id: 'list', ic: 'list', label: '任务', sub: '全部任务', group: 'work' },
  { id: 'deliveries', ic: 'package', label: '交付', sub: '任务的交付物，可预览、复制、下载', group: 'work' },
  { id: 'nodes', ic: 'server', label: '节点', sub: '本机与云端执行节点', group: 'work' },
  { id: 'agents', ic: 'bot', label: 'Agent', sub: '接入 API 或本机 CLI，统一指派任务', group: 'cmd' },
  { id: 'prompts', ic: 'library', label: '提示词库', sub: '共享的提示词，执行时可附加到任务', group: 'cmd' },
  { id: 'autos', ic: 'workflow', label: '自动化', sub: '站会、分诊与周报例程', group: 'cmd' },
  { id: 'integ', ic: 'webhook', label: '集成', sub: 'Webhook 推送与分诊引擎', group: 'cmd' },
  { id: 'settings', ic: 'settings', label: '设置', sub: '模型与密钥 · 客户端偏好 · 数据', group: 'sys' },
];

function renderNav() {
  const sec = (label, ids) => `${label ? `<div class="nav-label">${label}</div>` : ''}${ids.map(id => navItem(VIEWS.find(v => v.id === id))).join('')}`;
  $('#nav').innerHTML = sec('工作台', ['dash', 'kanban', 'list', 'deliveries', 'nodes'])
    + sec('指挥', ['agents', 'prompts', 'autos', 'integ'])
    + sec('', ['settings']);
}
function navItem(v) {
  let cnt = '';
  if (v.id === 'kanban') cnt = (S()?.tasks || []).filter(t => t.status !== 'done').length;
  if (v.id === 'agents') cnt = (O().agents || []).filter(a => a.status !== 'offline').length;
  return `<button class="nav-item ${curView === v.id ? 'on' : ''}" onclick="switchView('${v.id}')">
    <span class="ic">${ic(v.ic)}</span><span class="txt">${v.label}</span>${cnt ? `<span class="cnt">${cnt}</span>` : ''}</button>`;
}
/* 近 7 日吞吐的日切：chart[6] 必须永远代表今天——启动时按锚点把跨过的天推平，
   否则跨天后旧数堆在「今天」桶里，与「今日归档」统计口径打架（如实呈现原则） */
function rollChartDaily() {
  const sp = S(); if (!sp || !Array.isArray(sp.chart)) return;
  const today = dayStr(now());
  if (!sp.chartDay) { sp.chartDay = today; return; }
  let guard = 0;
  while (sp.chartDay < today && guard++ < 7) {
    const d = sp.chartDay.split('-').map(Number);
    const next = new Date(d[0], d[1] - 1, d[2] + 1);
    sp.chartDay = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0') + '-' + String(next.getDate()).padStart(2, '0');
    sp.chart.shift(); sp.chart.push(0);
  }
  if (sp.chartDay !== today) sp.chartDay = today;   // 时钟回拨等异常：对齐锚点，不清历史
}

function switchView(id) {
  const v = VIEWS.find(x => x.id === id);
  if (!v) { console.warn('[reins] 未知视图', id); return; }   // 守卫：未知 id 直接忽略
  curView = id;
  $('#view-title').textContent = v.label;
  $('#view-sub').textContent = v.sub;
  renderNav(); render();
  $('#content').scrollTop = 0;
  if (id === 'nodes') hydrateNodes();
}

/* ============ 渲染入口 ============ */
function render() {
  const el = $('#content');
  if (curView === 'kanban') el.innerHTML = viewKanban();
  else if (curView === 'list') el.innerHTML = viewList();
  else if (curView === 'deliveries') el.innerHTML = viewDeliveries();
  else if (curView === 'nodes') el.innerHTML = viewNodes();
  else if (curView === 'agents') el.innerHTML = viewAgents();
  else if (curView === 'prompts') el.innerHTML = viewPrompts();
  else if (curView === 'autos') el.innerHTML = viewAutos();
  else if (curView === 'integ') { el.innerHTML = viewInteg(); hydrateFeishu(); }
  else if (curView === 'settings') { el.innerHTML = viewSettings(); hydrateSettings(); }
  else el.innerHTML = viewDash();
}
function refreshViews() { renderNav(); render(); renderBell(); }

function passFilter(t) {
  if (filters.iter && t.iterId !== filters.iter) return false;
  if (filters.type && t.type !== filters.type) return false;
  if (filters.search && !(t.key + ' ' + t.title).toLowerCase().includes(filters.search.toLowerCase())) return false;
  if (filters.who) {
    if (filters.who === 'none' && t.assignee) return false;
    if (filters.who === 'human' && t.assignee?.kind !== 'human') return false;
    if (filters.who.startsWith('a:') && t.assignee?.id !== filters.who.slice(2)) return false;
    if (filters.who.startsWith('r:') && !(t.assignee?.kind === 'role' && t.assignee.id === filters.who.slice(2))) return false;
  }
  return true;
}

/* ============ 看板 ============ */
function colHTML(st, ts, withHead = true) {
  return `<div class="col ${withHead ? '' : 'no-head'}" data-status="${st}">
      ${withHead ? `<div class="col-head"><span class="dot" style="background:var(--${st})"></span>${STATUS_LABEL[st]}<span class="cnt">${ts.length}</span></div>` : ''}
      ${ts.map(cardHTML).join('') || '<div class="empty-col">暂无卡片</div>'}
      ${withHead && st === 'todo' ? '<button class="col-add" onclick="openNewTaskModal()">' + ic('plus') + ' 新建任务</button>' : ''}
    </div>`;
}
function laneOf(t) {
  if (!t.assignee) return ['__none', '未指派', 'none'];
  if (t.assignee.kind === 'agent' || t.assignee.kind === 'role') {
    const isRole = t.assignee.kind === 'role';
    const a = isRole ? roleAgent(roleById(t.assignee.id)) : agentById(t.assignee.id);
    return [(isRole ? 'r:' : 'a:') + t.assignee.id, (isRole ? '☆ ' : '') + t.assignee.name, 'agent'];
  }
  return ['h:' + t.assignee.name, t.assignee.name, 'human'];
}
function viewKanban() {
  const typeOpts = [{ v: '', l: '全部类型' }, ...Object.keys(TYPE_LABEL).map(k => ({ v: k, l: TYPE_LABEL[k] }))];
  const whoOpts = [{ v: '', l: '全部经办' }, { v: 'none', l: '未指派' }, { v: 'human', l: '团队成员' }, ...(O().roles || []).map(r => ({ v: 'r:' + r.id, l: '☆ ' + r.name })), ...O().agents.map(a => ({ v: 'a:' + a.id, l: a.name }))];
  const iterOpts = [{ v: '', l: '全部迭代' }, ...(S().iterations || []).map(i => ({ v: i.id, l: i.name }))];
  const filtersBar = `<div class="kb-filters">
      ${ds('kb-lane', [{ v: '', l: '平铺视图' }, { v: 'who', l: '按经办人泳道' }], filters.lane, 'filters.lane=this.value;render()', 'inline')}
      ${(S().iterations || []).length ? ds('kb-iter', iterOpts, filters.iter, 'filters.iter=this.value;render()', 'inline') : ''}
      ${ds('kb-type', typeOpts, filters.type, 'filters.type=this.value;render()', 'inline')}
      ${ds('kb-who', whoOpts, filters.who, 'filters.who=this.value;render()', 'inline')}
      <span class="kb-hint">指派给 Agent 的任务拖入「进行中」后自动执行</span>
    </div>`;

  // —— 泳道模式：每个经办人一条横向泳道，列头只出现一次 ——
  if (filters.lane === 'who') {
    const all = S().tasks.filter(passFilter);
    const groups = new Map();
    for (const t of all) {
      const [key, label, kind] = laneOf(t);
      if (!groups.has(key)) groups.set(key, { label, kind, ts: [] });
      groups.get(key).ts.push(t);
    }
    const head = `<div class="lane-grid-head">${STATUS_FLOW.map(st => {
      const n = all.filter(t => t.status === st).length;
      return `<div><span class="dot" style="background:var(--${st})"></span>${STATUS_LABEL[st]}<span class="cnt">${n}</span></div>`;
    }).join('')}</div>`;
    const lanes = [...groups.entries()].map(([key, g]) => `
      <div class="lane">
        <div class="lane-head">
          <span class="lav ${g.kind}">${g.kind === 'human' ? esc(g.label[0]) : esc(g.label.split(' ').pop()[0])}</span>
          <b>${esc(g.label)}</b><span class="lcnt">${g.ts.length} 项</span>
        </div>
        <div class="lane-cols">${STATUS_FLOW.map(st => colHTML(st, g.ts.filter(t => t.status === st), false)).join('')}</div>
      </div>`).join('');
    return filtersBar + head + lanes + (all.length ? '' : '<div class="panel" style="padding:34px;text-align:center;color:var(--ink-dim)">当前筛选下没有任务</div>');
  }

  const cols = STATUS_FLOW.map(st => colHTML(st, S().tasks.filter(t => t.status === st && passFilter(t)))).join('');
  const welcome = !S().tasks.length && !filters.type && !filters.who && !filters.search ? `
    <div class="kb-welcome">
      <div class="kw"><span class="n">1</span><div><b>创建第一张任务</b><span>标题写清要做什么即可，类型与优先级可以之后再调整。</span></div></div>
      <div class="kw"><span class="n">2</span><div><b>接入 Agent</b><span>支持 OpenAI 兼容 API 与本机 CLI 两种方式，密钥只保存在本机。</span></div></div>
      <div class="kw"><span class="n">3</span><div><b>指派并执行</b><span>将卡片拖入「进行中」或点击「指派并启动」，产出进入待验收，可打回重做。</span></div></div>
    </div>` : '';
  return filtersBar + welcome + `<div class="kanban">${cols}</div>`;
}

function cardHTML(t) {
  const running = runs[t.id];
  const pct = running ? runPct(t.id) : 0;
  const assignee = t.pipeline?.on
    ? `<span class="assignee agent">${ic('compass')} 项目经理</span>`
    : t.assignee
    ? (t.assignee.kind === 'agent'
      ? `<span class="assignee agent">${ic('bot')} ${esc(t.assignee.name)}</span>`
      : t.assignee.kind === 'role'
        ? `<span class="assignee agent">${ic('star')} ${esc(t.assignee.name)}</span>`
        : `<span class="assignee human"><span class="av">${esc(t.assignee.name[0])}</span>${esc(t.assignee.name)}</span>`)
    : `<span class="assignee" style="color:var(--ink-faint)">未指派</span>`;
  return `<div class="tcard" draggable="true" data-task="${t.id}" onclick="openTask('${t.id}')">
    <div class="k"><span>${t.key}</span><span class="pri ${t.pri}">${t.pri}</span></div>
    <div class="t">${esc(t.title)}</div>
    <div class="row"><span class="ttag ${t.type}">${TYPE_LABEL[t.type] || t.type}</span>${assignee}</div>
    ${t.pipeline?.on ? pipeCardLine(t) : ''}
    ${t.status === 'review' && t.pr ? `<div class="pr-chip">${ic('arrow-right-left')} ${esc(t.pr)} · 待验收</div>` : ''}
    ${t.status === 'done' && t.pr ? `<div class="pr-chip" style="background:#e3f3ea;color:#3d8a5f">${ic('check')} ${esc(t.pr)} · 已归档</div>` : ''}
    ${running ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    ${t.status === 'doing' && ['agent', 'role'].includes(t.assignee?.kind) && !running ? '<div class="bar"><i style="width:6%"></i></div>' : ''}
  </div>`;
}
/* 卡片上的流水线进度行：阶段点 + 当前阶段名（返工轮次超 1 时标注） */
function pipeCardLine(t) {
  const p = t.pipeline;
  if (!p || !p.stages?.length) return `<div class="pipe-line"><span class="pl-badge">${ic('compass')}</span><span class="pl-txt">${PIPE_STATE[p.status] || '流水线'}</span></div>`;
  const dots = p.stages.map(s => `<i class="pdot ${s.state}"></i>`).join('');
  const cur = p.stages[p.cur];
  const label = p.status === 'running' && cur ? (cur.rework ? '返工 · ' : '') + cur.name : PIPE_STATE[p.status] || '';
  return `<div class="pipe-line"><span class="pl-badge">${ic('compass')}</span><span class="pdots">${dots}</span><span class="pl-txt">${esc(label)}${p.round > 1 ? ` · R${p.round - 1}` : ''}</span></div>`;
}

/* 拖拽（事件委托） */
let dragId = null;
document.addEventListener('dragstart', e => {
  const c = e.target.closest('.tcard'); if (!c) return;
  dragId = c.dataset.task; c.classList.add('dragging');
  try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { }
});
document.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.tcard.dragging').forEach(el => el.classList.remove('dragging')); });
document.addEventListener('dragover', e => { const col = e.target.closest('.col'); if (col) { e.preventDefault(); col.classList.add('over'); } });
document.addEventListener('dragleave', e => { const col = e.target.closest('.col'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('over'); });
document.addEventListener('drop', e => {
  const col = e.target.closest('.col'); if (!col) return;
  e.preventDefault(); col.classList.remove('over');
  const id = e.dataTransfer.getData('text/plain') || dragId; if (!id) return;
  const t = byId(id); if (!t || t.status === col.dataset.status) return;
  setStatus(t, col.dataset.status);
});

function setStatus(t, st) {
  if (t.status !== st) th(t, '⇄', STATUS_LABEL[t.status] + ' → ' + STATUS_LABEL[st]);
  t.status = st;
  if (st === 'doing') {
    if (t.pipeline?.on) {
      if (!runs[t.id] && !['running', 'planning'].includes(t.pipeline.status)) startPipeline(t.id);
    } else if (['agent', 'role'].includes(t.assignee?.kind)) {
      if (!runs[t.id]) startRun(t.id, { byUser: true });
    } else if (!t.assignee) {
      t.assignee = { kind: 'human', name: '我' };
      toast('已自动指派', t.key + ' 已指派给我');
    }
  }
  if (st === 'review' && !t.pr && ['agent', 'role'].includes(t.assignee?.kind)) t.pr = '交付 #' + (S().deliverSeq++);
  if (st === 'done') {
    t.doneAt = now(); S().chart[6]++;
    addActivity('✅', t.key + ' 已归档' + (t.pr ? ' · ' + t.pr : ''));
    toast('任务完成', t.key + ' ' + esc(t.title), '✓');
  }
  save(); refreshViews();
  if (drawerTaskId === t.id) renderDrawer(t.id);
}

/* ============ 任务列表 ============ */
function viewList() {
  const ts = S().tasks.filter(passFilter).sort((a, b) => b.key.localeCompare(a.key));
  return `<table class="tbl"><thead><tr>
    <th>键</th><th>标题</th><th>类型</th><th>优先级</th><th>状态</th><th>经办人</th><th>交付</th></tr></thead>
    <tbody>${ts.map(t => `<tr onclick="openTask('${t.id}')">
      <td style="font-family:var(--mono);font-size:12px;color:var(--ink-faint)">${t.key}</td>
      <td style="font-weight:600">${esc(t.title)}</td>
      <td><span class="ttag ${t.type}">${TYPE_LABEL[t.type] || t.type}</span></td>
      <td><span class="pri ${t.pri}">${t.pri}</span></td>
      <td><span class="st ${t.status}"><span class="dot"></span>${STATUS_LABEL[t.status]}</span></td>
      <td>${t.assignee ? (t.assignee.kind === 'agent' ? ic('bot') + ' ' + esc(t.assignee.name) : t.assignee.kind === 'role' ? ic('star') + ' ' + esc(t.assignee.name) : esc(t.assignee.name)) : '<span style="color:var(--ink-faint)">未指派</span>'}</td>
      <td>${t.pr ? `<span style="font-family:var(--mono);font-size:11px;color:${t.status === 'done' ? 'var(--done)' : 'var(--review)'}">${esc(t.pr)}</span>` : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}

/* ============ Agent 视图 ============ */
function viewAgents() {
  const cards = O().agents.map(a => {
    const cur = a.taskId ? byId(a.taskId) : null;
    const run = a.taskId ? runs[a.taskId] : null;
    const util = a.status === 'working' ? Math.min(96, run ? 20 + runPct(a.taskId) * 0.76 : 40) : 0;
    const modeBadge = a.mode === 'api'
      ? `<span class="mode-pill api" title="OpenAI 兼容 API 调用">真实 API</span>`
      : a.mode === 'cli'
        ? `<span class="mode-pill cli" title="本机 CLI 子进程调用">本机 CLI</span>`
        : `<span class="mode-pill sim" title="本地模拟演示">演示</span>`;
    return `<div class="panel agent-card">
      <div class="agent-top">
        <div class="agent-av">${brandOf(a)}</div>
        <div style="flex:1">
          <h3>${esc(a.name)} ${modeBadge}</h3>
          <div class="agent-meta">${a.mode === 'api' ? esc(providerLabel(a.provider)) + ' · ' + esc(a.model || '—') + (keyOf(a) ? '' : a.__keyLocked ? ' · <b style="color:#c05656">密钥已加密但本机解锁失败</b>' : ' · <b style="color:#c05656">未配置密钥</b>') : a.mode === 'cli' ? (a.runtime === 'cloud' ? ic('cloud') + ' 云端执行 · ' : '本机命令 <b style="font-weight:600">') + (a.runtime === 'cloud' ? esc(a.cliCommand || '—') : '') + (a.runtime === 'cloud' ? '' : '</b>' + (a.detected ? ' · ' + ic('check') + ' 已检测到' : '')) : '本地模拟 · 无需配置'}</div>
        </div>
        <span class="status-pill ${a.status}">${a.status === 'working' ? '<span class="pulse"></span>执行中' : a.status === 'idle' ? '待命' : '离线'}</span>
      </div>
      ${cur ? `<div class="agent-now"><span class="pulse" style="display:inline-block;margin-right:6px"></span>正在执行 <b>${cur.key}</b> ${esc(cur.title)} <span class="lnk" onclick="openTask('${cur.id}')">查看 →</span></div>` : '<div class="agent-now" style="color:var(--ink-faint)">暂无执行中的任务</div>'}
      <div><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-faint)"><span>负载</span><span>${Math.round(util)}%</span></div><div class="util"><i style="width:${util}%"></i></div></div>
      <div class="agent-stats">
        <div><b>${a.done}</b><span>累计完成</span></div>
        <div><b>${fmtTokens(a.tokens)}</b><span>tokens 消耗</span></div>
        <div><b>${a.status === 'working' ? '1' : '0'}</b><span>并发任务</span></div>
      </div>
      ${agentQualityRow(a)}
      <div class="agent-foot">
        ${a.mode === 'api' ? `<button class="btn btn-o btn-sm" onclick="openAgentConfig('${a.id}')">配置</button>` : ''}
        <button class="btn btn-o btn-sm" onclick="toggleAgent('${a.id}')">${a.status === 'offline' ? '上线' : '离线'}</button>
        <button class="btn btn-o btn-sm" onclick="assignNextTo('${a.id}')">领取待处理任务</button>
        <button class="btn btn-o btn-sm btn-danger-o" style="margin-left:auto" onclick="confirmDeleteAgent('${a.id}')" title="删除该 Agent">删除</button>
      </div>
    </div>`;
  }).join('');
  const empty = !O().agents.length ? `<div class="panel" style="grid-column:1/-1;padding:30px;text-align:center">
      <b style="font-size:15px">尚未接入 Agent</b>
      <div style="font-size:13px;color:var(--ink-dim);margin:6px 0 14px">接入 API 服务商或本机 CLI 后，即可将任务指派给 Agent 执行。</div>
      <button class="btn btn-p" onclick="openAddAgentModal()">接入 Agent</button>
    </div>` : '';
  return `<div class="view-head"><h2>Agent</h2><p>API 与本机 CLI 两种接入方式，密钥保存在本机</p>
      <span class="act"><button class="btn btn-p" onclick="openAddAgentModal()">${ic('plus')} 接入 Agent</button></span></div>
    <div class="grid3">${empty}${cards}<div class="add-card" onclick="openAddAgentModal()"><span class="plus">${ic('plus')}</span>接入 Agent</div></div>
    ${viewRoles()}`;
}

/* Agent 质量与成本行：成功率 / 首过率 / 平均耗时 / 累计花费。
   全部为 0 样本时不渲染（新接入的 Agent 不该显示一堆 0%）；未定价的金额单独注明次数，
   避免用户以为「花费 ¥0＝免费」 */
function agentQualityRow(a) {
  const st = a.stats || {};
  const rate = successRate(a.done, st.fail);
  const avg = fmtAvgDuration(a);
  const cost = Number(a.cost) || 0;
  const unpriced = Number(st.unpriced) || 0;
  const items = [];
  if (rate !== null) {
    const cls = rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'bad';
    items.push(`<span class="aq ${cls}" title="成功 ${a.done} 次 / 失败 ${st.fail || 0} 次">成功率 <b>${rate}%</b></span>`);
  }
  /* 首过率只看「交付级完成」：一次通过 N / 共 M 次交付（返工后成功计入分母不计分子） */
  const fp = (typeof window.ExecLog !== 'undefined' && ExecLog.firstPassRate) ? ExecLog.firstPassRate(st.firstPass, st.deliveries) : null;
  if (fp !== null) {
    const fpCls = fp >= 90 ? 'ok' : fp >= 70 ? 'warn' : 'bad';
    items.push(`<span class="aq ${fpCls}" title="一次通过 ${st.firstPass || 0} 次 / 全部交付 ${st.deliveries || 0} 次（返工后成功计入分母）">首过率 <b>${fp}%</b></span>`);
  }
  if (avg) items.push(`<span class="aq" title="按 ${st.runs || 0} 次执行取平均">均耗时 <b>${avg}</b></span>`);
  if (cost > 0) items.push(`<span class="aq" title="按模型单价估算${unpriced ? '（另有 ' + unpriced + ' 次未定价未计入）' : ''}">花费 <b>${fmtMoney(cost)}</b>${unpriced ? ' <i>+' + unpriced + '次未计</i>' : ''}</span>`);
  else if (unpriced > 0) items.push(`<span class="aq" title="该模型未在价格表中，设置里可补单价">花费 <b>未定价</b></span>`);
  if (!items.length) return '';
  return `<div class="agent-quality">${items.join('')}</div>`;
}

/* AI 角色：专用 Agent + 专属模型 + 独有提示词的打包预设，指派任务时直接选 */
function viewRoles() {
  const roles = O().roles || [];
  const rows = roles.map(r => {
    const a = roleAgent(r);
    return `<div class="set-row">
      <div><b>${gic(r.glyph || '☆')} ${esc(r.name)} <span class="mode-pill sim">角色</span></b>
        <div class="set-desc">${a ? '使用 <b>' + esc(a.name) + '</b>' + (r.cliModel && cliCanModel(a) ? ' · 模型 ' + esc(r.cliModel) : '') : '<b style="color:#c05656">未绑定 Agent</b>'} · ${esc(String(r.prompt || '').slice(0, 60))}…</div></div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-o btn-sm" onclick="openRoleModal('${r.id}')">配置</button>
        <button class="btn btn-o btn-sm btn-danger-o" onclick="confirmDeleteRole('${r.id}')">删除</button>
      </div>
    </div>`;
  }).join('');
  const tplChips = ROLE_TEMPLATES.filter(t => !roles.some(r => r.name === t.name))
    .map(t => `<button class="btn btn-o btn-sm" onclick="addRoleFromTemplate('${t.key}')">${t.glyph} ${t.name}</button>`).join('');
  return `<div class="panel" style="margin-top:18px;padding:16px 18px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <h3 style="margin:0;font-size:14px">AI 角色</h3>
      <span style="font-size:12px;color:var(--ink-dim)">专用 Agent + 专属模型 + 独有提示词，指派任务时直接选</span>
      <span style="flex:1"></span>
      <button class="btn btn-o btn-sm" onclick="openRoleModal('')">＋ 自定义角色</button>
    </div>
    ${rows || '<div style="font-size:12.5px;color:var(--ink-faint);padding:6px 0 10px">还没有角色。从模板一键添加，或自定义：</div>'}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${tplChips}</div>
  </div>`;
}
function addRoleFromTemplate(key) {
  const t = ROLE_TEMPLATES.find(x => x.key === key);
  if (!t) return;
  if (!Array.isArray(O().roles)) O().roles = [];
  O().roles.push({ id: 'r' + now(), tpl: t.key, name: t.name, glyph: t.glyph, agentId: '', cliModel: '', prompt: t.prompt });
  save(); refreshViews();
  openRoleModal(O().roles[O().roles.length - 1].id);
  toast('已添加角色', t.name + ' · 请选择绑定的 Agent', '☆');
}
function openRoleModal(roleId) {
  const r = roleById(roleId) || { id: '', name: '', glyph: '☆', agentId: '', cliModel: '', prompt: '' };
  const agentOpts = [{ v: '', l: '（选择 Agent）' }, ...O().agents.map(a => ({ v: a.id, l: a.name }))];
  const bound = r.agentId ? agentById(r.agentId) : null;
  openModal(`<div class="modal-head"><h3>${r.id ? '角色配置' : '新建角色'}</h3><span>专用 Agent + 模型 + 提示词</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-2col">
        <div class="f-row"><label>角色名称</label><input type="text" id="role-name" value="${esc(r.name)}" placeholder="例如 产品经理"></div>
        <div class="f-row"><label>绑定 Agent（执行引擎）</label>${ds('role-agent', agentOpts, r.agentId, 'roleSyncModel()')}</div>
      </div>
      <div class="f-row" id="role-model-row" style="display:none"><label>执行模型（留空用 Agent 默认）</label><input type="text" id="role-model" list="role-model-list" value="${esc(r.cliModel || '')}" placeholder="该 Agent 支持的模型"></div>
      <div class="f-row"><label>角色提示词（执行时注入，与 Agent 场景提示词叠加）</label><textarea id="role-prompt" style="min-height:120px" placeholder="角色定位、职责、工作方式与输出要求">${esc(r.prompt)}</textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-o" onclick="roleTest()">预览提示词</button>
      <span style="flex:1"></span>
      <button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="roleSave('${r.id}')">保存</button>
    </div>`);
  roleSyncModel(bound);
}
function roleSyncModel(preAgent) {
  const a = preAgent || agentById($('#role-agent')?.value || '');
  const row = $('#role-model-row');
  if (row) row.style.display = cliCanModel(a) ? '' : 'none';
  if (a && cliCanModel(a) && window.reins) {
    const inp = $('#role-model');
    if (inp) {
      const dl = $('#role-model-list');
      if (dl) dl.innerHTML = modelOptsSync(a).map(m => `<option value="${esc(m)}">`).join('');
      window.reins.cliModels(a).then(list => {
        if (Array.isArray(list) && list.length && $('#role-model-list')) {
          _modelOpts[a.cliId] = list;
          $('#role-model-list').innerHTML = list.map(m => `<option value="${esc(m)}">`).join('');
        }
      }).catch(() => { });
    }
  }
}
function roleTest() {
  const p = $('#role-prompt')?.value.trim() || '';
  toast('角色提示词预览', p ? p.split('\n')[0].slice(0, 80) : '（空）', '☆');
}
function roleSave(roleId) {
  const name = $('#role-name').value.trim();
  const agentId = $('#role-agent').value;
  if (!name) { toast('请填写角色名称', '', '⚠'); return; }
  if (!agentId) { toast('请选择绑定的 Agent', '角色需要一个执行引擎', '⚠'); return; }
  if (!Array.isArray(O().roles)) O().roles = [];
  const rec = { id: roleId || 'r' + now(), name, glyph: (roleById(roleId) || {}).glyph || '☆', agentId, cliModel: $('#role-model')?.value.trim() || '', prompt: $('#role-prompt').value.trim() };
  const i = O().roles.findIndex(x => x.id === rec.id);
  if (i >= 0) O().roles[i] = rec; else O().roles.push(rec);
  save(); closeModal(); refreshViews();
  toast('已保存角色', name + ' · ' + (agentById(agentId) || {}).name, '☆');
}
function confirmDeleteRole(id) {
  const r = roleById(id); if (!r) return;
  O().roles = O().roles.filter(x => x.id !== id);
  O().spaces.flatMap(sp => sp.tasks || []).forEach(t => { if (t.assignee?.kind === 'role' && t.assignee.id === id) t.assignee = null; });
  save(); refreshViews();
  toast('已删除角色', r.name, '');
}

function toggleAgent(id) {
  const a = agentById(id);
  if (a.status === 'working') { toast('无法离线', a.name + ' 正在执行任务，请先等待完成或终止', '⚠'); return; }
  if (a.mode === 'api' && !keyOf(a) && a.status === 'offline') { toast('缺少密钥', '请先在配置中填写 API Key', ''); openAgentConfig(id); return; }
  a.status = a.status === 'offline' ? 'idle' : 'offline';
  toast(a.name, a.status === 'offline' ? '已离线' : '已上线', a.status === 'offline' ? '■' : '▶');
  addActivity('✳', a.name + (a.status === 'offline' ? ' 已离线' : ' 已上线'));
  save(); refreshViews();
}

/* —— 删除 Agent：执行中拦截；名下任务（含其他空间）改为未指派并留痕 —— */
function confirmDeleteAgent(id) {
  const a = agentById(id); if (!a) return;
  if (a.status === 'working') { toast('无法删除', a.name + ' 正在执行任务，请先等待完成或终止', '⚠'); return; }
  const using = O().spaces.flatMap(sp => sp.tasks || []).filter(t => t.assignee?.kind === 'agent' && t.assignee.id === id);
  (O().roles || []).forEach(r => { if (r.agentId === id) r.agentId = ''; });   // 解绑引用该 Agent 的角色
  openModal(`<div class="modal-head"><h3>删除 Agent</h3><span>${esc(a.name)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将删除 <b>${esc(a.name)}</b>${a.mode === 'api' && a.apiKey ? '（含已保存的 API Key）' : ''}。${using.length ? '其名下 ' + using.length + ' 个任务将改为未指派，执行记录保留。' : '此操作不可撤销。'}</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="deleteAgent('${id}')">确认删除</button></div>`);
}
function deleteAgent(id) {
  const org = O(); const i = org.agents.findIndex(x => x.id === id);
  if (i < 0) { closeModal(); return; }
  const a = org.agents[i];
  if (a.status === 'working') { closeModal(); toast('无法删除', a.name + ' 正在执行任务', '⚠'); return; }
  for (const sp of org.spaces) for (const t of (sp.tasks || [])) {
    if (t.assignee?.kind === 'agent' && t.assignee.id === id) {
      t.assignee = null;
      th(t, '◆', '经办 Agent ' + a.name + ' 已删除，任务改为未指派');
    }
  }
  org.agents.splice(i, 1);
  save(); closeModal(); refreshViews();
  addActivity('🗑', '删除了 Agent ' + a.name);
  toast('已删除', a.name + ' 已移出组织', '✕');
}
function assignNextTo(agentId) {
  const a = agentById(agentId);
  if (!agentUsable(a)) { toast('Agent 不可用', a.mode === 'api' ? '请先配置密钥并上线' : '请先上线', '⚠'); if (a.mode === 'api') openAgentConfig(agentId); return; }
  if (a.status === 'working') { toast('忙线中', a.name + ' 正在执行 ' + byId(a.taskId).key, '▸'); return; }
  const t = S().tasks.filter(x => x.status === 'todo' && x.assignee?.kind !== 'human').sort((x, y) => y.pri.localeCompare(x.pri))[0];
  if (!t) { toast('没有可领取的任务', '待处理列为空', ''); return; }
  t.assignee = { kind: 'agent', id: a.id, name: a.name };
  startRun(t.id, { byUser: true, openDrawer: true });
  save(); refreshViews();
}

/* ============ 提示词库 ============ */
function viewPrompts() {
  const cards = S().prompts.map(p => `<div class="panel prompt-card">
    <h3>${esc(p.title)}</h3>
    <div class="desc">${esc(p.desc)}</div>
    <div class="prompt-body mask">${esc(p.content)}</div>
    <div class="prompt-tags">${p.tags.map(t => `<span class="ttag">#${esc(t)}</span>`).join('')}</div>
    <div class="prompt-foot">
      <button class="btn btn-o btn-sm" onclick="copyPrompt('${p.id}')">复制</button>
      <span class="uses">被附加 ${p.uses} 次</span>
    </div>
  </div>`).join('');
  return `<div class="view-head"><h2>提示词库</h2><p>执行任务时可在详情页附加，随任务一起发给 Agent</p>
      <span class="act"><button class="btn btn-p" onclick="openNewPromptModal()">${ic('plus')} 新建提示词</button></span></div>
    <div class="grid3">${cards}</div>`;
}
function copyPrompt(id) {
  const p = S().prompts.find(x => x.id === id);
  const done = () => toast('已复制', '「' + esc(p.title) + '」已复制到剪贴板', '⧉');
  if (navigator.clipboard) navigator.clipboard.writeText(p.content).then(done, done); else done();
}

/* ============ 自动化 ============ */
function viewAutos() {
  const rows = S().autos.map(a => `<div class="auto-row">
    <div class="ic">${gic(a.icon)}</div>
    <div style="flex:1"><h3>${esc(a.name)}</h3><div class="trig">${esc(a.trigger)}</div>
      <div class="last" style="margin-top:2px">${esc(a.desc)}</div></div>
    <span class="last">上次运行 ${fmtRel(a.lastRun)}</span>
    ${a.runnable ? `<button class="btn btn-o btn-sm" onclick="runAuto('${a.id}')">立即运行</button>` : ''}
    <label class="switch"><input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="toggleAuto('${a.id}')"><i></i></label>
  </div>`).join('');
  return `<div class="view-head"><h2>自动化</h2><p>站会报告、任务分诊与周报生成，可手动或定时运行</p></div>${rows}`;
}
function toggleAuto(id) {
  const a = S().autos.find(x => x.id === id); a.enabled = !a.enabled;
  toast(a.name, a.enabled ? '已启用' : '已停用', a.enabled ? '⚙' : '‖');
  save(); refreshViews();
}
function runAuto(id) {
  const a = S().autos.find(x => x.id === id);
  a.lastRun = now();
  if (id === 'au1') openStandupModal();
  else if (id === 'au2') openTriageBatch();
  else if (id === 'au3') openWeeklyModal();
  save(); refreshViews();
}

function buildStandup(sp?) {
  sp = sp || S();   // 调度空间定向：默认当前空间
  const yst = sp.tasks.filter(t => t.doneAt && t.doneAt > now() - 864e5);
  const doing = sp.tasks.filter(t => t.status === 'doing');
  const focus = sp.tasks.filter(t => t.status === 'todo' && t.pri !== 'P2').sort((a, b) => a.pri.localeCompare(b.pri));
  const who = t => t.assignee ? (t.assignee.kind === 'agent' ? '◆ ' + t.assignee.name + (runs[t.id] ? `（${runPct(t.id)}%）` : '') : t.assignee.name) : '未指派';
  const d = new Date();
  return [
    `# 每日站会 · ${d.getMonth() + 1}月${d.getDate()}日`,
    `> 由自动化例程生成 · Reins`,
    ``,
    `## 近 24h 归档（${yst.length}）`,
    ...(yst.length ? yst.map(t => `- ${t.key} ${t.title} — ${who(t)}${t.pr ? ' · ' + t.pr : ''}`) : ['- 无']),
    ``,
    `## 进行中（${doing.length}）`,
    ...(doing.length ? doing.map(t => `- ${t.key} ${t.title} — ${who(t)}`) : ['- 无']),
    ``,
    `## 今日重点`,
    ...(focus.length ? focus.map(t => `- [${t.pri}] ${t.key} ${t.title}`) : ['- 无']),
    ``,
    `## 风险与阻塞`,
    `- 暂无`,
  ].join('\n');
}
function openStandupModal() {
  const text = buildStandup();
  openModal(`<div class="modal-head"><h3>每日站会报告</h3><span>自动化生成</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div class="standup-out" id="standup-out"></div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">关闭</button>
      <button class="btn btn-p" onclick="copyStandup()">复制全文</button></div>`);
  const box = $('#standup-out'); let i = 0;
  const timer = setInterval(() => {
    i += 3; box.textContent = text.slice(0, i); box.scrollTop = box.scrollHeight;
    if (i >= text.length) clearInterval(timer);
  }, 14);
}
function copyStandup() {
  const done = () => toast('已复制', '站会报告已复制到剪贴板', '⧉');
  if (navigator.clipboard) navigator.clipboard.writeText(buildStandup()).then(done, done); else done();
}

/* —— 周报：真实数据聚合（近 7 天归档 / 待验收 / 迭代进度 / 人与 Agent 产能） —— */
function buildWeekly(sp?, org?) {
  sp = sp || S(); org = org || O();   // 调度空间定向：默认当前空间与组织
  const wk = sp.tasks.filter(t => t.doneAt && t.doneAt > now() - 7 * 864e5);
  const review = sp.tasks.filter(t => t.status === 'review');
  const doing = sp.tasks.filter(t => t.status === 'doing');
  const whoName = t => t.assignee ? (t.assignee.kind === 'agent' ? '◆ ' + t.assignee.name : t.assignee.name) : '未指派';
  const byWho: Record<string, number> = {};
  for (const t of wk) byWho[whoName(t)] = (byWho[whoName(t)] || 0) + 1;
  const iters = (sp.iterations || []).map(it => {
    const ts = sp.tasks.filter(t => t.iterId === it.id);
    const done = ts.filter(t => t.status === 'done').length;
    return { name: it.name, total: ts.length, done, pct: ts.length ? Math.round(done / ts.length * 100) : 0 };
  }).filter(x => x.total);
  const d = new Date();
  const agents = org.agents.filter(a => a.done > 0);
  return [
    `# 周报 · ${sp.name} · ${d.getMonth() + 1}月${d.getDate()}日`,
    `> 由自动化例程生成 · Reins`,
    ``,
    `## 本周概况`,
    `- 归档交付 **${wk.length}** 项 · 待验收 ${review.length} 项 · 进行中 ${doing.length} 项`,
    ``,
    `## 归档明细（近 7 天）`,
    ...(wk.length ? wk.map(t => `- ${t.key} ${t.title} — ${whoName(t)}${t.pr ? ' · ' + t.pr : ''}`) : ['- 本周暂无归档']),
    ``,
    `## 产能（按经办）`,
    ...(Object.keys(byWho).length ? Object.entries(byWho).sort((a, b) => b[1] - a[1]).map(([w, n]) => `- ${w}：${n} 项`) : ['—']),
    ``,
    `## 迭代进度`,
    ...(iters.length ? iters.map(x => `- ${x.name}：${x.done}/${x.total}（${x.pct}%）`) : ['— 当前无进行中的迭代']),
    ``,
    `## Agent 台账`,
    ...(agents.length ? agents.map(a => `- ${a.name}：累计完成 ${a.done} 项 · tokens ${a.tokens >= 1e6 ? (a.tokens / 1e6).toFixed(1) + 'M' : Math.round(a.tokens / 1e3) + 'K'}`) : ['—']),
  ].join('\n');
}
function openWeeklyModal() {
  const text = buildWeekly();
  openModal(`<div class="modal-head"><h3>周报</h3><span>${esc(S().name)} · 自动化生成</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div class="standup-out" id="weekly-out"></div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">关闭</button>
      <button class="btn btn-o" onclick="copyWeekly()">复制全文</button>
      <button class="btn btn-p" onclick="downloadWeekly()">下载 .md</button></div>`);
  const box = $('#weekly-out'); let i = 0;
  const timer = setInterval(() => {
    i += 3; box.textContent = text.slice(0, i); box.scrollTop = box.scrollHeight;
    if (i >= text.length) clearInterval(timer);
  }, 10);
}
function copyWeekly() {
  const done = () => toast('已复制', '周报已复制到剪贴板', '⧉');
  if (navigator.clipboard) navigator.clipboard.writeText(buildWeekly()).then(done, done); else done();
}
function downloadWeekly() {
  const d = new Date();
  const blob = new Blob([buildWeekly()], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `周报-${S().name}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.md`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已下载', a.download, '⇩');
}

/* ============ 集成 ============ */
/* 飞书配置（settings.feishu 的渲染层镜像）：读写都以主进程回包为准，失败如实提示 */
let feishuCfg: any = { enabled: false, appId: '', appSecret: '', chatId: '', baseUrl: 'https://open.feishu.cn', webhookUrl: '', webhookSecret: '', events: { create: true, done: true, reject: true, fail: true }, inbound: false, inboundIntervalMs: 45000, lastSyncAt: 0, lastError: '' };
let feishuStat = null;   // 主进程同步状态快照（status() 结果），打开集成页时刷新
const FEISHU_EVENTS = [['create', '任务创建'], ['done', '完成归档'], ['reject', '验收打回'], ['fail', '执行失败 / 超时']];
function viewInteg() {
  const cfg = hookCfg || {};
  const evs = [['create', '任务创建'], ['done', '完成归档'], ['reject', '验收打回']];
  const roadmap = [['Linear', '双向同步 · 规划中'], ['TAPD', '双向同步 · 规划中'], ['GitHub Issues', '双向同步 · 规划中'], ['GitLab', '双向同步 · 规划中'], ['Jira', '双向同步 · 规划中']];
  const engineSel = cfg.triageEngine || 'auto';
  return `<div class="view-head"><h2>集成</h2><p>任务事件推送、飞书双向同步与分诊引擎</p></div>
    <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:14px;align-items:start">
      <div style="display:grid;gap:14px">
      ${feishuCardHTML()}
      <div class="panel integ-card">
        <div class="integ-brand">
          <div class="lg" style="background:#cf8a3e">${ic('webhook')}</div>
          <div><h3>Webhook 开放接口</h3><span>任务事件实时推送到任意系统</span></div>
          <span class="status-pill ${cfg.webhookUrl ? 'idle' : 'offline'}" style="margin-left:auto">${cfg.webhookUrl ? '已配置' : '未配置'}</span>
        </div>
        <div class="integ-desc">任务事件会以 JSON POST 发送到你指定的地址，群机器人、自动化平台或自建服务均可直接接收。地址填飞书机器人时自动改用飞书卡片协议（加签密钥见上方飞书配置）。</div>
        ${window.reins ? `
        <div class="f-row"><label>推送地址（http:// 或 https://）</label><input type="text" id="wh-url" value="${esc(cfg.webhookUrl || '')}" placeholder="https://example.com/webhook"></div>
        <div class="f-row" style="flex-direction:row;align-items:center;gap:16px;flex-wrap:wrap">
          ${evs.map(([k, l]) => `<label class="f-check" style="margin:0"><input type="checkbox" id="wh-ev-${k}" ${!cfg.webhookEvents || cfg.webhookEvents[k] !== false ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
        <div style="display:flex;gap:9px;margin-top:4px">
          <button class="btn btn-p" onclick="whSave()">保存配置</button>
          <button class="btn btn-o" onclick="whTest()">发送测试</button>
        </div>
        <div class="sync-log" id="wh-log" style="margin-top:12px"></div>`
        : `<div class="sync-log"><div><span style="color:#87919a">浏览器预览模式下不可用，请在桌面客户端中配置。</span></div></div>`}
      </div>
      <div class="panel integ-card">
        <div class="integ-brand">
          <div class="lg" style="background:#6f6ac2">${ic('chart-column')}</div>
          <div><h3>Jev 决策引擎</h3><span>TypeSafe AI · 结构化分诊判断</span></div>
          <span class="status-pill ${secretOf(cfg.jevKey) ? 'idle' : 'offline'}" style="margin-left:auto">${secretOf(cfg.jevKey) ? '已配置' : secretLocked(cfg.jevKey) ? '已加密 · 本机解锁失败' : '未配置'}</span>
        </div>
        <div class="integ-desc">将任务分诊（类型、优先级、经办人）交给决策模型：输入任务与候选名单，输出带概率的结构化建议，适合批量分诊。不配置时继续用 API 模型分诊。</div>
        ${window.reins ? `
        <div class="f-row"><label>API Key（console.typesafe.ai 创建）</label>${secretLocked(cfg.jevKey) ? '<div class="set-desc" style="margin:0 0 6px;color:#c05656">' + ic('triangle-alert') + ' 该密钥已加密但本机解锁失败（系统钥匙串变更？）：留空保存可保留密文，重新填写则覆盖。</div>' : ''}<input type="password" id="jev-key" value="${esc(secretOf(cfg.jevKey))}" placeholder="${secretLocked(cfg.jevKey) ? '重新填写以覆盖…' : 'sk-…'}"></div>
        <div class="f-row"><label>接入地址（兼容 systemone 协议即可）</label><input type="text" id="jev-url" value="${esc(cfg.jevUrl || 'https://api.typesafe.ai/v1/systemone')}" placeholder="https://api.typesafe.ai/v1/systemone"></div>
        <div class="f-2col">
          <div class="f-row"><label>模型</label><input type="text" id="jev-model" value="${esc(cfg.jevModel || 'jev-latest')}" placeholder="jev-latest"></div>
          <div class="f-row"><label>分诊引擎</label>${ds('jev-engine', [
            { v: 'auto', l: '自动（Jev 优先，失败降级模型）' },
            { v: 'jev', l: '仅 Jev（失败降级本地规则）' },
            { v: 'llm', l: '仅 API 模型（不用 Jev）' },
          ], engineSel)}</div>
        </div>
        <div style="display:flex;gap:9px;margin-top:4px">
          <button class="btn btn-p" onclick="jevSave()">保存配置</button>
          <button class="btn btn-o" onclick="jevTest()">测试连接</button>
        </div>
        <div class="sync-log" id="jev-log" style="margin-top:12px"></div>`
        : `<div class="sync-log"><div><span style="color:#87919a">浏览器预览模式下不可用，请在桌面客户端中配置。</span></div></div>`}
      </div>
      </div>
      <div>
        <div class="integ-grid-mini">${roadmap.map(o => `<div class="mini-integ" style="opacity:.75">${o[0]}<span>${o[1]}</span></div>`).join('')}</div>
        <div class="panel" style="margin-top:14px;font-size:13px;color:var(--ink-dim)">
          <b style="color:var(--ink)">关于集成方式</b><br>飞书用「自建应用 + 群机器人」双通道：应用负责发卡片、读群指令，机器人只做出站推送。Webhook 仍是通用兜底，任何能接收 HTTP 的系统都能对接；决策模型负责分诊这类高频判断，不占用通用模型。
        </div>
      </div>
    </div>`;
}

/* —— 飞书接入卡片：应用信息 / 群机器人 / 事件开关 / 群指令同步 —— */
function feishuCardHTML() {
  const f = feishuCfg || {};
  const appReady = !!(f.appId && f.appSecret && f.chatId);
  const badge = !f.enabled ? '未启用' : appReady ? '应用已配置' : f.webhookUrl ? '机器人已配置' : '待配置';
  const badgeCls = !f.enabled ? 'offline' : (appReady || f.webhookUrl) ? 'idle' : 'offline';
  const locked = !!hookCfg.__feishuLocked;
  const st = feishuStat || {};
  const ev = f.events || {};
  const logRows = (st.recent || []).slice(0, 8).map(r =>
    `<div class="ln ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗'} ${esc(r.label)}${r.via ? ' · ' + (r.via === 'app' ? '应用' : '机器人') : ''}${r.ok ? '' : ' — ' + esc(r.error || '')}</div>`
  ).join('');
  return `<div class="panel integ-card">
    <div class="integ-brand">
      <div class="lg" style="background:#3370ff">${ic('message-square')}</div>
      <div><h3>飞书</h3><span>自建应用 + 群机器人 · 双向同步</span></div>
      <span class="status-pill ${badgeCls}" style="margin-left:auto">${badge}</span>
    </div>
    <div class="integ-desc">任务事件、执行失败、站会/周报/每日摘要以卡片推送到飞书群；开启「读取群指令」后，群内 <code>/reins new 标题</code> 可直接在 Reins 建任务，<code>/reins status</code> 看进度。</div>
    ${window.reins ? `
    <label class="f-check" style="margin:0"><input type="checkbox" id="fs-enabled" ${f.enabled ? 'checked' : ''}> 启用飞书推送</label>
    <div class="fs-group">
      <div class="fs-group-title">自建应用（发卡片 + 读群指令）</div>
      <div class="f-2col">
        <div class="f-row"><label>App ID</label><input type="text" id="fs-appid" value="${esc(f.appId || '')}" placeholder="cli_xxxxxxxxxxxx"></div>
        <div class="f-row"><label>App Secret</label><input type="password" id="fs-secret" value="${esc(secretOf(f.appSecret))}" placeholder="${secretLocked(f.appSecret) ? '重新填写以覆盖…' : '应用凭证里的 App Secret'}" autocomplete="off"></div>
      </div>
      <div class="f-2col">
        <div class="f-row"><label>群 chat_id</label><input type="text" id="fs-chat" value="${esc(f.chatId || '')}" placeholder="oc_xxxxxxxxxxxx"></div>
        <div class="f-row"><label>开放平台域名</label><input type="text" id="fs-base" value="${esc(f.baseUrl || 'https://open.feishu.cn')}" placeholder="https://open.feishu.cn"></div>
      </div>
      ${secretLocked(f.appSecret) || locked ? '<div class="set-desc" style="color:#c05656">' + ic('triangle-alert') + ' 应用密钥已加密但本机解锁失败：留空保存保留密文，重新填写则覆盖。</div>' : ''}
    </div>
    <div class="fs-group">
      <div class="fs-group-title">群机器人（仅推送，无需应用审核）</div>
      <div class="f-2col">
        <div class="f-row"><label>Webhook 地址</label><input type="text" id="fs-hook" value="${esc(f.webhookUrl || '')}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"></div>
        <div class="f-row"><label>加签密钥（可选）</label><input type="password" id="fs-hooksecret" value="${esc(secretOf(f.webhookSecret))}" placeholder="机器人「加签」开关里的密钥" autocomplete="off"></div>
      </div>
    </div>
    <div class="f-row" style="flex-direction:row;align-items:center;gap:16px;flex-wrap:wrap">
      ${FEISHU_EVENTS.map(([k, l]) => `<label class="f-check" style="margin:0"><input type="checkbox" id="fs-ev-${k}" ${ev[k] !== false ? 'checked' : ''}> ${l}</label>`).join('')}
    </div>
    <div class="f-2col" style="align-items:end">
      <label class="f-check" style="margin:0"><input type="checkbox" id="fs-inbound" ${f.inbound ? 'checked' : ''}> 读取群指令（/reins new、status、list）</label>
      <div class="f-row" style="margin:0"><label>同步间隔（秒）</label><input type="number" id="fs-interval" min="15" max="600" step="5" value="${Math.round((f.inboundIntervalMs || 45000) / 1000)}"></div>
    </div>
    <div style="display:flex;gap:9px;margin-top:4px;flex-wrap:wrap">
      <button class="btn btn-p" onclick="feishuSave()">保存配置</button>
      <button class="btn btn-o" onclick="feishuTestBtn()">发送测试卡片</button>
      <button class="btn btn-o" onclick="feishuSyncNow()">立即同步群消息</button>
    </div>
    <div class="set-desc" data-fs-status style="margin-top:2px">
      同步状态：${st.inboundRunning ? '<b style="color:var(--accent)">运行中</b>' : (f.inbound ? '已开启（保存后启动）' : '未开启')}
      ${st.lastSyncAt ? ' · 上次拉取 ' + fmtRel(st.lastSyncAt) : ''}
      ${st.lastError ? '<br><span style="color:#c05656">最近错误：' + esc(st.lastError) + '</span>' : ''}
    </div>
    <div class="sync-log" id="fs-log" style="margin-top:10px">${logRows || '<div><span style="color:#87919a">尚无推送记录。</span></div>'}</div>`
    : `<div class="sync-log"><div><span style="color:#87919a">浏览器预览模式下不可用，请在桌面客户端中配置。</span></div></div>`}
  </div>`;
}

/* 读取主进程同步状态并重绘卡片里的日志/状态行（不整页刷新，避免输入框内容丢失） */
async function hydrateFeishu() {
  if (!window.reins) return;
  try { feishuStat = await window.reins.feishuStatus(); } catch (e) { feishuStat = null; }
  const card = document.querySelector('.integ-card .fs-group')?.closest('.integ-card');
  if (!card) return;
  /* 只替换状态行与日志，表单保持用户当前输入 */
  const desc = card.querySelector('.set-desc[data-fs-status]') || null;
  if (desc && feishuStat) {
    const st = feishuStat;
    desc.innerHTML = `同步状态：${st.inboundRunning ? '<b style="color:var(--accent)">运行中</b>' : (st.inbound ? '已开启（保存后启动）' : '未开启')}`
      + (st.lastSyncAt ? ' · 上次拉取 ' + fmtRel(st.lastSyncAt) : '')
      + (st.lastError ? '<br><span style="color:#c05656">最近错误：' + esc(st.lastError) + '</span>' : '');
  }
  const log = document.getElementById('fs-log');
  if (log) {
    const rows = (feishuStat && feishuStat.recent || []).slice(0, 8).map(r =>
      `<div class="ln ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗'} ${esc(r.label)}${r.via ? ' · ' + (r.via === 'app' ? '应用' : '机器人') : ''}${r.ok ? '' : ' — ' + esc(r.error || '')}</div>`
    ).join('');
    log.innerHTML = rows || '<div><span style="color:#87919a">尚无推送记录。</span></div>';
  }
}

/* 收集表单 → 保存（密钥留空且现值是密文时原样带回，与其它密钥表单同语义） */
function feishuSave() {
  const appSecret = secretPick($('#fs-secret').value, feishuCfg.appSecret);
  const webhookSecret = secretPick($('#fs-hooksecret').value, feishuCfg.webhookSecret);
  const baseUrl = ($('#fs-base').value || '').trim() || 'https://open.feishu.cn';
  const webhookUrl = ($('#fs-hook').value || '').trim();
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) { toast('域名无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) { toast('Webhook 地址无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  const events = {};
  for (const k of FEISHU_EVENTS.map(x => x[0])) events[k] = !!$('#fs-ev-' + k)?.checked;
  const interval = Math.min(Math.max(Number($('#fs-interval')?.value) || 45, 15), 600) * 1000;
  const patch: any = {
    enabled: !!$('#fs-enabled')?.checked,
    appId: ($('#fs-appid').value || '').trim(),
    chatId: ($('#fs-chat').value || '').trim(),
    baseUrl,
    webhookUrl,
    inbound: !!$('#fs-inbound')?.checked,
    inboundIntervalMs: interval,
    events,
  };
  /* 密钥：密文对象原样带回，字符串则覆盖（留空即清空明文密钥） */
  if (appSecret !== undefined) patch.appSecret = appSecret;
  if (webhookSecret !== undefined) patch.webhookSecret = webhookSecret;
  window.reins.setSettings({ feishu: patch }).then(r => {
    const s = settingsApplied(r);
    if (!s) return;
    hookCfg = { ...hookCfg, ...s, feishu: s.feishu || hookCfg.feishu };
    feishuCfg = { ...feishuCfg, ...(s.feishu || {}) };
    const okApp = !!(feishuCfg.appId && feishuCfg.appSecret && feishuCfg.chatId);
    toast('飞书配置已保存', !feishuCfg.enabled ? '推送处于关闭状态' : okApp ? '事件将推送到飞书群' : feishuCfg.webhookUrl ? '将走群机器人推送' : '还缺应用信息或机器人地址', '⇄');
    render();
  });
}

async function feishuTestBtn() {
  const log = $('#fs-log');
  if (log) log.innerHTML = '<div class="ln act">▸ 正在发送测试卡片…</div>';
  /* 用页面上的临时配置测试：先填后测，不必先保存（密钥留空时用已存的） */
  const override = {
    enabled: true,
    appId: ($('#fs-appid')?.value || '').trim() || feishuCfg.appId,
    appSecret: secretPick($('#fs-secret')?.value, feishuCfg.appSecret),
    chatId: ($('#fs-chat')?.value || '').trim() || feishuCfg.chatId,
    baseUrl: ($('#fs-base')?.value || '').trim() || feishuCfg.baseUrl,
    webhookUrl: ($('#fs-hook')?.value || '').trim() || feishuCfg.webhookUrl,
    webhookSecret: secretPick($('#fs-hooksecret')?.value, feishuCfg.webhookSecret),
  };
  const r = await window.reins.feishuTest(override).catch(e => ({ ok: false, error: e.message }));
  if (log) {
    log.innerHTML = r && r.ok
      ? `<div class="ln ok">✓ 测试卡片已发送（${r.via === 'app' ? '自建应用' : '群机器人'}${r.note ? ' · ' + esc(r.note) : ''}），请到飞书群确认</div>`
      : `<div class="ln err">✗ 发送失败：${esc((r && r.error) || '未知错误')}</div>`;
  }
  if (r && r.ok) toast('测试已发送', '请到飞书群查看卡片', '✓');
  else toast('发送失败', esc((r && r.error) || ''), '⚠');
}

async function feishuSyncNow() {
  const log = $('#fs-log');
  if (log) log.innerHTML = '<div class="ln act">▸ 正在拉取群消息…</div>';
  const r = await window.reins.feishuSync().catch(e => ({ ok: false, error: e.message }));
  if (log) {
    if (r && r.ok) {
      const h = (r.handled || []).map(x => '· ' + x.cmd + (x.ok ? ' ✓' : ' ✗' + (x.error ? ' ' + esc(x.error) : ''))).join('\n');
      log.innerHTML = `<div class="ln ok">✓ 已拉取 ${r.pulled || 0} 条消息，识别 ${(r.handled || []).length} 条指令</div>` + (h ? `<div class="ln">${h}</div>` : '');
    } else {
      log.innerHTML = `<div class="ln err">✗ 同步失败：${esc((r && r.error) || '未知错误')}</div>`;
    }
  }
  hydrateFeishu();
}

/* —— 飞书群指令处理：主进程把群消息解析成指令后反过来调用这里（任务状态在渲染层） ——
   返回结构化数据由主进程组装成回执卡片；未识别的指令返回 error 让群里看到用法提示 */
function handleFeishuCall(req) {
  const channel = req && req.channel;
  const payload = (req && req.payload) || {};
  if (channel !== 'command') return { error: '未知的主进程调用：' + channel };
  const cmd = String(payload.cmd || '');
  const arg = String(payload.arg || '').trim();
  const spaceName = S() ? S().name : '';
  if (cmd === 'status') {
    const t = S().tasks || [];
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    return {
      ok: true, space: spaceName,
      doing: t.filter(x => x.status === 'doing').length,
      todo: t.filter(x => x.status === 'todo').length,
      review: t.filter(x => x.status === 'review').length,
      doneToday: t.filter(x => x.doneAt && x.doneAt >= dayStart.getTime()).length,
      recent: t.filter(x => x.status === 'done' && x.doneAt).sort((a, b) => b.doneAt - a.doneAt).slice(0, 5)
        .map(x => x.key + ' ' + x.title),
    };
  }
  if (cmd === 'list') {
    const t = (S().tasks || []).filter(x => x.status !== 'done')
      .sort((a, b) => String(a.pri).localeCompare(String(b.pri)));
    return {
      ok: true,
      tasks: t.map(x => ({ key: x.key, title: x.title, status: x.status, pri: x.pri, assignee: x.assignee?.name || '' })),
    };
  }
  if (cmd === 'new') {
    /* 标题与描述用「|」或换行分开：/reins new 登录页改版 | 加验证码与错误提示 */
    const [title0, ...rest] = arg.split(/\s*[|｜]\s*|\n/);
    const title = String(title0 || '').trim();
    if (!title) return { error: '请给出任务标题：/reins new 任务标题 | 可选描述' };
    const task = {
      id: 't' + S().seq, key: 'REINS-' + S().seq,
      title: title.slice(0, 120), type: 'chore', pri: 'P2',
      desc: String(rest.join('\n') || '').trim().slice(0, 2000), status: 'todo',
      assignee: null, tags: ['飞书'], pr: null, result: null, thread: [], attachPrompt: null,
      comments: [{ who: '飞书', text: '来自飞书群指令' + (payload.operator ? '（' + payload.operator + '）' : ''), at: now() }],
      repoRoot: '', runModel: '', modelParams: null, createdAt: now(), doneAt: null,
    };
    S().tasks.push(task); S().seq++;
    th(task, '🔗', '通过飞书群指令创建');
    addActivity('🔗', '飞书群创建了 ' + task.key + ' ' + task.title);
    save();
    /* 群指令建的任务只在群里回执；不再反向推回飞书（否则群里会出现「自己创建自己」的重复卡片） */
    refreshViews();
    return { ok: true, task: { key: task.key, title: task.title, desc: task.desc } };
  }
  if (cmd === 'help') return { ok: true };
  /* 群内审批（P2）：approve / reject / revoke 直接作用于任务，语义与客户端按钮一致。
     这是「在飞书里点通过」的替代实现——飞书卡片按钮回调需要公网地址，
     与轮询架构不兼容，故用同一条拉取通道承载审批动作。 */
  if (cmd === 'approve' || cmd === 'reject' || cmd === 'revoke') {
    const key = String(payload.taskKey || '').trim().toUpperCase();
    if (!key) return { error: '请给出任务号：/reins ' + cmd + ' REINS-42' + (cmd === 'reject' ? ' 原因' : '') };
    const t = S().tasks.find(x => String(x.key).toUpperCase() === key);
    if (!t) return { error: '找不到任务 ' + key + '（当前空间：' + spaceName + '）' };
    const reason = String(payload.reason || '').trim();
    if (cmd === 'approve') {
      /* 判定走共享迁移规则（taskflow.js），与客户端「归档」按钮同一份判定源 */
      const v = TaskFlow.approve(t);
      if (!v.ok) return { error: v.message.replace('需先确认应用或放弃', '需先在 Reins 客户端确认应用或放弃') };
      th(t, '✅', '飞书群指令验收通过并归档');
      setStatus(t, 'done');
      addActivity('✅', t.key + ' 经飞书群验收通过，已归档');
      notifyHook('task.done', t);
      save(); refreshViews();
      return { ok: true, task: { key: t.key, title: t.title, status: 'done' }, action: 'approve' };
    }
    if (cmd === 'reject') {
      /* 变更计划走共享迁移规则（taskflow.js），与客户端 doReject 同一份判定源
         （此前两处各写一份，飞书侧漏记打回次数，首过率口径曾分叉） */
      const v = TaskFlow.reject(t, reason, '飞书群');
      if (!v.ok) return { error: v.message };
      TaskFlow.applyReject(t, v);   // 应用层同源（thread/状态/打回计数/流水线重置）
      t.comments.push({ who: '飞书', text: v.commentText, at: now() });
      th(t, '↩️', '飞书群验收打回：' + v.feedback.slice(0, 40));
      if (v.resetPipeline) th(t, '🧭', v.pipelineTimeline);
      addActivity('↩️', t.key + ' 经飞书群打回，等待重做');
      notifyHook('task.rejected', t);
      notifyFeishu('task.rejected', t, { reason: v.feedback.slice(0, 300) });
      save(); refreshViews();
      return { ok: true, task: { key: t.key, title: t.title, status: 'todo' }, action: 'reject', reason: v.feedback };
    }
    /* revoke：撤回验收（待验收 → 回到进行中），用于误点通过前反悔或重新指派。
       判定同样走共享规则 */
    {
      const v = TaskFlow.revoke(t);
      if (!v.ok) return { error: v.message.replace('请打回并附原因', '请用 /reins reject ' + key + ' 原因') };
      t.status = v.to;
      th(t, '↩', '飞书群指令撤回验收，回到进行中');
      addActivity('↩', t.key + ' 经飞书群撤回验收');
      save(); refreshViews();
      return { ok: true, task: { key: t.key, title: t.title, status: 'doing' }, action: 'revoke' };
    }
  }
  return { error: '无法识别的指令：' + (arg || cmd) + '（发送 /reins help 查看用法）' };
}


function whSave() {
  const url = $('#wh-url').value.trim();
  if (url && !/^https?:\/\//.test(url)) { toast('地址无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  const evs = {};
  for (const k of ['create', 'done', 'reject']) evs[k] = $('#wh-ev-' + k).checked;
  /* settings:set 契约收口（返工①）：此前整档回传会把 {ok,settings} 混进 hookCfg，
     写失败时还照弹「已保存」；成功提示移入回调，失败由 settingsApplied 如实报出 */
  window.reins.setSettings({ webhookUrl: url, webhookEvents: evs }).then(r => {
    const s = settingsApplied(r);
    if (!s) return;
    hookCfg = { ...hookCfg, ...s, feishu: s.feishu || hookCfg.feishu };
    toast('已保存', url ? '事件将推送到 ' + esc(url.slice(0, 48)) : '已清空推送地址', '⇄');
    render();
  });
}
async function whTest() {
  const url = $('#wh-url').value.trim();
  if (url && !/^https?:\/\//.test(url)) { toast('地址无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  if (url && url !== (hookCfg.webhookUrl || '')) {
    const s = settingsApplied(await window.reins.setSettings({ webhookUrl: url }));
    if (s) hookCfg = { ...hookCfg, ...s, feishu: s.feishu || hookCfg.feishu };
  }
  const log = $('#wh-log'); log.innerHTML = '<div class="ln act">▸ 正在发送测试事件…</div>';
  const r = await window.reins.webhookTest();
  log.innerHTML = r.ok
    ? '<div class="ln ok">✓ 测试事件已送达（HTTP ' + r.status + '），请到接收端确认</div>'
    : '<div class="ln err">✗ 送达失败：' + esc(r.error || ('HTTP ' + r.status)) + '</div>';
}
function jevSave() {
  const key = $('#jev-key').value.trim();
  const url = $('#jev-url').value.trim() || 'https://api.typesafe.ai/v1/systemone';
  const model = $('#jev-model').value.trim() || 'jev-latest';
  const engine = $('#jev-engine').value;
  if (!/^https?:\/\//.test(url)) { toast('地址无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  /* settings:set 契约收口（返工①）：同 whSave，成功提示移入回调、失败如实报出。
     jevKey 留空且现值是未解锁密文时原样带回，不把密文副本抹成空串（同 Agent 表单语义） */
  window.reins.setSettings({ jevKey: secretPick(key, hookCfg.jevKey), jevUrl: url, jevModel: model, triageEngine: engine }).then(r => {
    const s = settingsApplied(r);
    if (!s) return;
    hookCfg = { ...hookCfg, ...s, feishu: s.feishu || hookCfg.feishu };
    toast('已保存', key ? '分诊将优先使用 Jev' : '已清空 Jev 配置，分诊改用 API 模型', '⚖');
    render();
  });
}
async function jevTest() {
  const cfg = {
    jevKey: $('#jev-key').value.trim(),
    jevUrl: $('#jev-url').value.trim() || 'https://api.typesafe.ai/v1/systemone',
    jevModel: $('#jev-model').value.trim() || 'jev-latest',
  };
  const log = $('#jev-log');
  if (!cfg.jevKey) { log.innerHTML = '<div class="ln err">✗ 请先填写 API Key</div>'; return; }
  log.innerHTML = '<div class="ln act">▸ 正在请求 Jev…</div>';
  const r = await window.reins.jevTest(cfg);
  log.innerHTML = r && r.ok
    ? '<div class="ln ok">✓ ' + esc(r.message) + '</div>'
    : '<div class="ln err">✗ ' + esc((r && r.message) || '调用失败') + '</div>';
}


/* ============ 概览 ============ */
function viewDash() {
  const doing = S().tasks.filter(t => t.status === 'doing');
  const review = S().tasks.filter(t => t.status === 'review');
  const doneToday = S().tasks.filter(t => t.doneAt && new Date(t.doneAt).toDateString() === today());
  const online = O().agents.filter(a => a.status !== 'offline');
  const working = O().agents.filter(a => a.status === 'working');
  const max = Math.max(...S().chart, 1);
  const labels = S().chart.map((v, i) => {
    const d = new Date(now() - (6 - i) * 864e5);
    return i === 6 ? '今天' : ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  });
  const bars = S().chart.map((v, i) => `<div class="bar-w ${i === 6 ? 'today' : ''}"><span style="font-size:11px;font-family:var(--mono);color:var(--ink-dim)">${v}</span><div class="bar" style="height:${Math.round(v / max * 100)}%"></div><span class="lbl">${labels[i]}</span></div>`).join('');
  const utilRows = O().agents.map(a => {
    const cur = a.taskId ? byId(a.taskId) : null;
    const live = a.status === 'working';
    const u = live ? Math.min(96, a.taskId && runs[a.taskId] ? 20 + runPct(a.taskId) * 0.76 : 40) : 0;
    /* 调音台语法：执行中的通道升起十段电平梯，空闲通道推子归零——只留一条熄灭细槽 */
    const segN = live ? 10 : 1;
    const lit = Math.max(u > 0 ? 1 : 0, Math.round(u / 10));
    const segs = Array.from({ length: segN }, (_, i) => `<i${live && i < lit ? ' class="on"' : ''}></i>`).join('');
    return `<div class="vu-row${live ? ' live' : ''}">
      <span class="vu-name">${brandOf(a)} ${esc(a.name)}</span>
      <div class="vu-lad">${segs}</div>
      <span class="vu-rd">${cur ? cur.key + ' · ' + Math.round(u) + '%' : '空闲'}</span>
    </div>`;
  }).join('');
  return `<div class="stats">
      <div class="stat"><span class="ic" style="color:var(--doing)">${ic('play')}</span><b>${doing.length}</b><span>进行中<i class="zen">DOING</i></span><div class="trend">含 Agent 执行 ${doing.filter(t => t.assignee?.kind === 'agent').length} 项</div></div>
      <div class="stat"><span class="ic" style="color:var(--review)">${ic('clock')}</span><b>${review.length}</b><span>待验收<i class="zen">REVIEW</i></span><div class="trend">需人工验收</div></div>
      <div class="stat"><span class="ic" style="color:var(--done)">${ic('check')}</span><b>${doneToday.length}</b><span>今日归档<i class="zen">DONE TODAY</i></span></div>
      <div class="stat"><span class="ic" style="color:var(--accent)">${ic('bot')}</span><b>${working.length}/${online.length}</b><span>Agent 执行中 / 在线<i class="zen">ON DUTY</i></span></div>
    </div>
    ${dashCostRow()}
    <div class="grid2" style="margin-bottom:14px">
      <div class="panel"><h3 style="font-size:14px;margin-bottom:4px">近 7 日吞吐<i class="zen">THROUGHPUT</i></h3><span style="font-size:12px;color:var(--ink-faint)">归档任务数 / 天</span><div class="chart">${bars}</div></div>
      <div class="panel"><h3 style="font-size:14px;margin-bottom:14px">Agent 负载<i class="zen">LOAD</i></h3>${utilRows || '<div class="panel-empty">还没有 Agent。到「Agent」页接入后，执行负载的电平会在这里点亮。</div>'}</div>
    </div>
    ${dashExecList()}
    <div class="panel"><h3 style="font-size:14px;margin-bottom:6px">最近动态</h3>
      <ul class="feed">${S().activity.slice(0, 10).map(a => `<li><span class="fic">${gic(a.icon)}</span><div><div>${esc(a.text)}</div><div class="ft">${fmtRel(a.at)}</div></div></li>`).join('')}</ul>
    </div>`;
}

/* 概览·成本条：今日 / 累计花费 + 成功率总览。
   逐日口径来自执行流水表（org.execLog 逐次落账）——今日 = 本地日历日内的花费与次数；
   计价在途（主进程回包未到）的条目单列「计价中」，不假装是最终数字 */
function dashCostRow() {
  const agents = O().agents || [];
  if (!agents.length) return '';
  const totalCost = agents.reduce((n, a) => n + (Number(a.cost) || 0), 0);
  const unpriced = agents.reduce((n, a) => n + ((a.stats && Number(a.stats.unpriced)) || 0), 0);
  const done = agents.reduce((n, a) => n + (Number(a.done) || 0), 0);
  const fail = agents.reduce((n, a) => n + ((a.stats && Number(a.stats.fail)) || 0), 0);
  const rate = successRate(done, fail);
  const rateCls = rate === null ? '' : rate >= 90 ? 'ok' : rate >= 70 ? 'warn' : 'bad';
  let todayPill = '';
  if (typeof window.ExecLog !== 'undefined' && Array.isArray(O().execLog) && O().execLog.length) {
    const td = ExecLog.sumDay(O().execLog, ExecLog.dayOf(Date.now()));
    if (td.runs) {
      todayPill = `<span class="aq" title="今日 ${td.runs} 次执行 · tokens ${td.tokens}${td.pending ? ' · 另有 ' + td.pending + ' 次计价中' : ''}${td.unpriced ? ' · ' + td.unpriced + ' 次未定价' : ''}">今日 <b>${fmtMoney(td.cost)}</b> · ${td.runs} 次${td.pending ? ' +' + td.pending + '计价中' : ''}</span>`;
    }
  }
  return `<div class="panel cost-bar">
    <span class="cb-title">${ic('chart-column')} 成本与质量</span>
    <span class="aq">累计花费 <b>${fmtMoney(totalCost)}</b></span>
    ${todayPill}
    <span class="aq">累计 tokens <b>${fmtTokens(agents.reduce((n, a) => n + (Number(a.tokens) || 0), 0))}</b></span>
    ${rate !== null ? `<span class="aq ${rateCls}">整体成功率 <b>${rate}%</b></span>` : ''}
    ${unpriced ? `<span class="aq" title="设置 → 模型与密钥 → 模型价格表 可补充单价">未定价执行 <b>${unpriced}</b> 次</span>` : ''}
    <span class="cb-hint">金额按设置里的模型单价估算，与厂商账单口径可能略有差异</span>
  </div>`;
}

/* 概览·近 7 日花费柱状图（流水表逐日汇总；悬停看次数/未定价/计价中明细）。
   与「近 7 日吞吐」同一套 .chart/.bar-w 视觉语言 */
function dashCostChart() {
  if (typeof window.ExecLog === 'undefined') return '';
  const log = O().execLog || [];
  if (!log.length) return '';
  const buckets = ExecLog.daysBuckets(log, 7, Date.now());
  const max = Math.max(...buckets.map(b => b.cost), 0.0001);
  const wk = ['日', '一', '二', '三', '四', '五', '六'];
  const bars = buckets.map((b, i) => {
    const d = new Date(b.day + 'T00:00:00');
    const label = i === buckets.length - 1 ? '今天' : '周' + wk[d.getDay()];
    const tip = b.day + ' · ' + fmtMoney(b.cost) + ' · ' + b.runs + ' 次执行'
      + (b.unpriced ? ' · ' + b.unpriced + ' 次未定价' : '') + (b.pending ? ' · ' + b.pending + ' 次计价中' : '');
    const h = b.cost > 0 ? Math.max(10, Math.round(b.cost / max * 100)) : 2;
    const num = b.cost > 0 ? fmtMoney(b.cost).replace('¥', '') : '';
    return `<div class="bar-w ${i === buckets.length - 1 ? 'today' : ''}" title="${esc(tip)}"><span style="font-size:10px;font-family:var(--mono);color:var(--ink-faint)">${num}</span><div class="bar" style="height:${h}%"></div><span class="lbl">${label}</span></div>`;
  }).join('');
  return `<div class="dcc-wrap"><span style="font-size:12px;font-weight:600">近 7 日花费</span><div class="chart" style="height:64px">${bars}</div></div>`;
}

/* 概览·最近执行明细（流水表倒序 12 条：时间 / 任务 / Agent·模型 / 结果 / 耗时 / tokens / 花费） */
function dashExecList() {
  if (typeof window.ExecLog === 'undefined') return '';
  const log = O().execLog || [];
  if (!log.length) return '';
  const rows = ExecLog.recent(log, 12).map(e => {
    const cost = e.priced === true && Number.isFinite(+e.cost) ? fmtMoney(e.cost)
      : e.priced === false ? '<i class="xl-dim">未定价</i>' : '<i class="xl-dim">计价中</i>';
    const dur = e.ms >= 1000 ? Math.round(e.ms / 1000) + 's' : (e.ms || '');
    return `<div class="xl-row">
      <span class="xl-time">${fmtRel(e.at)}</span>
      <span class="xl-task" title="${esc(e.taskKey + ' ' + e.taskTitle)}">${esc(e.taskKey || '—')}${e.stage ? '<i class="xl-stage">' + esc(e.stage) + '</i>' : ''}</span>
      <span class="xl-agent" title="${esc(e.agentName + ' · ' + e.model)}">${esc(e.agentName || '—')}<i class="xl-dim">${esc(String(e.model || '').slice(0, 24))}</i></span>
      <span class="xl-ok ${e.ok === false ? 'bad' : e.firstPass ? 'fp' : ''}">${e.ok === false ? '✕ 失败' : e.firstPass ? '✓ 一次过' : '✓ 完成'}</span>
      <span class="xl-num">${dur || '—'}</span>
      <span class="xl-num">${e.tokens ? fmtTokens(e.tokens) : '—'}</span>
      <span class="xl-cost">${cost}</span>
    </div>`;
  }).join('');
  return `<div class="panel exec-list"><h3 style="font-size:14px;margin-bottom:8px">最近执行<i class="zen">RECENT RUNS</i> <span style="font-weight:400;font-size:11px;color:var(--ink-faint)">逐次流水 · 共 ${log.length} 条（封顶 500）</span></h3>
    ${dashCostChart()}
    <div class="xl-head"><span>时间</span><span>任务</span><span>Agent · 模型</span><span>结果</span><span>耗时</span><span>tokens</span><span>花费</span></div>
    ${rows}</div>`;
}

/* ============ 抽屉：任务详情 ============ */
function openTask(id) {
  const t = byId(id);
  drawerTaskId = id; document.body.classList.add('drawer-open'); renderDrawer(id);
}
function closeDrawer() { drawerTaskId = null; document.body.classList.remove('drawer-open'); }
function drawerOpenOn(id) { return drawerTaskId === id && document.body.classList.contains('drawer-open'); }

/* 运行终端盒：单任务执行与并行流水线阶段共用（阶段实例的 DOM id 带阶段后缀，事件分流定位） */
function runBoxHTML(runKey, title, sub) {
  const r = runs[runKey]; if (!r) return '';
  const pct = runPct(runKey);
  const suf = r.stageId ? '-' + r.stageId : '';
  return `<div class="run-box">
    <div class="run-head"><span class="agent-name">${esc(title)}</span><span>${esc(sub || '')}</span><span class="pct" id="run-pct${suf}">${pct}%</span></div>
    <div class="run-bar"><i id="run-bar${suf}" style="width:${pct}%"></i></div>
    <div class="term-scroll" id="drawer-log${suf}">${r.log.map(([c, x]) => `<div class="ln ${c}">${esc(x)}</div>`).join('')}<div class="ln stream" id="drawer-stream${suf}">${esc(r.stream || '')}</div></div>
  </div>`;
}

/* 抽屉里的流水线面板：并行波次甘特 + 阶段清单（含产出预览）+ 裁决记录 + 启动/续跑按钮 */
function renderPipelinePanel(t) {
  const p = t.pipeline;
  if (!p || !p.on) return '';
  const modeTag = p.mode === 'auto' ? ' · 项目经理 AI 拆分' : p.mode === 'std' ? ' · 标准研发流水线' : '';
  let body = '';
  if (p.status === 'planning' && !p.stages) body = `<div class="pp-plan">${ic('compass')} 项目经理正在拆解流程，指定各阶段负责成员 …</div>`;
  if (p.stages?.length) {
    body = p.stages.map((s, i) => {
      const role = pipeRoleByKey(s.roleKey);
      const cur = (i === p.cur && ['running', 'planning', 'paused'].includes(p.status)) || ['running', 'rework'].includes(s.state);
      const icon = s.state === 'done' ? ic('check') : s.state === 'rework' ? ic('undo-2') : s.state === 'failed' ? ic('x') : cur ? ic('play') : ic('circle');
      return `<div class="pp-stage ${s.state === 'done' ? 'done' : s.state === 'failed' ? 'failed' : cur ? 'cur' : 'todo'}">
        <span class="pp-ic">${icon}</span>
        <div class="pp-main"><b>${esc(s.name)}</b><span>${esc(role ? role.name : s.roleKey)}${s.state === 'failed' ? ' · 失败（可从断点重试）' : ''}${s.rework ? ' · 返工' : ''}${s.runs > 1 ? ' · 第 ' + s.runs + ' 次执行' : ''}${s.final ? ' · 终段' : ''}</span></div>
      </div>${s.result ? `<details class="pp-res"><summary>阶段产出</summary><div class="result-box" style="margin:0">${mdToHtml(textOf(s.result, 6000))}${textRefNote(s.result)}</div></details>` : ''}`;
    }).join('');
  }
  /* 并行波次甘特（简化版）：同波次阶段左右并列、波次间上下衔接，状态着色与阶段清单一致 */
  const parWaves = p.waves && p.waves.some(w => w.length > 1) ? p.waves : null;
  const gantt = parWaves ? `<div class="pp-gantt">${parWaves.map((w, wi) => `
    <div class="pp-wave"><span class="pw-idx">W${wi + 1}</span><div class="pw-stages">${w.map(i => {
      const s = p.stages[i]; if (!s) return '';
      const icn = s.state === 'done' ? ic('check') : s.state === 'failed' ? ic('x') : ['running', 'rework'].includes(s.state) ? ic('play') : ic('circle');
      const depNames = (s.dependsOn || []).map(id => (p.stages.find(x => x.id === id) || {}).name || id).join('、');
      return `<span class="pw-stage ${s.state}" title="${esc(depNames ? '依赖：' + depNames : '无依赖（并行根）')}">${icn} ${esc(s.name)}</span>`;
    }).join('')}</div></div>`).join('')}<div class="pw-hint">同波次阶段并行执行 · 波次间按依赖衔接</div></div>` : '';
  /* 并行阶段的独立运行终端（每阶段一个日志盒；串行流水线沿用抽屉主执行盒） */
  const boxes = p.stages ? p.stages.filter(s => runs[t.id + '#' + s.id]).map(s => runBoxHTML(t.id + '#' + s.id, s.name + (s.rework ? ' · 返工' : ''), (pipeRoleByKey(s.roleKey) || {}).name || s.roleKey)) : [];
  const cancelBtn = boxes.length ? `<div class="run-actions"><button class="btn btn-o btn-sm" onclick="cancelRun('${t.id}')">${ic('square')} 终止执行</button></div>` : '';
  const gateHTML = p.gate ? `<div class="pp-gate ${p.gate.action === 'pass' ? 'pass' : 'rework'}">${ic('scale')} 第 ${p.gate.round} 轮裁决 · ${p.gate.action === 'pass' ? '通过' : '打回 ' + (p.gate.targets || []).join('/')}（${esc(p.gate.engine || '')}）— ${esc(p.gate.reason || '')}${p.gate.evidence ? `<div class="pp-evid">依据：${esc(String(p.gate.evidence).slice(0, 200))}</div>` : ''}</div>` : '';
  const btn = p.status === 'idle' || p.status === 'paused'
    ? `<button class="btn btn-p btn-sm" onclick="startPipeline('${t.id}')">${ic('play')} ${p.status === 'paused' ? '从断点继续' : '启动流水线'}</button>` : '';
  return `<div class="d-sec"><h4>流水线 · ${PIPE_STATE[p.status] || p.status}${modeTag}${p.round > 1 ? ` · 已返工 ${p.round - 1} 轮（上限 ${p.maxRework}）` : ''}</h4>
    <div class="pp-body">${body || '<div class="pp-plan">尚未启动：启动后项目经理将拆解流程并分配成员。</div>'}${gateHTML}</div>
    ${gantt}${boxes.join('')}${cancelBtn}
    ${btn ? `<div style="display:flex;gap:9px;align-items:center;margin-top:9px">${btn}<span style="font-size:11px;color:var(--ink-faint)">拆流程 → 阶段接力（无依赖并行）→ 测试裁决 → 返工循环 → 汇总交付</span></div>` : ''}
  </div>`;
}

function renderDrawer(id) {
  const t = byId(id); if (!t) { closeDrawer(); return; }
  const r = runs[id];
  const pct = runPct(id);
  const assigneeOpts = [{ v: '', l: '未指派' },
    ...memberNames().map(m => ({ v: 'm:' + m, l: m })),
    ...(O().roles || []).filter(roleUsable).map(r => ({ v: 'r:' + r.id, l: '☆ ' + r.name })),
    ...O().agents.map(a => ({ v: 'a:' + a.id, l: a.name + (a.status === 'working' && a.taskId !== id ? '（忙）' : ''), dis: !agentUsable(a) }))];
  const promptOpts = [{ v: '', l: '不附加' }, ...S().prompts.map(p => ({ v: p.id, l: p.title }))];

  let execHTML = '';
  if (r) {
    execHTML = `<div class="d-sec"><h4>${r.mode === 'api' ? '真实执行 · 流式输出' : 'Agent 执行 · 实时输出'} · ${pct ? pct + '%' : '运行中'}</h4>
      ${runBoxHTML(id, t.assignee?.name || 'Agent', r.mode === 'api' ? (r.model || '') : 'workspaces/' + t.key)}
      <div class="run-actions">
        <button class="btn btn-o btn-sm" onclick="cancelRun('${t.id}')">${ic('square')} 终止执行</button>
      </div></div>`;
  } else if (t.status === 'todo' && ['agent', 'role'].includes(t.assignee?.kind)) {
    const a = t.assignee.kind === 'role' ? (resolveRoleAgent(t) || {}).agent : agentById(t.assignee.id);
    const canModel = cliCanModel(a);
    execHTML = `<div class="d-sec"><h4>Agent 执行</h4>
      <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-p" onclick="startRun('${t.id}',{byUser:true});renderDrawer('${t.id}')">${ic('play')} 指派并启动</button>
        ${canModel ? `<label style="font-size:12.5px;color:var(--ink-dim);display:flex;align-items:center;gap:7px">执行模型
          ${ds('run-model', [{ v: '', l: a.cliModel ? a.cliModel + '（Agent 默认）' : '默认模型' }, ...modelOptsSync(a).map(m => ({ v: m, l: m }))], t.runModel || '', `byId('${t.id}').runModel=this.value;save()`, 'inline')}</label>` : ''}
      </div>
      <div style="font-size:12px;color:var(--ink-faint);margin-top:8px">${a?.mode === 'api'
        ? '将调用 ' + esc(providerLabel(a.provider) + ' · ' + a.model) + '，实时流式返回，完成后交付物进入待验收。'
        : a?.mode === 'cli'
          ? '在本机或云端节点执行，Agent 会直接创建或修改工作区中的文件，完成后附上改动文件清单。'
          : '演示引擎本地模拟执行，完成后进入待验收。'}</div></div>`;
  } else if (t.status === 'review') {
    execHTML = `<div class="d-sec"><h4>验收</h4>
      <div class="review-box">
        <span class="pr">${esc(t.pr || '交付 #—')}</span>
        ${t.result ? `<div class="result-box">${mdToHtml(textOf(t.result))}${textRefNote(t.result)}</div>`
        : `<p>执行已完成，请核对改动后验收</p>`}
        ${renderDiffPanel(t)}
        <div style="display:flex;gap:9px;margin-top:12px">
          <button class="btn btn-p btn-sm" onclick="mergeTask('${t.id}')">${ic('check')} 通过并归档</button>
          <button class="btn btn-o btn-sm" onclick="rejectTask('${t.id}')">${ic('x')} 打回重做</button>
          ${t.delivery?.items?.some(i => i.kind === 'log') ? `<button class="btn btn-o btn-sm" title="本次执行的完整过程日志（session.log）" onclick="viewSessionLog('${t.id}')">${ic('scroll-text')} 过程日志</button>` : ''}
        </div>
      </div>
      ${t.thread?.length ? `<div class="thread-note">该任务已执行 ${t.thread.filter(m => m.role === 'assistant').length} 轮${t.acpSessionId ? '，打回重跑将恢复原会话（上下文延续）' : '，打回时 Agent 会结合此前的交付与反馈继续修改'}。</div>` : ''}</div>`;
  } else if (t.status === 'done' && t.pr) {
    execHTML = `<div class="d-sec"><h4>结果</h4><div class="done-box">${ic('check')} 已归档 <span class="pr">${esc(t.pr)}</span> · 完成于 ${t.doneAt ? fmtRel(t.doneAt) : '—'}</div>
      ${t.result ? `<div class="result-box" style="margin-top:10px">${mdToHtml(textOf(t.result))}${textRefNote(t.result)}</div>` : ''}${renderDiffPanel(t, true)}</div>`;
  }

  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div style="flex:1">
        <div class="k">${t.key} <span class="pri ${t.pri}">${t.pri}</span> <span class="ttag ${t.type}">${TYPE_LABEL[t.type] || t.type}</span></div>
        <h3>${esc(t.title)}</h3>
      </div>
      <button class="drawer-x" onclick="closeDrawer()">${ic('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="d-sec">
        <div class="d-fields">
          <label>状态</label>
          ${ds('d-status', STATUS_FLOW.map(s => ({ v: s, l: STATUS_LABEL[s] })), t.status, `setStatus(byId('${t.id}'),this.value)`)}
          <label>优先级</label>
          ${ds('d-pri', ['P0', 'P1', 'P2'].map(p => ({ v: p, l: p })), t.pri, `byId('${t.id}').pri=this.value;save();refreshViews();renderDrawer('${t.id}')`)}
          <label>经办人</label>
          ${t.pipeline?.on
            ? `<div style="min-height:36px;display:flex;align-items:center;font-size:12.5px;color:var(--ink-dim)">${ic('compass')} 项目经理统筹 · 各阶段成员自动分配</div>`
            : ds('d-assignee', assigneeOpts, t.assignee?.kind === 'human' ? 'm:' + t.assignee.name : t.assignee?.kind === 'role' ? 'r:' + t.assignee.id : t.assignee?.kind === 'agent' ? 'a:' + t.assignee.id : '', `updateAssignee('${t.id}',this.value)`)}
          <label>附加提示词</label>
          ${ds('d-prompt', promptOpts, t.attachPrompt || '', `byId('${t.id}').attachPrompt=this.value||null;save();toast('已附加','执行时将随任务一并发送','✎')`)}
          <label>迭代</label>
          ${ds('d-iter', [{ v: '', l: '不归属' }, ...(S().iterations || []).map(i => ({ v: i.id, l: i.name }))], t.iterId || '', `byId('${t.id}').iterId=this.value||null;save();refreshViews()`)}
          <label>史诗</label>
          ${ds('d-epic', [{ v: '', l: '不归属' }, ...(S().epics || []).map(i => ({ v: i.id, l: i.name }))], t.epicId || '', `byId('${t.id}').epicId=this.value||null;save();refreshViews()`)}
          <label>仓库</label>
          ${ds('d-repo', repoOpts(t.repoRoot || ''), t.repoRoot || '', `byId('${t.id}').repoRoot=this.value;save();refreshViews();renderDrawer('${t.id}')`)}
        </div>
      </div>
      <div class="d-sec"><h4>描述 / 验收标准</h4><div class="d-desc">${esc(t.desc) || '（无描述）'}</div></div>
      ${renderPipelinePanel(t)}
      ${t.status === 'todo' ? `<div class="d-sec"><h4>AI 分诊</h4>
        <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-o btn-sm" id="tri-btn" onclick="triageDrawer('${t.id}')">分析类型、优先级与经办人</button>
          <span style="font-size:11px;color:var(--ink-faint)">由 Agent 基于标题与描述给出归类建议</span>
        </div>
        <div id="triage-out"></div>
      </div>` : ''}
      ${execHTML}
      ${t.worktree ? `<div class="d-sec"><h4>隔离工作区</h4>
        <div class="wt-chip"><span>${esc(t.worktree)}</span><button class="btn btn-o btn-sm" onclick="revealWt('${t.id}')">在访达中显示</button></div>
        ${(t.changes && t.changes.length) ? `<div class="chg-list">${t.changes.map(c => `<span class="chg-file"><i>${esc(c.flag || 'M')}</i>${esc(c.file)}</span>`).join('')}</div>` : ''}
        <div style="font-size:12px;color:var(--ink-faint);margin-top:7px">改动位于分支 reins/${t.key}，验收通过后合并回主分支。</div></div>` : ''}
      ${gitRemoteBlock(t)}
      ${(t.history && t.history.length) ? `<div class="d-sec"><h4>动态 · ${t.history.length}</h4>
        <ul class="tl">${t.history.slice().reverse().map(h => `<li><span class="fic">${gic(h.icon)}</span><div><div>${esc(h.text)}</div><div class="ft">${fmtRel(h.at)}</div></div></li>`).join('')}</ul>
      </div>` : ''}
      <div class="d-sec"><h4>评论 · ${t.comments.length}</h4>
        ${t.comments.map(c => `<div class="comment"><div class="av">${esc(c.who[0])}</div><div class="bubble"><div class="who"><b>${esc(c.who)}</b> · ${fmtRel(c.at)}</div>${esc(c.text)}</div></div>`).join('') || '<div style="font-size:12px;color:var(--ink-faint)">还没有评论</div>'}
        <div class="c-input"><input id="c-input" placeholder="输入评论，回车发送" onkeydown="if(event.key==='Enter')sendComment('${t.id}')"><button class="btn btn-o btn-sm" onclick="sendComment('${t.id}')">发送</button></div>
      </div>
      <div class="d-sec d-del"><button class="btn btn-o btn-sm btn-danger-o" onclick="confirmDeleteTask('${t.id}')">删除任务</button><span>永久删除，含执行记录、评论与交付物</span></div>
    </div>`;
  document.querySelectorAll('.drawer .term-scroll').forEach(el => { el.scrollTop = el.scrollHeight; });
  if (t.status === 'todo' && ['agent', 'role'].includes(t.assignee?.kind)) {
    const ha = t.assignee.kind === 'role' ? (resolveRoleAgent(t) || {}).agent : agentById(t.assignee.id);
    if (cliCanModel(ha)) hydrateModelSelect('run-model', ha, t.runModel);
  }
}

function updateAssignee(id, val) {
  const t = byId(id);
  /* 流水线任务：各阶段成员由项目经理统筹分配，不允许手动改派（避免破坏阶段链） */
  if (t.pipeline?.on) { toast('流水线任务', '各阶段成员由项目经理统筹分配，无需手动指派', '🧭'); renderDrawer(id); return; }
  if (!val) { t.assignee = null; }
  else if (val.startsWith('m:')) { t.assignee = { kind: 'human', name: val.slice(2) }; }
  else if (val.startsWith('r:')) {
    const r = roleById(val.slice(2));
    if (r) {
      t.assignee = { kind: 'role', id: r.id, name: r.name };
      th(t, '👤', '指派给角色 ' + r.name + '（' + ((roleAgent(r) || {}).name || '未绑定 Agent') + '）');
      if (t.status === 'doing' && !runs[id]) startRun(id, { byUser: true });
    }
  }
  else {
    const a = agentById(val.slice(2));
    t.assignee = { kind: 'agent', id: a.id, name: a.name };
    th(t, '👤', '指派给 ' + a.name);
    if (t.status === 'doing' && !runs[id]) startRun(id, { byUser: true });
  }
  save(); refreshViews(); renderDrawer(id);
}
function sendComment(id) {
  const inp = $('#c-input'); const v = inp.value.trim(); if (!v) return;
  byId(id).comments.push({ who: '我', text: v, at: now() });
  save(); renderDrawer(id);
}
function mergeTask(id) {
  const t = byId(id);
  /* 判定走共享迁移规则（taskflow.js）：状态守卫 + 未裁决代码变更确认墙，
     与飞书群 /reins approve 同一份判定源 */
  const r = TaskFlow.approve(t);
  if (!r.ok) {
    if (r.code === 'undecided-diff') { toast('请先裁决代码变更', '在下方"代码变更"面板确认应用或放弃后再归档', '⚠'); openTask(id); }
    else toast('无法归档', esc(r.message), '⚠');
    return;
  }
  th(t, '✅', '验收通过并归档');
  setStatus(t, 'done');
  toast('已归档', t.key + ' ' + esc(t.pr || ''), '✓');
  addActivity('✅', t.key + ' 验收通过，已归档');
  notifyHook('task.done', t);
}
function rejectTask(id) {
  const t = byId(id);
  openModal(`<div class="modal-head"><h3>打回重做</h3><span>${esc(t.key)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-row"><label>打回原因 / 修改要求（Agent 将结合交付物与反馈继续修改）</label>
      <textarea id="rj-text" placeholder="例如：第二部分缺少来源；语气再正式一点…"></textarea></div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="doReject('${t.id}')">打回</button></div>`);
}
function doReject(id) {
  const t = byId(id);
  /* 变更计划走共享迁移规则（taskflow.js），与飞书群 /reins reject 同一份判定源 */
  const r = TaskFlow.reject(t, $('#rj-text').value.trim());
  if (!r.ok) { toast('无法打回', esc(r.message), '⚠'); return; }
  TaskFlow.applyReject(t, r);   // 应用层同源（thread/状态/打回计数/流水线重置）
  if (r.resetPipeline) th(t, '🧭', r.pipelineTimeline);
  t.comments.push({ who: 'Reins', text: r.commentText, at: now() });
  th(t, '↩️', '验收打回：' + r.feedback.slice(0, 40));
  addActivity('↩️', t.key + ' 验收打回，等待重做');
  toast('已打回', t.key + ' 回到待处理，可重新指派执行', '↩');
  notifyHook('task.rejected', t);
  notifyFeishu('task.rejected', t, { reason: r.feedback.slice(0, 300) });
  save(); closeModal(); refreshViews(); renderDrawer(id);
}

/* ============================================================
   执行引擎
   ============================================================ */
function runPct(taskId) {
  const r = runs[taskId]; if (!r) return 0;
  if (r.mode === 'sim') return Math.round(r.idx / r.steps.length * 100);
  if (r.done) return 100;
  return Math.min(95, 5 + Math.floor((r.stream || '').length / 40)); // 流式期间的粗略进度
}

/* ---- 真实 API 引擎（主进程流式调用，事件回推） ---- */
function startApiRun(taskId, agent, opts) {
  const t = byId(taskId);
  /* 并行阶段各持独立 run 实例（键 taskId#阶段id）：事件按 stageNo 分流，日志互不覆盖 */
  const st = opts.stage || null;
  const runKey = st && st.id ? taskId + '#' + st.id : taskId;
  if (runs[runKey]) return;
  const r = runs[runKey] = { mode: 'api', log: [], stream: '', model: agent.model, usage: null, done: false, stageId: st ? st.id : null, stageNo: st ? st.no : undefined, startedAt: Date.now(), agentId: agent.id, agentName: agent.name, provider: agent.provider };
  r.log.push(['act', `▸ 装配任务上下文（${t.key} · ${TYPE_LABEL[t.type] || t.type}）`]);
  /* 流水线阶段上下文优先（编排器注入）；否则走任务卡附加的团队提示词 */
  const extra = opts.extraPrompt || (t.attachPrompt ? (S().prompts.find(p => p.id === t.attachPrompt)?.content || '') : '');
  if (extra) r.log.push(['ok', opts.extraPrompt
    ? `✓ 已注入流水线阶段上下文（${(st && st.name) || t.pipeline?.stages?.[t.pipeline.cur]?.name || '当前阶段'}，含前序产出）`
    : `✓ 已附加团队提示词「${S().prompts.find(p => p.id === t.attachPrompt)?.title}」`]);
  if (opts.roleName) r.log.push(['ok', `☆ 角色执行：${esc(opts.roleName)}（专属提示词与模型已注入）`]);
  if (t.thread?.length) r.log.push(['', `↻ 带此前 ${t.thread.filter(m => m.role === 'assistant').length} 轮交付继续修改`]);
  r.log.push(['ok', agent.mode === 'cli'
    ? agent.runtime === 'cloud'
      ? `☁ 已派发云端节点：${agent.cliCommand || '命令见配置'}（流式回传）`
      : `✓ 调用本机 CLI：${agent.cliCommand || '命令见配置'}（子进程流式）`
    : `✓ 调用 ${providerLabel(agent.provider)} · ${agent.model}（流式）`]);
  const effAgent = (agent.mode === 'cli' && t.runModel && cliCanModel(agent)) ? { ...agent, cliModel: t.runModel } : agent;
  if (agent.mode === 'cli') r.model = effAgent.cliModel || '默认模型';
  const execLabel = agent.mode === 'cli'
    ? (agent.cliCommand || 'CLI') + (effAgent.cliModel ? ' · ' + effAgent.cliModel : ' · 默认模型')
    : providerLabel(agent.provider) + ' · ' + agent.model;
  th(t, '▶', '开始执行 · ' + execLabel);
  /* stage：并行阶段唯一键（取消 / 交付子目录编号 / 事件 stageNo 打标）。
     任务级模型参数（创建时「高级选项」）挂在 t.modelParams 随任务对象透传，
     由主进程按「任务级覆盖 > Agent > 全局默认」解析 */
  window.reins.runStart({ task: t, agent: effAgent, extraPrompt: extra, repoRoot: agent.mode === 'cli' ? (t.repoRoot || S().repoRoot || '') : '', runtime: agent.mode === 'cli' && agent.runtime === 'cloud' ? 'cloud' : 'local', stage: st ? { key: st.id, no: st.no } : undefined });
  updateRunUI(runKey);
}

function handleRunEvent(evt) {
  const { taskId } = evt;
  /* 并行阶段事件带 stageNo（主进程打标）：按编号路由到对应阶段的 run 实例（键 taskId#阶段id），
     单任务 / 未打标事件仍按 taskId 直查 */
  let runKey = taskId;
  if (Number.isFinite(evt.stageNo)) {
    runKey = Object.keys(runs).find(k => runs[k].stageNo === evt.stageNo && (k === taskId || k.startsWith(taskId + '#'))) || '';
  }
  const r = runs[runKey]; if (!r) return;
  const t = byId(taskId);
  if (evt.type === 'delta') {
    r.stream += evt.text;
    const suf = r.stageId ? '-' + r.stageId : '';
    const box = $('#drawer-stream' + suf);
    if (box && drawerOpenOn(taskId)) { box.textContent = r.stream; const dl = $('#drawer-log' + suf); if (dl) dl.scrollTop = dl.scrollHeight; }
    document.querySelectorAll(`[data-task="${taskId}"] .bar i`).forEach(el => el.style.width = runPct(runKey) + '%');
    return;
  }
  if (evt.type === 'usage') { r.usage = evt.usage; return; }
  // 主进程上报的执行模型（start 即报，CLI 事件流的 init 帧随后用真实模型修正——默认模型也能显示）
  if (evt.type === 'model') {
    r.model = evt.model;
    if (evt.final && t) th(t, '◆', '执行模型 ' + evt.model); // init 帧确认的真实模型入时间线，事后可查
    updateRunUI(runKey); return;
  }
  /* 瞬态错误自动重试（429/5xx/超时）：流式输出区如实显示重试节奏；重试耗尽才走 error 事件 */
  if (evt.type === 'retry') { r.log.push(['retry', evt.text || `↻ 重试中（第 ${evt.retryNo}/${evt.retries} 次）…`]); updateRunUI(runKey); return; }
  if (evt.type === 'note') { r.log.push(['', evt.text]); updateRunUI(runKey); return; }
  if (evt.type === 'done') {
    /* 流水线阶段完成 → 交编排器推进（裁决/返工/下一波次），不走单任务验收路径；
       并行阶段按 stageNo 定位完成的是哪一个 */
    const t0 = byId(taskId);
    if (t0 && t0.pipeline && t0.pipeline.on && t0.pipeline.status === 'running') {
      const st = Number.isFinite(evt.stageNo) ? t0.pipeline.stages.find(s => s.no === evt.stageNo) : t0.pipeline.stages[t0.pipeline.cur];
      /* 流水线阶段执行也是真实调用：与单任务同源记账（此前只累 tokens，Agent 成功率/成本/流水表都漏掉流水线）；
         归属按 run 实例携带的 agentId（并行阶段 t.assignee 会被最后派发者覆盖，不能用它） */
      const sa = agentById(r.agentId) || effAgentOf(t0);
      if (sa) accountRun(sa, { ok: true, usage: evt.usage, model: r.model || sa.model, provider: sa.provider, ms: r.startedAt ? Date.now() - r.startedAt : 0,
        taskId: t0.id, taskKey: t0.key, taskTitle: t0.title, stage: st ? st.name : null,
        delivery: !!(st && st.final), firstPass: !(t0.rejections > 0) });
      return pipelineStageDone(taskId, evt, st);
    }
    // stream 里已经有完整执行过程（工具调用日志），只在为空时才用交付文本补位，别把过程日志冲掉
    r.done = true; if (!r.stream) r.stream = evt.result || '';
    const t2 = byId(taskId); const a = effAgentOf(t2);
    t2.result = evt.result;
    t2.thread = t2.thread || [];
    t2.thread.push({ role: 'assistant', content: evt.result });
    t2.status = 'review'; t2.pr = '交付 #' + (S().deliverSeq++);
    if (evt.worktree) { t2.worktree = evt.worktree; th(t2, '🌿', '改动落在隔离工作区 reins/' + t2.key); }
    // ACP 会话锚点（第八轮）：存到任务上，打回重跑走 session/load 续会话，不重喂全量历史
    if (evt.acpSessionId) {
      t2.acpSessionId = evt.acpSessionId;
      t2.acpAgentId = (effAgentOf(t2) || {}).id || null;   // role 指派也要存实际执行 Agent，断点续跑才能匹配上
      th(t2, '🔗', '会话锚点已保存' + (evt.resumed ? '（本次为恢复续跑）' : '，断点/打回重跑将在原会话继续'));
    }
    if (evt.delivery) {
      t2.delivery = evt.delivery;
      t2.delivery.diffState = evt.delivery.diff ? 'pending' : null;
      if (evt.delivery.diff) th(t2, '📝', `拟议变更 ${evt.delivery.diff.files.length} 个文件，待验收确认后应用`);
      if (evt.delivery.dir) t2.delivery.dir = evt.delivery.dir;
    }
    if (Array.isArray(evt.changes) && evt.changes.length) {
      t2.changes = evt.changes;
      th(t2, '📝', `实际改动 ${evt.changes.length} 个文件：` + evt.changes.slice(0, 5).map(c => c.file).join('、') + (evt.changes.length > 5 ? ' 等' : ''));
    }
    if (a) { a.status = 'idle'; a.done++; a.taskId = null; }
    const used = evt.usage?.total_tokens || 0;
    /* 质量与成本记账：耗时进样本、tokens 与金额按模型单价累加（未定价的只计 tokens 并留痕） */
    if (a) {
      accountRun(a, { ok: true, usage: evt.usage, model: r.model || a.model, provider: a.provider, ms: r.startedAt ? Date.now() - r.startedAt : 0,
        taskId: t2.id, taskKey: t2.key, taskTitle: t2.title, delivery: true, firstPass: !(t2.rejections > 0) });
    }
    r.log.push(['ok', `✓ 执行完成${used ? ' · tokens ' + used : ''}`]);
    r.log.push(['ok', `✓ ${t2.pr} 已生成 → 卡片移入「待验收」`]);
    th(t2, '🚀', `${t2.pr} 交付${used ? ' · ' + used + ' tokens' : ''}`);
    addActivity('🔀', `${t2.key} 完成，${t2.pr} 等待验收（${t2.assignee?.name || 'Agent'}${used ? ' · ' + used + ' tokens' : ''}）`);
    toast('任务完成', `${t2.key} 交付已生成，等待验收`, '✓');
    delete runs[taskId];
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
    return;
  }
  if (evt.type === 'error') {
    /* ACP 超时但引擎已有完整产出（partial）：流水线按完成推进——成果在 worktree，
       下一阶段（测试）会实际检验；比反复超时卡死强。时间线留痕可查 */
    const t0 = byId(taskId);
    const stg = Number.isFinite(evt.stageNo) && t0?.pipeline?.stages ? t0.pipeline.stages.find(s => s.no === evt.stageNo) : null;
    if (t0 && t0.pipeline?.on && t0.pipeline.status === 'running' && evt.partial && evt.partial.length > 400 && !pipeOutputSuspect(evt.partial)) {
      th(t0, '⚠', '阶段执行超时，但引擎已产出完整交付（按完成推进，测试阶段将实际检验）');
      r.log.push(['', '⚠ 超时收尾：产出完整，按完成推进']);
      /* 超时收尾按完成记账（同 done 通路，终段视为交付） */
      const pa = agentById(r.agentId) || effAgentOf(t0);
      if (pa) accountRun(pa, { ok: true, usage: evt.usage, model: r.model || pa.model, provider: pa.provider, ms: r.startedAt ? Date.now() - r.startedAt : 0,
        taskId: t0.id, taskKey: t0.key, taskTitle: t0.title, stage: stg ? stg.name : null,
        delivery: !!(stg && stg.final), firstPass: !(t0.rejections > 0) });
      return pipelineStageDone(taskId, { result: evt.partial, worktree: evt.worktree || null, changes: evt.changes, usage: evt.usage }, stg || t0.pipeline.stages[t0.pipeline.cur]);
    }
    r.log.push(['err', '✕ 调用失败：' + evt.message]);
    if (t) {
      if (t.pipeline?.on && t.pipeline.status === 'running') {
        const st = stg || t.pipeline.stages[t.pipeline.cur];
        /* 失败独立状态（REINS-128）：与「从未启动」可区分（甘特图红标），断点续跑时回待运行原地重试 */
        if (st && ['running', 'rework'].includes(st.state)) st.state = 'failed';
        /* 失败也留会话锚点（ACP 超时/出错）：断点续跑优先恢复原会话，省去重读代码的冷启动 */
        if (evt.acpSessionId) { t.acpSessionId = evt.acpSessionId; t.acpAgentId = (effAgentOf(t) || {}).id || null; }
        /* 并行语义（REINS-128）：失败阶段不阻塞同波次其他在途阶段，只阻塞自己的下游依赖；
           还有在途阶段时保持流水线运行，等它们收尾时 pipeStep 再统一判定是否暂停 */
        if (st && t.pipeline.stages.some(s => s !== st && ['running', 'rework'].includes(s.state))) {
          th(t, '⚠', st.name + ' 执行失败，其下游依赖阶段被阻塞；其他并行阶段继续');
          delete runs[runKey];
          toast('阶段执行失败', String(evt.message).slice(0, 60), '⚠');
          save(); refreshViews();
          if (drawerTaskId === taskId) renderDrawer(taskId);
          return;
        }
        t.pipeline.status = 'paused';
        th(t, '⏸', '流水线暂停 · ' + (st ? st.name : '') + ' 执行失败，可从断点继续');
      }
      if (!(t.pipeline?.on && t.pipeline.status === 'running')) t.status = 'todo';
      const a = effAgentOf(t);
      if (a && !(t.pipeline?.on && t.pipeline.stages?.some(s => ['running', 'rework'].includes(s.state)))) { a.status = 'idle'; a.taskId = null; }
      // 失败也留过程日志（session.log 已落盘）：交付面板能打开排查，失败任务的线索不丢
      if (evt.delivery && !t.delivery) {
        t.delivery = evt.delivery;
        t.delivery.diffState = evt.delivery.diff ? 'pending' : null;
      }
    }
    toast('执行失败', String(evt.message).slice(0, 60), '⚠');
    /* 失败记账：喂成功率与 avg 耗时（失败往往比成功更快，混在一起算会低估正常耗时，故同记）；
       流水表同步落一条失败行，归属按 run 实例的 agentId */
    if (t) {
      const fa = agentById(r.agentId) || effAgentOf(t);
      accountFail(fa, { usage: evt.usage, model: r.model, provider: (fa || {}).provider, ms: r.startedAt ? Date.now() - r.startedAt : 0,
        taskId: t.id, taskKey: t.key, taskTitle: t.title, stage: stg ? stg.name : null });
    }
    /* 飞书告警：超时与普通失败分开推送（超时通常是任务过大/模型过慢，处理方式不同） */
    if (t) notifyFeishu(/超时|timeout/i.test(String(evt.message || '')) ? 'task.timeout' : 'task.failed', t, { reason: String(evt.message || '').slice(0, 300) });
    delete runs[runKey];
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
    return;
  }
  if (evt.type === 'cancelled') {
    r.log.push(['err', '■ 已终止']);
    if (t) {
      if (t.pipeline?.on && t.pipeline.status === 'running') {
        const st = Number.isFinite(evt.stageNo) ? t.pipeline.stages.find(s => s.no === evt.stageNo) : t.pipeline.stages[t.pipeline.cur];
        if (st && ['running', 'rework'].includes(st.state)) st.state = 'pending';
        if (st && t.pipeline.stages.some(s => s !== st && ['running', 'rework'].includes(s.state))) th(t, '■', st.name + ' 已终止；其他并行阶段继续');
        else { t.pipeline.status = 'paused'; th(t, '⏸', '流水线已终止 · 可从断点继续'); }
      }
      if (!(t.pipeline?.on && t.pipeline.status === 'running')) t.status = 'todo';
      const a = effAgentOf(t);
      if (a && !(t.pipeline?.on && t.pipeline.stages?.some(s => ['running', 'rework'].includes(s.state)))) { a.status = 'idle'; a.taskId = null; }
    }
    delete runs[runKey];
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
  }
}

function cancelRun(taskId) {
  const r = runs[taskId];
  const stageKeys = Object.keys(runs).filter(k => k.startsWith(taskId + '#'));
  if (!r && !stageKeys.length) return;
  /* 真实引擎（含并行阶段实例）：主进程按 taskId 前缀一次全停（用户取消立即终止且不重试）；
     演示引擎的阶段实例是渲染层定时器（主进程不持有），本地清停并按取消语义收尾 */
  if ((r && r.mode === 'api') || stageKeys.some(k => runs[k].mode === 'api')) window.reins?.runCancel(taskId);
  const simKeys = [taskId, ...stageKeys].filter(k => runs[k] && runs[k].mode === 'sim');
  if (!simKeys.length) return;
  const t = byId(taskId);
  simKeys.forEach(k => { clearTimeout(runs[k].timer); delete runs[k]; });
  if (t?.pipeline?.on && t.pipeline.status === 'running') {
    t.pipeline.stages.forEach(s => { if (['running', 'rework'].includes(s.state)) s.state = 'pending'; });
    t.pipeline.status = 'paused';
    th(t, '⏸', '流水线已终止 · 可从断点继续');
  }
  if (t) t.status = 'todo';
  save(); refreshViews(); if (drawerTaskId === taskId) renderDrawer(taskId);
}
function confirmDeleteTask(id) {
  const t = byId(id); if (!t) return;
  openModal(`<div class="modal-head"><h3>删除任务</h3><span>${t.key}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将永久删除 <b>${t.key} ${esc(t.title)}</b>${t.pr ? ' 及其交付物 ' + esc(t.pr) : ''}，含执行记录与评论${runs[id] ? '；正在执行的 Agent 会被立即终止' : ''}。此操作不可撤销。</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="deleteTask('${t.id}')">确认删除</button></div>`);
}
function deleteTask(id) {
  const t = byId(id); if (!t) { closeModal(); return; }
  if (runs[id]) cancelRun(id);
  for (const a of O().agents) if (a.taskId === id) { a.taskId = null; if (a.status === 'working') a.status = 'idle'; }
  S().tasks = S().tasks.filter(x => x.id !== id);
  addActivity('🗑', '删除了 ' + t.key + ' ' + t.title);
  save(); closeModal(); closeDrawer(); refreshViews();
  toast('已删除', t.key + ' ' + esc(t.title), '✕');
  /* 磁盘清理：deliveries/<KEY>/ 与 deliveries/text/<KEY>/ 不在 state 里，
     不主动删就是永久残留（实测删过任务后仍留着整个交付目录） */
  window.reins?.deliveryPurge?.(t.key).then(r => {
    if (r && r.ok === false) toast('交付文件清理失败', r.error || '', '⚠');
  }).catch(() => { });
}

/* ---- 演示引擎（本地模拟，零配置） ---- */
function buildSteps(task, inst?) {
  inst = inst || 50000 + rnd(0, 9999);
  const f = pick(FILES), f2 = pick(FILES.filter(x => x !== f)), f3 = pick(FILES.filter(x => x !== f && x !== f2));
  const dv = S().deliverSeq;
  const rt = `✓ 独立工作区就绪 · workspaces/${task.key} · instance-${inst}（本地模拟）`;
  switch (task.type) {
    case 'bug': return [
      ['act', `▸ 接收任务 ${task.key}，装载上下文与验收标准`],
      ['ok', rt],
      ['', `阅读 ${f}（${rnd(80, 420)} 行）…`],
      ['', `检索最近 ${rnd(6, 30)} 次相关提交与配套测试`],
      ['act', `定位问题：${f2} 第 ${rnd(18, 300)} 行，边界条件未处理`],
      ['', `修改 ${f2}  +${rnd(6, 26)} -${rnd(2, 12)}`],
      ['', `补充回归用例 ${f3}`],
      ['', `运行验证 …`],
      ['ok', `✓ 全部通过（${rnd(18, 60)} 项）`],
      ['ok', `✓ 生成 ${'交付 #' + dv}，卡片移入「待验收」`],
    ];
    case 'support': return [
      ['act', `▸ 接收支持任务 ${task.key}`],
      ['ok', rt],
      ['', `阅读工单与客户历史（${rnd(3, 12)} 条）…`],
      ['', `检索知识库匹配条目 ${rnd(2, 8)} 篇 …`],
      ['act', `起草回复（附操作步骤 ${rnd(3, 6)} 步）`],
      ['', `检查语气规范（团队提示词：工单回复语气规范）`],
      ['ok', `✓ 回复草稿已生成，提交人工验收`],
    ];
    case 'research': case 'writing': case 'data': return [
      ['act', `▸ 接收任务 ${task.key}，理解目标与验收标准`],
      ['ok', rt],
      ['', `检索资料（命中 ${rnd(4, 12)} 个来源）…`],
      ['', `精读 ${f} 与 ${f2} …`],
      ['act', `整理要点，形成结构化草稿`],
      ['', `逐条核对来源与数据一致性 …`],
      ['ok', `✓ 交付物完成，附执行说明 ${rnd(2, 5)} 条`],
      ['ok', `✓ 生成 ${'交付 #' + dv}，卡片移入「待验收」`],
    ];
    default: return [
      ['act', `▸ 接收任务 ${task.key}，理解目标与验收标准`],
      ['ok', rt],
      ['', `检索相关模块 …（命中 ${rnd(3, 9)} 个文件）`],
      ['', `阅读 ${f}（${rnd(100, 500)} 行）…`],
      ['act', `设计方案：${rnd(2, 4)} 处改动，最小侵入`],
      ['', `修改 ${f}  +${rnd(30, 160)} -${rnd(4, 30)}`],
      ['', `修改 ${f2}  +${rnd(8, 60)} -${rnd(2, 20)}`],
      ['', `运行验证 …`],
      ['ok', `✓ 全部通过（${rnd(20, 72)} 项），无告警`],
      ['ok', `✓ 生成 ${'交付 #' + dv}，卡片移入「待验收」`],
    ];
  }
}

function startRun(taskId, opts: any = {}) {
  const t = byId(taskId);
  /* 流水线任务：统一入口转给编排器（启动/断点续跑），运行中由 runs 守卫防重 */
  if (t?.pipeline?.on && !['running', 'planning', 'done'].includes(t.pipeline.status)) return startPipeline(taskId);
  /* 流水线执行中只接受编排器派发的阶段调用（opts.pipeline），看板拖拽等单任务通路不再叠加启动 */
  if (t?.pipeline?.on && ['running', 'planning'].includes(t.pipeline.status) && !opts.pipeline) return;
  if (!t.assignee || !['agent', 'role'].includes(t.assignee.kind)) { toast('无法启动', '请先将任务指派给一个 Agent 或角色', '⚠'); return; }
  /* 角色指派：解析为绑定的 Agent，注入角色提示词与角色级模型（任务级 runModel 在 startApiRun 再覆盖） */
  const rr = t.assignee.kind === 'role' ? resolveRoleAgent(t) : null;
  if (t.assignee.kind === 'role' && !rr) { toast('角色不可用', '绑定的 Agent 不存在或已离线，请在 Agent 页重新配置角色', '⚠'); return; }
  const real = rr ? agentById(rr.role.agentId) : agentById(t.assignee.id);   // 状态记录用（真实 Agent）
  const a = rr ? rr.agent : real;                                            // 执行用（含角色提示词/模型）
  if (!real) { toast('Agent 不存在', '', '⚠'); return; }
  if (real.status === 'offline' || (real.mode === 'api' && !keyOf(real))) {
    toast(real.mode === 'api' ? '缺少密钥' : 'Agent 离线', real.mode === 'api' ? '请在设置中配置 API Key' : '请先上线 ' + esc(real.name), '⚠');
    if (real.mode === 'api') openAgentConfig(real.id);
    return;
  }
  if (a.mode === 'cli' && a.runtime === 'cloud' && !hookCfg.cloudUrl) {
    toast('未配置云端节点', '先在「设置 → 云端节点」填写服务器地址与令牌', '☁');
    switchView('settings');
    return;
  }
  /* 单任务防重入；流水线阶段的并发实例有独立键（taskId#阶段id），在 startApiRun 内判重 */
  if (runs[taskId] && !opts.stage) return;
  t.status = 'doing'; real.status = 'working'; real.taskId = taskId;
  const runLabel = (rr ? '☆ ' + rr.role.name + ' · ' : '') + real.name;
  th(t, '🚀', runLabel + ' 开始执行');
  addActivity('🚀', runLabel + ' 开始执行 ' + t.key + ' ' + t.title);
  if (opts.byUser) toast('已指派并启动', runLabel + ' 开始执行 ' + t.key, '▶');
  save();

  if ((a.mode === 'api' || a.mode === 'cli') && window.reins) {
    startApiRun(taskId, a, { ...opts, roleName: rr ? rr.role.name : '' });
  } else {
    /* 演示引擎：流水线阶段与真实引擎同构——独立阶段实例（键 taskId#阶段id），可并行接力 */
    const st = opts.stage || null;
    const runKey = st && st.id ? taskId + '#' + st.id : taskId;
    if (runs[runKey]) return;
    runs[runKey] = { mode: 'sim', steps: buildSteps(t), idx: 0, log: [], done: false, stageId: st ? st.id : null, stageNo: st ? st.no : undefined, startedAt: Date.now() };
    stepRun(runKey);
  }
  refreshViews();
  if (opts.openDrawer) openTask(taskId);
  else if (drawerTaskId === taskId) renderDrawer(taskId);
}
function stepRun(runKey) {
  const r = runs[runKey]; if (!r) return;
  if (r.idx >= r.steps.length) { finishRun(runKey); return; }
  const [cls, text] = r.steps[r.idx];
  r.log.push([cls, text]);
  const t = byId(String(runKey).split('#')[0]), a = t?.assignee ? agentById(t.assignee.id) : null;
  if (a) a.tokens += rnd(6, 24) * 1000;
  r.idx++;
  updateRunUI(runKey);
  r.timer = setTimeout(() => stepRun(runKey), rnd(500, 1050));
}
function finishRun(runKey) {
  const r = runs[runKey]; const taskId = String(runKey).split('#')[0]; const t = byId(taskId);
  if (!r || !t) return;
  /* 演示引擎跑流水线：同样交编排器推进；并行阶段按实例 stageNo 定位完成的是哪一个（与真实引擎事件分流同构） */
  if (t.pipeline?.on && t.pipeline.status === 'running') {
    const st = Number.isFinite(r.stageNo) ? t.pipeline.stages.find(s => s.no === r.stageNo) : t.pipeline.stages[t.pipeline.cur];
    delete runs[runKey];
    return pipelineStageDone(taskId, { result: '（演示引擎模拟产出，接入 API 或本机 CLI Agent 后为真实交付）', usage: null }, st);
  }
  const a = effAgentOf(t);
  t.status = 'review'; t.pr = '交付 #' + (S().deliverSeq++);
  t.result = t.result || [
    `【演示引擎 · 模拟交付】${t.key} ${t.title}`,
    '',
    `- 执行轮次：${r.log.length} 步 · 用时 ${(rnd(40, 180) / 10).toFixed(1)} 分钟（模拟）`,
    `- 产出：演示引擎生成的示意内容，接入 API 或 CLI Agent 后显示完整产出`,
    `- 建议：验收通过后归档，或打回并附上修改要求`,
  ].join('\n');
  if (a) { a.status = 'idle'; a.done++; a.taskId = null; a.tokens += rnd(30, 80) * 1000; }
  /* 演示引擎也落流水表（tokens/花费为 0，但让降级模式看得到「最近执行」形态） */
  if (a) accountRun(a, { ok: true, model: '演示引擎', provider: 'sim', ms: r.startedAt ? Date.now() - r.startedAt : 0,
    taskId: t.id, taskKey: t.key, taskTitle: t.title, delivery: true, firstPass: !(t.rejections > 0) });
  delete runs[taskId];
  addActivity('🔀', t.key + ' 完成，' + t.pr + ' 等待验收（' + (t.assignee?.name || 'Agent') + '）');
  toast('任务完成', t.key + ' 已产出 ' + t.pr + '，等待验收', '✓');
  save(); refreshViews();
  if (drawerTaskId === taskId) renderDrawer(taskId);
}
function updateRunUI(runKey) {
  const r = runs[runKey]; if (!r) return;
  const taskId = String(runKey).split('#')[0];
  const pct = runPct(runKey);
  const suf = r.stageId ? '-' + r.stageId : '';
  if (drawerOpenOn(taskId)) {
    const dl = $('#drawer-log' + suf);
    if (dl) {
      const [cls, text] = r.log[r.log.length - 1] || ['', ''];
      const div = document.createElement('div'); div.className = 'ln ' + cls; div.textContent = text;
      const stream = $('#drawer-stream' + suf);
      stream ? dl.insertBefore(div, stream) : dl.appendChild(div);
      dl.scrollTop = dl.scrollHeight;
      const pb = $('#run-bar' + suf); if (pb) pb.style.width = pct + '%';
      const pp = $('#run-pct' + suf); if (pp) pp.textContent = pct + '%';
    }
  }
  document.querySelectorAll(`[data-task="${taskId}"] .bar i`).forEach(el => el.style.width = pct + '%');
}

/* ============================================================
   流水线（虚拟团队）：项目经理统筹，阶段接力自动执行
   t.pipeline = {
     on, status: 'idle'|'planning'|'running'|'paused'|'done',
     mode: 'auto'|'std',                       // 项目经理 AI 拆分 / 标准研发流水线
     stages: [{roleKey, name, goal, state: 'pending'|'running'|'rework'|'done'|'failed', result, runs, rework?, final?}],
     cur, round, maxRework, stageNo,           // stageNo → 主进程交付子目录编号
     gate, reworkCtx                           // 最近一次裁决 / 打回上下文
   }
   执行拓扑：串行接力（共享同一隔离 worktree，后一阶段拿前面所有产出当输入）；
   QA 后由项目经理裁决：通过 → 交付总结；打回 → 定位目标阶段带意见返工 → 重新测试（上限 maxRework 轮）
   ============================================================ */
const PIPE_STATE = { idle: '待启动', planning: '规划中', running: '流转中', paused: '已暂停', done: '已完成' };
const PIPE_STD = [
  { roleKey: 'pm', name: '产品文档' },
  { roleKey: 'be', name: '后端实现' },
  { roleKey: 'fe', name: '前端实现' },
  { roleKey: 'qa', name: '测试验证' },
];
const pipeRoleByKey = key => {
  const tpl = ROLE_TEMPLATES.find(t => t.key === key);
  if (!tpl) return null;
  return (O().roles || []).find(r => r.tpl === key || r.name === tpl.name);
};
/* 流水线所需角色就位：缺失的按模板补建，未绑定 Agent 的自动绑到可用 Agent（用户可事后在角色页改绑） */
function ensurePipelineRoles(keys) {
  const agents = O().agents.filter(agentUsable);
  if (!agents.length) return { ok: false, message: '没有可用 Agent：请先在 Agent 页接入 API 或本机 CLI' };
  const bind = agents.find(a => a.mode === 'api') || agents[0];   // 规划/裁决需要 API 引擎，优先绑 API
  const created = [];
  for (const key of keys) {
    let r = pipeRoleByKey(key);
    const tpl = ROLE_TEMPLATES.find(t => t.key === key);
    if (!r && tpl) {
      r = { id: 'r' + now(), tpl: key, name: tpl.name, glyph: tpl.glyph, agentId: '', cliModel: '', prompt: tpl.prompt };
      O().roles = O().roles || []; O().roles.push(r);
      created.push(tpl.name);
    }
    if (r && !r.agentId) r.agentId = bind.id;
  }
  if (created.length) toast('已补建流水线角色', created.join('、') + ' → 绑定 ' + bind.name, '☆');
  return { ok: true };
}
/* 规划/裁决引擎：项目经理角色绑定的 API Agent 优先，退而求任何可用 API Agent；没有则走启发式兜底 */
function pipelineJudgeAgent() {
  const mgr = pipeRoleByKey('pmgr');
  const a0 = mgr && agentById(mgr.agentId);
  if (a0 && a0.mode === 'api' && keyOf(a0) && a0.status !== 'offline') return a0;
  return O().agents.find(a => a.mode === 'api' && a0 !== a && keyOf(a) && a.status !== 'offline') || null;
}
/* 任务的有效执行 Agent（role 指派时是角色绑定的 Agent）——顺带修复 role 任务收尾后 Agent 状态不复位 */
function effAgentOf(t) {
  if (!t || !t.assignee) return null;
  if (t.assignee.kind === 'role') { const r = roleById(t.assignee.id); return r ? agentById(r.agentId) : null; }
  if (t.assignee.kind === 'agent') return agentById(t.assignee.id);
  return null;
}
function pipelineResetAgent(t, usedTokens) {
  const a = effAgentOf(t);
  /* tokens 与成本/成功率经 accountRun 记账（done 路由处，按 run 实例 agentId 归属），
     这里只负责收尾状态：completed 计数 + 释放占用 */
  if (a) { a.status = 'idle'; a.done = (a.done || 0) + 1; a.taskId = null; }
}

/* 组装当前阶段上下文：任务卡由引擎注入，这里补阶段目标 + 上游产出 + 打回意见 */
/* 文档类阶段：产出直接写正文（系统落盘为报告传给下游），不依赖仓库写权限 */
const PIPE_DOC_STAGES = ['pm', 'ui', 'doc', 'qa', 'pmgr'];
function pipelineStageContext(t, st) {
  const p = t.pipeline;
  const parts = [];
  parts.push(`【流水线阶段】${st.name}（${p.stages.indexOf(st) + 1}/${p.stages.length}${st.rework ? ' · 返工' : ''}）`);
  if (st.goal) parts.push(`【本阶段目标】${st.goal}`);
  /* 上游产出（REINS-128 上下文合并）：并行模式下只注入直接依赖阶段的产出，按完成时间升序拼接；
     串行链（向后兼容）保持既有"全部前序产出"语义不变 */
  const prevSrc = (st.dependsOn && st.dependsOn.length && !p.serialChain)
    ? st.dependsOn.map(id => p.stages.find(x => x.id === id)).filter(s => s && s.result).sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))
    : p.stages.slice(0, p.stages.indexOf(st)).filter(s => s.result);
  if (prevSrc.length) parts.push('【前序阶段产出（已完成，是你的输入；勿重复劳动）】\n' + prevSrc.map(s => `—— ${s.name} ——\n${textOf(s.result, 4000)}`).join('\n\n'));
  if (p.reworkCtx) parts.push(`【测试打回 · 项目经理裁决】\n修改要求：${p.reworkCtx.feedback}\n\n测试报告：\n${String(p.reworkCtx.qaReport).slice(0, 3000)}`);
  if (st.final) parts.push('你是项目经理，做最终交付总结：按阶段汇总全流程（产品文档要点、开发改动、测试结论），给出验收建议与遗留风险。');
  else parts.push('【流水线约定】你是虚拟团队中本阶段的负责人，只产出本阶段交付物；你的产出会自动交给下一阶段。');
  /* 交付契约：无头 CLI 常无写权限（实测 qoder 停在"请批准写入"）——明确告诉它怎么交付，杜绝求助型空产出 */
  if (st.flagged) parts.push('【重要】上一轮你停在权限请求上、没有产出交付物。本轮不要请求任何权限、不要等待批准：把完整交付物直接写在回复正文里。');
  if (st.roleKey === 'qa') parts.push('【报告契约】报告必须分两个清单：① 失败项——实际执行未通过的用例/断言（编号+现象），没有则明确写「失败项：无」；② 风险提示——不阻塞交付的潜在风险与建议。项目经理只依据①决定是否返工；②会进入交付遗留清单。');
  if (PIPE_DOC_STAGES.includes(st.roleKey)) parts.push('【交付契约】下游阶段只能读到你的回复正文，看不到仓库文件——完整文档必须直接写在回复正文（结构化 Markdown），系统会自动落盘并传给下一阶段。可以顺带把文件写入工作区，但写不了也不要紧，更不要为此请求权限。');
  else parts.push('【交付契约】直接修改/创建工作区文件，改动清单（文件路径+说明）写在回复正文；若文件写入被拒，把完整改动以完整文件内容或 unified diff 的形式写进回复正文。绝不停下来等待权限批准。');
  return parts.join('\n\n');
}

async function startPipeline(taskId) {
  const t = byId(taskId); const p = t.pipeline;
  if (!p || p.status === 'planning' || p.status === 'running') return;
  /* 断点续跑：已有阶段计划，直接按依赖图调度可运行阶段（失败阶段原地重试） */
  if (p.status === 'paused' && p.stages?.length) {
    /* 旧档兼容：无阶段 id/依赖的存量流水线，补链式依赖保持串行接力 */
    if (!p.stages.every(s => s.id)) {
      p.serialChain = true;
      p.stages.forEach((s, i) => { s.id = s.id || 's' + (i + 1); s.dependsOn = i ? [p.stages[i - 1].id] : []; });
    }
    p.stageNo = p.stageNo || 0;   // 旧档无编号字段也要补齐：否则阶段 no 为 NaN，主进程事件不打标、按 taskId 回查不到分流的 run 实例
    p.stages.forEach(s => { if (s.state === 'failed') s.state = 'pending'; });   // 失败阶段断点续跑即原地重试
    p.status = 'running'; t.status = 'doing';
    th(t, '▶', '流水线从断点继续');
    save(); refreshViews();
    pipeStep(taskId);
    return;
  }
  /* 全新启动：角色就位 → 项目经理拆流程（AI 不可用退标准模板） */
  const ensure = ensurePipelineRoles(['pmgr', ...new Set(PIPE_STD.map(s => s.roleKey))]);
  if (!ensure.ok) { toast('无法启动流水线', ensure.message, '⚠'); return; }
  p.status = 'planning'; p.round = 1; p.cur = 0; p.stageNo = 0; p.gate = null; p.reworkCtx = null; p.mode = '';
  t.status = 'doing'; save(); refreshViews();
  th(t, '🧭', '流水线启动 · 项目经理拆解流程');
  let plan = null;
  const judge = pipelineJudgeAgent();
  if (judge && window.reins) {
    const r = await window.reins.pipelinePlan({ task: t, agent: judge }).catch(() => null);
    if (r && r.ok) {
      plan = r.stages; p.mode = 'auto';
      th(t, '🧭', '项目经理拆解：' + plan.map(s => s.name).join(' → ') + (r.reason ? '（' + r.reason + '）' : ''));
    } else if (r && r.message) th(t, '⚠', 'AI 拆分不可用（' + r.message + '），改用标准研发流水线');
  } else th(t, '⚠', '无 API 引擎可做规划，改用标准研发流水线');
  if (!plan) { plan = PIPE_STD.map(s => ({ ...s })); p.mode = 'std'; }
  /* 依赖编排（REINS-128）：主进程 normalizeDeps + planWaves 归一——阶段 id 稳定、dependsOn 清洗，
     波次供甘特图与并行执行共用同一语义；浏览器演示模式无 IPC，本地补 id 即可（串行链由下方回退统一处理） */
  let waves = null, hasCycle = false;
  if (window.reins) {
    const r = await window.reins.pipelineDeps({ stages: plan }).catch(() => null);
    if (r && r.ok) { plan = r.stages; waves = r.waves; hasCycle = r.hasCycle; }
    else plan = plan.map((s, i) => ({ ...s, id: s.id || 's' + (i + 1) }));
  } else plan = plan.map((s, i) => ({ ...s, id: s.id || 's' + (i + 1) }));
  /* 向后兼容：没有任何阶段显式声明 dependsOn → 本地改写为链式依赖（第 n 个依赖第 n-1 个），
     执行与上下文注入均与既有串行接力完全一致 */
  p.serialChain = !plan.some(s => s.depsExplicit);
  if (p.serialChain) plan.forEach((s, i) => { s.dependsOn = i ? [plan[i - 1].id] : []; });
  p.stages = plan.map(s => ({ goal: '', ...s, state: 'pending', result: '', runs: 0 }));
  p.waves = waves; p.hasCycle = hasCycle;
  if (hasCycle) th(t, '⚠', '阶段依赖存在环，环上阶段将按原顺序执行（建议检查项目经理拆分）');
  p.status = 'running';
  addActivity('🧭', t.key + ' 流水线启动 · ' + p.stages.map(s => s.name).join(' → '));
  save(); refreshViews();
  pipeStep(taskId);
}

/* —— 依赖就绪判定与波次调度（REINS-128 并行阶段） —— */
const pipeDepsDone = (p, s) => (s.dependsOn || []).every(id => {
  const d = p.stages.find(x => x.id === id);
  return !d || d.state === 'done';
});
/* 打回重跑集合：目标角色阶段 + 传递依赖它们的所有下游——并行流水线中无关兄弟分支的产出保留；
   串行链（链式依赖）下即"目标及其后全部"，与既有整段清空行为一致 */
const pipeReworkIds = (stages, targets) => { const ids = new Set(stages.filter(s => targets.includes(s.roleKey)).map(s => s.id)); let grew = true; while (grew) { grew = false; for (const s of stages) if (!ids.has(s.id) && (s.dependsOn || []).some(id => ids.has(id))) { ids.add(s.id); grew = true; } } return ids; };
/* 调度一个"节拍"：派发所有依赖已就绪的待运行阶段（真实引擎与演示引擎均并行执行——
   演示引擎的阶段实例独立成键 taskId#阶段id，与甘特图并行展示一致）；
   无在途且无可派发时按完成度收尾——全完成进交付，剩余全被失败依赖阻塞则暂停待人工 */
function pipeStep(taskId) {
  const t = byId(taskId); const p = t && t.pipeline;
  if (!p || !p.on || p.status !== 'running') return;
  const active = p.stages.filter(s => ['running', 'rework'].includes(s.state));
  const runnable = p.stages.map((s, i) => ({ s, i })).filter(x => x.s.state === 'pending' && pipeDepsDone(p, x.s));
  if (!runnable.length) {
    if (active.length) return;
    if (p.stages.every(s => s.state === 'done')) return pipelineDeliver(taskId);
    p.status = 'paused'; t.status = 'todo';
    th(t, '⏸', '存在被失败阶段阻塞的下游阶段，流水线暂停：可从断点继续重试');
    toast('流水线暂停', '部分阶段失败致下游阻塞；处理后可从断点继续', '⚠');
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
    return;
  }
  for (const x of runnable) runPipelineStage(taskId, x.i);
}

function runPipelineStage(taskId, si) {
  const t = byId(taskId); const p = t.pipeline;
  if (!p || p.status !== 'running') return;
  /* 不指定下标：调度第一个依赖就绪的待运行阶段（演示引擎串行路径 / 兜底） */
  const idx = Number.isFinite(si) ? si : p.stages.findIndex(s => s.state === 'pending' && pipeDepsDone(p, s));
  if (idx < 0 || !p.stages[idx]) return;
  const st = p.stages[idx];
  p.cur = idx;   // 兼容展示与旧路径（并行时仅指示最近派发的阶段）
  const role = pipeRoleByKey(st.roleKey);
  if (!role || !roleUsable(role)) {
    p.status = 'paused'; t.status = 'todo';
    th(t, '⏸', '阶段「' + st.name + '」的负责角色不可用，流水线暂停');
    toast('流水线暂停', '请在角色页为「' + (role ? role.name : st.roleKey) + '」绑定可用 Agent 后从断点继续', '⚠');
    save(); refreshViews();
    return;
  }
  if (!Number.isFinite(p.stageNo)) p.stageNo = 0;   // 兜底：中途保存等边缘档无编号字段时补齐，避免 no=NaN 打不通事件分流
  st.no = ++p.stageNo;   // 并行阶段交付子目录编号 + 事件 stageNo 打标（并发下各自持有，不共用字段）
  st.state = st.rework ? 'rework' : 'running';
  const isNewAttempt = st.runs === 0 || st.rework;   // 断点续跑（runs>0 非返工）保留会话锚点续会话；新阶段/返工清掉开新会话
  st.runs++;
  p.final = !!st.final;
  t.assignee = { kind: 'role', id: role.id, name: role.name };
  if (isNewAttempt) delete t.acpSessionId;
  th(t, st.rework ? '↩' : '▶', (st.rework ? '返工 · ' : '') + st.name + '（' + role.name + '）开始执行');
  save(); refreshViews();
  startRun(taskId, { pipeline: true, extraPrompt: pipelineStageContext(t, st), stage: st });
}

async function pipelineStageDone(taskId, evt, st) {
  const t = byId(taskId); const p = t.pipeline;
  if (!st) st = p.stages[p.cur];   // 兼容无 stageNo 的旧事件（演示引擎等）：回退当前阶段
  delete runs[taskId + '#' + (st && st.id)];
  delete runs[taskId];
  const result = String(evt.result || '（无输出）');
  pipelineResetAgent(t, evt.usage?.total_tokens || 0);
  /* 产出质量门：求助型产出（无头 CLI 卡在"请批准写入"）不算完成——
     自动带修正契约重跑一次；两轮都废则暂停待人工，绝不把求助文本喂给下游阶段 */
  if (st && !st.flagged && pipeOutputSuspect(result)) {
    st.flagged = true; st.result = ''; st.state = 'pending';
    th(t, '⚠', st.name + ' 产出疑似权限求助（非交付物），自动带修正契约重跑');
    addActivity('⚠', t.key + ' ' + st.name + ' 阶段产出异常，自动重跑');
    save(); refreshViews();
    return runPipelineStage(taskId, p.stages.indexOf(st));
  }
  if (st && st.flagged && pipeOutputSuspect(result)) {
    p.status = 'paused'; t.status = 'todo'; st.state = 'failed';
    th(t, '⏸', st.name + ' 两轮产出均为求助文本，流水线暂停：建议在角色页为该阶段换绑 Agent，或处理后从断点继续');
    toast('流水线暂停', st.name + ' 阶段无法产出有效交付（引擎疑似权限受限），建议换绑 Agent', '⚠');
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
    return;
  }
  if (st) { st.state = 'done'; st.result = result; st.completedAt = now(); }
  th(t, '✓', (st ? st.name : '阶段') + ' 完成');
  if (evt.worktree && !t.worktree) t.worktree = evt.worktree;
  if (st && st.final) return finishPipeline(taskId, evt);
  if (st && st.roleKey === 'qa') return pipelineGate(taskId, st);
  save(); refreshViews();
  pipeStep(taskId);
}

/* 求助型产出识别：无头 CLI 无写权限时的典型卡壳（"请批准写入"类短文本），不算交付 */
const PIPE_BEG_RE = /(需要写入|需要.{0,8}权限|请批准|请授权|无法写入|无法创建|写入.{0,6}被拒|permission denied|cannot write|read-?only|等待批准|等待确认)/i;
function pipeOutputSuspect(text) {
  const s = String(text || '').trim();
  return !!s && s.length < 600 && PIPE_BEG_RE.test(s);
}

/* QA 后的项目经理裁决：通过 → 交付总结；打回 → 目标阶段带意见返工 → 重测（上限轮数后挂起待人工） */
async function pipelineGate(taskId, qa) {
  const t = byId(taskId); const p = t.pipeline;
  th(t, '⚖', '项目经理裁决测试结果 …');
  /* 裁决要给项目经理看完整测试报告：正文外置后 state 里只有摘要，
     这里先取回全文（取不到时退回摘要，裁决仍能进行） */
  const qaReport = await textFull(qa.result);
  let verdict = null;
  const judge = pipelineJudgeAgent();
  if (judge && window.reins) {
    const r = await window.reins.pipelineGate({ task: t, agent: judge, qaReport, round: p.round, maxRework: p.maxRework, prevFeedback: p.reworkCtx ? textOf(p.reworkCtx.feedback) : '' }).catch(() => null);
    if (r && r.ok) verdict = r.verdict;
  }
  if (!verdict) verdict = pipeGateHeuristic(qaReport);
  p.gate = { ...verdict, round: p.round, engine: judge ? judge.name : '自动判定' };
  if (verdict.action === 'pass') {
    th(t, '⚖', '裁决通过 · ' + verdict.reason);
    /* QA 通过≠全链完成：后继阶段（如技术文档）先走完，再进入交付（并行模式下由依赖图派发） */
    if (p.stages.some(s => s.state !== 'done')) { save(); refreshViews(); return pipeStep(taskId); }
    return pipelineDeliver(taskId);
  }
  if (p.round >= p.maxRework) {
    p.status = 'paused'; t.status = 'todo';
    th(t, '⏸', `返工已达上限（${p.maxRework} 轮），流水线暂停待人工裁决 · ` + verdict.reason);
    toast('返工超限', '已达 ' + p.maxRework + ' 轮上限，请查看测试报告后手动继续或验收打回', '⚠');
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
    return;
  }
  const first = p.stages.findIndex(s => verdict.targets.includes(s.roleKey));
  if (first < 0) { th(t, '⚖', '裁决未给出可打回阶段，按通过处理 · ' + verdict.reason); return pipelineDeliver(taskId); }
  p.round++;
  p.reworkCtx = { feedback: verdict.feedback || '按测试报告逐条修复', qaReport: String(qaReport).slice(0, 6000) };
  const tname = k => (ROLE_TEMPLATES.find(x => x.key === k) || {}).name || k;
  /* 精确清空（REINS-128）：只重跑目标 + 传递下游（其输入已变，产出必然过期）；
     兄弟分支已完成产出不再被误清。下游非目标阶段按普通重跑（不带返工标记）处理 */
  const reset = pipeReworkIds(p.stages, verdict.targets);
  p.stages.forEach(s => { if (!reset.has(s.id)) return; s.result = ''; s.state = 'pending'; s.rework = verdict.targets.includes(s.roleKey); });
  p.cur = p.stages.findIndex(s => reset.has(s.id));
  th(t, '↩', `测试未通过 · 项目经理打回 ${verdict.targets.map(tname).join('、')}：${verdict.reason}`);
  addActivity('↩', t.key + ' 测试打回（项目经理裁决）· ' + verdict.targets.map(tname).join('、'));
  save(); refreshViews();
  pipeStep(taskId);
}

/* 无 API 裁决引擎时的兜底：按测试报告关键词粗判，保证返工循环不断链 */
function pipeGateHeuristic(report) {
  const bad = /(未通过|不通过|测试失败|存在\s*\d+\s*(个)?(问题|缺陷|bug)|有\s*\d+\s*(个)?(问题|缺陷)|FAIL|❌|✕)/i.test(report);
  return bad
    ? { action: 'rework', targets: ['be', 'fe'], feedback: '测试发现问题（自动判定）：请逐条对照测试报告修复后重新提测。', reason: '无裁决引擎，按报告失败关键词自动打回' }
    : { action: 'pass', reason: '无裁决引擎，报告未含失败关键词，按通过处理' };
}

/* 终段：项目经理汇总全流程产出（final 标记 → 主进程交付落根目录，聚合全流程 diff） */
function pipelineDeliver(taskId) {
  const t = byId(taskId); const p = t.pipeline;
  const role = pipeRoleByKey('pmgr');
  if (!role || !roleUsable(role)) {
    /* 项目经理不可用：系统直接聚合各阶段产出进入验收 */
    p.status = 'done';
    /* 聚合各阶段产出：外置的阶段正文先用摘要（后端保存时会把这份聚合结果整体外置，
       全文随各阶段文件留在正文库里，可从阶段面板单独取回） */
    t.result = p.stages.filter(s => s.result).map(s => `—— ${s.name} ——\n${textOf(s.result)}`).join('\n\n');
    th(t, '📦', '流水线完成（项目经理不可用，已直接聚合各阶段产出）');
    return finishPipeline(taskId, { result: t.result });
  }
  /* 幂等：交付总结阶段已存在（如返工后二次交付）则复用，不重复追加。
     并行模式下显式依赖全部既有阶段——汇总必须等所有波次收尾（无依赖声明的追加会被当成并行根立即启动） */
  if (!p.stages.some(s => s.final)) {
    p.stages.push({ roleKey: 'pmgr', name: '交付总结', goal: '汇总全流程产出，形成最终交付报告', state: 'pending', result: '', runs: 0, final: true,
      id: 's' + (p.stages.length + 1), dependsOn: p.stages.map(s => s.id) });
  } else {
    const f = p.stages.find(s => s.final);
    f.state = 'pending'; f.result = '';
  }
  p.cur = p.stages.findIndex(s => s.final);
  th(t, '📦', '进入交付 · 项目经理汇总全流程产出');
  save(); refreshViews();
  pipeStep(taskId);
}

/* 流水线收尾：对齐单任务 done 路径（review / 交付面板 / 累计 diff） */
function finishPipeline(taskId, evt) {
  const t = byId(taskId); const p = t.pipeline;
  p.status = 'done';
  t.status = 'review';
  t.pr = '交付 #' + (S().deliverSeq++);
  t.result = evt.result || t.result || '（无输出）';
  if (evt.worktree) t.worktree = evt.worktree;
  if (evt.delivery) {
    t.delivery = evt.delivery;
    t.delivery.diffState = evt.delivery.diff ? 'pending' : null;
  } else if (evt.result && !t.delivery) {
    /* 项目经理直聚路径（无执行事件）：复用主进程落盘逻辑不可行，仅保留阶段产出聚合文本 */
  }
  if (Array.isArray(evt.changes) && evt.changes.length) t.changes = evt.changes;
  th(t, '🚀', t.pr + ' 流水线交付 · ' + p.stages.filter(s => s.state === 'done').length + ' 个阶段完成');
  addActivity('🔀', `${t.key} 流水线完成，${t.pr} 等待验收（项目经理统筹）`);
  toast('流水线完成', t.key + ' 全流程交付已生成，等待验收', '✓');
  save(); refreshViews();
  if (drawerTaskId === taskId) renderDrawer(taskId);
}

/* ============ 团队空间 ============ */
function renderSpaceButton() {
  const sp = S();
  if (!sp) return;
  $('#space-badge').textContent = sp.badge || sp.name[0];
  $('#space-name').textContent = sp.name;
  $('#space-sprint').textContent = sp.sprint || '';
  $('#space-pop').innerHTML = (O().spaces || []).map(x => `<div class="sp-item ${x.id === state.activeSpaceId ? 'on' : ''}" onclick="switchSpace('${x.id}')">
      <span class="sq">${x.badge || (x.name || '空')[0]}</span>
      <div style="flex:1;min-width:0"><b>${esc(x.name)}</b><span style="display:block;font-size:11px;color:var(--ink-faint)">${(x.members || []).length} 名成员 · ${(x.tasks || []).filter(t => t.status !== 'done').length} 个未完成任务</span></div>
    </div>`).join('')
    + `<div class="sp-item" style="color:#87919a" onclick="openSpaceSettings()"><span class="sq ghost">${ic('settings')}</span><div style="flex:1"><b>空间设置</b><span style="display:block;font-size:11px;color:var(--ink-faint)">成员 · 角色 · 邀请</span></div></div>`
    + `<button class="sp-act" onclick="openSpaceCreate()">${ic('plus')} 创建新空间</button>`;
}
function toggleSpaceMenu(e) { e && e.stopPropagation(); closeOrgMenu(); $('#space-pop').classList.toggle('show'); }

/* ============ 组织层（组织 → 空间 → 成员） ============ */
function toggleOrgMenu(e) { e && e.stopPropagation(); closeSpaceMenu(); renderOrgPop(); $('#org-pop').classList.toggle('show'); }
function closeOrgMenu() { $('#org-pop')?.classList.remove('show'); }
function renderOrgLine() {
  const o = O(); if (!o) return;
  $('#org-name').textContent = o.name;
}
function renderOrgPop() {
  $('#org-pop').innerHTML = (state.orgs || []).map(o => `<div class="sp-item ${o.id === state.activeOrgId ? 'on' : ''}" onclick="switchOrg('${o.id}')">
      <span class="sq">${esc(o.badge || o.name[0])}</span>
      <div style="flex:1;min-width:0"><b>${esc(o.name)}</b><span style="display:block;font-size:11px;color:var(--ink-faint)">${o.spaces.length} 个空间 · ${o.agents.length} 个 Agent</span></div>
    </div>`).join('')
    + `<div class="sp-item" style="color:#87919a" onclick="openOrgSettings()"><span class="sq ghost">${ic('settings')}</span><div style="flex:1"><b>组织设置</b><span style="display:block;font-size:11px;color:var(--ink-faint)">名称 · 删除组织</span></div></div>`
    + `<button class="sp-act" onclick="openOrgCreate()">${ic('plus')} 新建组织</button>`;
}
function switchOrg(id) {
  if (id === state.activeOrgId) { closeOrgMenu(); return; }
  if (!state.orgs.some(x => x.id === id)) { closeOrgMenu(); return; }
  state.activeOrgId = id;
  const o = O();
  if (!o.spaces.some(s => s.id === state.activeSpaceId)) state.activeSpaceId = o.spaces[0].id;
  closeDrawer(); closeModal(); closeOrgMenu(); closeSpaceMenu();
  filters = { type: '', who: '', search: '', iter: '', lane: '' }; $('#search').value = '';
  save(); renderOrgLine(); renderSpaceButton(); switchView('kanban');
  toast('已切换组织', esc(o.name) + ' · ' + esc(S().name), '⇆');
}
function openOrgSettings() {
  closeOrgMenu();
  const o = O();
  openModal(`<div class="modal-head"><h3>组织设置</h3><span>${esc(o.name)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <h3 class="set-h">基本信息</h3>
      <div class="f-2col">
        <div class="f-row"><label>组织名称</label><input type="text" id="og-name" value="${esc(o.name)}"></div>
        <div class="f-row"><label>标识（一个字）</label><input type="text" id="og-badge" maxlength="1" value="${esc(o.badge || '')}"></div>
      </div>
      <div style="font-size:12px;color:var(--ink-faint)">Agent 与空间均归属组织，相互隔离。当前 ${o.spaces.length} 个空间 · ${o.agents.length} 个 Agent。</div>
      <h3 class="set-h" style="margin-top:18px;color:#c05656">危险操作</h3>
      <button class="btn btn-danger" onclick="confirmDeleteOrg()">删除组织</button>
      <div style="font-size:12px;color:var(--ink-faint);margin-top:6px">删除后其下空间、任务与 Agent 配置一并移除，至少保留一个组织。</div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="saveOrgInfo()">保存</button></div>`);
}
function saveOrgInfo() {
  const o = O();
  o.name = $('#og-name').value.trim() || o.name;
  o.badge = $('#og-badge').value.trim() || o.name[0];
  save(); closeModal(); renderOrgLine(); renderSpaceButton();
  toast('已保存', '组织信息已更新', '⚙');
}
function openOrgCreate() {
  closeOrgMenu();
  openModal(`<div class="modal-head"><h3>新建组织</h3><span>空间与 Agent 相互隔离</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-2col">
        <div class="f-row"><label>组织名称</label><input type="text" id="no-name" placeholder="例如：个人项目 / 另一家公司"></div>
        <div class="f-row"><label>标识（一个字）</label><input type="text" id="no-badge" maxlength="1" placeholder="组"></div>
      </div>
      <div style="font-size:12px;color:var(--ink-faint)">新组织自带一个空白空间；Agent 与密钥按组织隔离，需在组织内各自配置。</div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="createOrg()">创建</button></div>`);
}
function createOrg() {
  const name = $('#no-name').value.trim();
  if (!name) { $('#no-name').focus(); return; }
  const id = 'og' + now();
  state.orgs.push({
    id, name, badge: $('#no-badge').value.trim() || name[0],
    agents: seedAgents(),
    spaces: [{ id: 'sp' + now(), name: '默认空间', badge: name[0], sprint: '', members: [{ name: '我', role: 'owner' }],
      tasks: [], prompts: seedPrompts(), autos: seedAutos(), chart: [0, 0, 0, 0, 0, 0, 0], integ: {},
      activity: [], iterations: [], epics: [], seq: 1, deliverSeq: 1, repoRoot: '', readAt: 0 }],
  });
  state.activeOrgId = id; state.activeSpaceId = state.orgs.at(-1).spaces[0].id;
  save(); closeModal(); renderOrgLine(); renderSpaceButton(); switchView('kanban');
  toast('组织已创建', '当前：' + esc(name) + ' · 默认空间', '');
}
function confirmDeleteOrg() {
  if (state.orgs.length <= 1) { toast('无法删除', '至少保留一个组织', '⚠'); return; }
  const o = O();
  openModal(`<div class="modal-head"><h3>删除组织</h3><span>${esc(o.name)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将删除 <b>${esc(o.name)}</b> 及其 ${o.spaces.length} 个空间、${o.agents.length} 个 Agent 配置（含密钥）。此操作不可撤销。</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="doDeleteOrg()">确认删除</button></div>`);
}
function doDeleteOrg() {
  if (state.orgs.length <= 1) { toast('无法删除', '至少保留一个组织', '⚠'); return; }
  const idx = state.orgs.findIndex(x => x.id === state.activeOrgId);
  if (idx < 0) return;
  state.orgs.splice(idx, 1);
  state.activeOrgId = state.orgs[Math.max(0, idx - 1)].id;
  state.activeSpaceId = O().spaces[0].id;
  save(); closeModal();
  closeDrawer(); filters = { type: '', who: '', search: '', iter: '', lane: '' }; $('#search').value = '';
  renderOrgLine(); renderSpaceButton(); switchView('kanban');
  toast('组织已删除', '已切换到 ' + esc(O().name), '✕');
}
function closeSpaceMenu() { $('#space-pop')?.classList.remove('show'); }
function switchSpace(id) {
  if (id === state.activeSpaceId) { closeSpaceMenu(); return; }
  state.activeSpaceId = id;
  closeDrawer(); closeModal(); closeSpaceMenu();
  filters = { type: '', who: '', search: '', iter: '', lane: '' }; $('#search').value = '';
  save(); renderSpaceButton(); switchView('kanban');
  toast('已切换空间', '当前：' + esc(S().name), '⇆');
}

function openSpaceCreate() {
  closeSpaceMenu();
  openModal(`<div class="modal-head"><h3>创建空间</h3><span>数据独立 · 成员独立</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-2col">
        <div class="f-row"><label>空间名称</label><input type="text" id="ns-name" placeholder="例如：设计协作组"></div>
        <div class="f-row"><label>标识（一个字）</label><input type="text" id="ns-badge" maxlength="1" placeholder="设"></div>
      </div>
      <div class="f-row"><label>迭代 / 排期标语</label><input type="text" id="ns-sprint" placeholder="例如：Sprint 1 · 11 月"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="createSpace()">创建</button></div>`);
  setTimeout(() => $('#ns-name')?.focus(), 60);
}
function createSpace() {
  const name = $('#ns-name').value.trim();
  if (!name) { $('#ns-name').focus(); return; }
  const id = 'sp' + now();
  O().spaces.push({
    id, name,
    badge: $('#ns-badge').value.trim() || name[0],
    sprint: $('#ns-sprint').value.trim() || '未设置迭代',
    members: [{ name: '我', role: 'owner' }],
    seq: 1, deliverSeq: 1,
    tasks: [], prompts: seedPrompts(), autos: seedAutos(),
    chart: [0, 0, 0, 0, 0, 0, 0],
    integ: { jira: { connected: false, host: '', lastSync: 0 } },
    activity: [{ at: now(), icon: '✳', text: '创建了空间「' + name + '」' }],
  });
  save(); closeModal();
  state.activeSpaceId = id;
  closeDrawer(); filters = { type: '', who: '', search: '', iter: '', lane: '' }; $('#search').value = '';
  renderSpaceButton(); switchView('kanban');
  toast('空间已创建', '已切换到「' + esc(name) + '」', '✳');
}

/* —— 任务级仓库选择：空间维护仓库清单，每个任务可指定执行仓库 —— */
const repoName = p => { const s = String(p || '').trim().replace(/\/+$/, ''); return s.split('/').filter(Boolean).pop() || s; };
function repoOpts(sel) {
  const repos = S().repos || [];
  const def = S().repoRoot || '';
  return [{ v: '', l: '跟随空间默认' + (def ? '（' + repoName(def) + '）' : '（未配置）') },
    ...repos.map(r => ({ v: r.path, l: (r.name || repoName(r.path)) + ' · ' + r.path }))];
}
function addRepo() {
  const path = $('#ss-r-path').value.trim();
  const name = $('#ss-r-name').value.trim() || repoName(path);
  if (!path.startsWith('/')) { toast('路径无效', '需要绝对路径（以 / 开头）', '⚠'); return; }
  S().repos = S().repos || [];
  if (S().repos.some(r => r.path === path)) { toast('已存在', '该仓库已在清单中', '⚠'); return; }
  S().repos.push({ name: name || '仓库', path });
  if (!S().repoRoot) S().repoRoot = path;
  save(); closeModal(); openSpaceSettings();
  toast('仓库已添加', (name || '') + ' · 建任务时可选', '');
}
function removeRepo(i) {
  const r = (S().repos || [])[i]; if (!r) return;
  S().repos.splice(i, 1);
  if (S().repoRoot === r.path) S().repoRoot = (S().repos[0] || {}).path || '';
  save(); closeModal(); openSpaceSettings();
}
function setDefaultRepo(i) { setDefaultRepoByPath(((S().repos || [])[i] || {}).path || ''); }
function setDefaultRepoByPath(path) {
  S().repoRoot = path || '';
  save(); closeModal(); openSpaceSettings();
  toast('默认仓库已更新', path ? repoName(path) + ' · ' + esc(path.slice(0, 46)) : '已设为不隔离执行', '');
}

function openSpaceSettings() {
  closeSpaceMenu();
  const sp = S();
  const rows = sp.members.map((m, i) => `<div class="mb-row">
      <span class="mb-av">${esc(m.name[0])}</span>
      <div style="flex:1"><b>${esc(m.name)}</b>${m.role === 'owner' ? ' <span class="mode-pill api">创建者</span>' : ''}</div>
      ${m.role === 'owner' ? '<span style="font-size:12px;color:var(--ink-faint)">所有者</span>' : ds('ss-role-' + i, ['owner', 'member', 'guest'].map(r => ({ v: r, l: ROLE_LABEL[r] })), m.role, `S().members[${i}].role=this.value;save();renderSpaceButton()`, 'inline')}
      ${m.role === 'owner' ? '' : `<button class="btn btn-o btn-sm" onclick="removeMember(${i})">移除</button>`}
    </div>`).join('');
  openModal(`<div class="modal-head"><h3>空间设置</h3><span>${esc(sp.name)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <h3 class="set-h">基本信息</h3>
      <div class="f-2col">
        <div class="f-row"><label>空间名称</label><input type="text" id="ss-name" value="${esc(sp.name)}"></div>
        <div class="f-row"><label>标识（一个字）</label><input type="text" id="ss-badge" maxlength="1" value="${esc(sp.badge || '')}"></div>
      </div>
      <div class="f-row"><label>迭代 / 排期标语</label><input type="text" id="ss-sprint" value="${esc(sp.sprint || '')}"></div>

      <h3 class="set-h">代码仓库清单 · ${(sp.repos || []).length}</h3>
      <div id="ss-repos">${(sp.repos || []).map((r, i) => `<div class="mb-row">
        <span class="mb-av" style="background:var(--accent-soft);color:var(--brand-text)">${esc((r.name || '?')[0] || '?')}</span>
        <b style="width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name || '仓库')}</b>
        <span class="mono" style="flex:1;font-size:12px;color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.path)}</span>
        ${sp.repoRoot === r.path ? '<span class="status-pill idle" style="font-size:11px">默认</span>' : ''}
        <button class="btn btn-o btn-sm" onclick="setDefaultRepo(${i})">设默认</button>
        <button class="btn btn-o btn-sm" onclick="removeRepo(${i})">移除</button>
      </div>`).join('') || '<div style="font-size:12px;color:var(--ink-faint);margin-bottom:8px">暂无仓库。添加常用仓库后，创建任务时可直接选择。</div>'}</div>
      <div class="mb-row" style="border-bottom:none">
        <input id="ss-r-name" placeholder="仓库名（如 官网）" style="width:120px;padding:6px 10px;border:1px solid var(--line-strong);border-radius:7px">
        <input id="ss-r-path" placeholder="/绝对路径/到 git 仓库" style="flex:1;padding:6px 10px;border:1px solid var(--line-strong);border-radius:7px;font-family:var(--mono);font-size:12px">
        <button class="btn btn-o btn-sm" onclick="addRepo()">添加</button>
      </div>
      <div class="f-row" style="margin-top:12px"><label>空间默认仓库（新建任务的预设）</label>
        ${ds('ss-defrepo', [{ v: '', l: '不隔离执行' }, ...(sp.repos || []).map(r => ({ v: r.path, l: r.name || repoName(r.path) }))], sp.repoRoot || '', 'setDefaultRepoByPath(this.value)')}</div>
      <div style="font-size:12px;color:var(--ink-faint);margin:-4px 0 4px">任务也可在创建时或抽屉里单独指定仓库；CLI Agent 会在所选仓库旁的 .reins-wt/&lt;任务号&gt; 创建独立工作区与 reins/&lt;任务号&gt; 分支。</div>

      <h3 class="set-h">成员 · ${sp.members.length}</h3>
      ${rows}
      <div class="mb-row" style="border-bottom:none">
        <span class="mb-av" style="background:var(--accent-soft);color:var(--brand-text)">＋</span>
        <input id="ss-mb-name" placeholder="同事姓名" style="flex:1;padding:6px 10px;border:1px solid var(--line-strong);border-radius:7px">
        ${ds('ss-mb-role', [{ v: 'member', l: '成员' }, { v: 'guest', l: '访客' }], 'member', '', 'inline')}
        <button class="btn btn-o btn-sm" onclick="addMember()">添加</button>
      </div>

      <h3 class="set-h">迭代 · ${(sp.iterations || []).length}</h3>
      ${(sp.iterations || []).map((i, idx) => `<div class="mb-row"><span class="mb-av" style="background:#e7f0fb;color:#3f6fa8">迭</span><b style="flex:1">${esc(i.name)}</b><span style="font-size:12px;color:var(--ink-faint)">${(sp.tasks||[]).filter(t => t.iterId === i.id).length} 个任务</span><button class="btn btn-o btn-sm" onclick="removeIter(${idx})">移除</button></div>`).join('')}
      <div class="mb-row" style="border-bottom:none">
        <input id="ss-iter-name" placeholder="新迭代名称" style="flex:1;padding:6px 10px;border:1px solid var(--line-strong);border-radius:7px">
        <button class="btn btn-o btn-sm" onclick="addIter()">添加</button>
      </div>

      <h3 class="set-h">史诗 · ${(sp.epics || []).length}</h3>
      ${(sp.epics || []).map((i, idx) => `<div class="mb-row"><span class="mb-av" style="background:#efe7f8;color:#7a5ab0">史</span><b style="flex:1">${esc(i.name)}</b><span style="font-size:12px;color:var(--ink-faint)">${(sp.tasks||[]).filter(t => t.epicId === i.id).length} 个任务</span><button class="btn btn-o btn-sm" onclick="removeEpic(${idx})">移除</button></div>`).join('')}
      <div class="mb-row" style="border-bottom:none">
        <input id="ss-epic-name" placeholder="新史诗 / 版本名称" style="flex:1;padding:6px 10px;border:1px solid var(--line-strong);border-radius:7px">
        <button class="btn btn-o btn-sm" onclick="addEpic()">添加</button>
      </div>

      <h3 class="set-h">邀请加入</h3>
      <div class="invite-row">
        <span class="invite-link" id="invite-link">点击生成邀请链接</span>
        <button class="btn btn-o btn-sm" onclick="genInvite()">生成</button>
        <button class="btn btn-p btn-sm" onclick="copyInvite()">复制</button>
      </div>
      <div class="set-desc" style="margin-top:6px">当前为本地演示，链接不会实际发送。</div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="confirmDeleteSpace()">删除空间</button>
      <span style="flex:1"></span>
      <button class="btn btn-p" onclick="saveSpaceInfo()">保存</button></div>`);
}
function saveSpaceInfo() {
  const sp = S();
  sp.name = $('#ss-name').value.trim() || sp.name;
  sp.badge = $('#ss-badge').value.trim() || sp.name[0];
  sp.sprint = $('#ss-sprint').value.trim();
  save(); closeModal(); renderSpaceButton(); refreshViews();
  toast('已保存', '空间信息已更新', '✓');
}
function addMember() {
  const name = $('#ss-mb-name').value.trim();
  if (!name) { $('#ss-mb-name').focus(); return; }
  if (S().members.some(m => m.name === name)) { toast('已存在', '该成员已在空间中', '⚠'); return; }
  S().members.push({ name, role: $('#ss-mb-role').value });
  save(); renderSpaceButton(); openSpaceSettings();
  toast('已添加', name + ' 已加入空间');
}
function removeMember(i) {
  const m = S().members[i];
  S().members.splice(i, 1);
  S().tasks.forEach(t => { if (t.assignee?.kind === 'human' && t.assignee.name === m.name) t.assignee = null; });
  save(); renderSpaceButton(); openSpaceSettings(); refreshViews();
  toast('已移除', m.name + ' 已移出空间');
}
function addIter() {
  const n = $('#ss-iter-name').value.trim(); if (!n) return;
  (S().iterations = S().iterations || []).push({ id: 'it' + now(), name: n });
  save(); openSpaceSettings();
}
function removeIter(i) {
  const it = S().iterations[i];
  S().tasks.forEach(t => { if (t.iterId === it.id) t.iterId = null; });
  S().iterations.splice(i, 1); save(); openSpaceSettings(); refreshViews();
}
function addEpic() {
  const n = $('#ss-epic-name').value.trim(); if (!n) return;
  (S().epics = S().epics || []).push({ id: 'ep' + now(), name: n });
  save(); openSpaceSettings();
}
function removeEpic(i) {
  const it = S().epics[i];
  S().tasks.forEach(t => { if (t.epicId === it.id) t.epicId = null; });
  S().epics.splice(i, 1); save(); openSpaceSettings(); refreshViews();
}
let inviteCode = '';
function genInvite() {
  inviteCode = 'reins.app/j/' + Math.random().toString(36).slice(2, 10);
  const el = document.getElementById('invite-link');
  if (el) el.textContent = inviteCode;
}
function copyInvite() {
  if (!inviteCode) genInvite();
  const done = () => toast('已复制', '邀请链接已复制到剪贴板', '');
  if (navigator.clipboard) navigator.clipboard.writeText('https://' + inviteCode).then(done, done); else done();
}
function confirmDeleteSpace() {
  if (O().spaces.length <= 1) { toast('无法删除', '组织内至少保留一个空间', '⚠'); return; }
  const sp = S();
  openModal(`<div class="modal-head"><h3>删除空间</h3><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将删除空间「${esc(sp.name)}」及其全部 ${sp.tasks.length} 个任务、成员与自动化配置。此操作不可撤销。</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="deleteSpace()">确认删除</button></div>`);
}
function deleteSpace() {
  const sp = O();
  const idx = sp.spaces.findIndex(x => x.id === state.activeSpaceId);
  sp.spaces.splice(idx, 1);
  state.activeSpaceId = sp.spaces[Math.max(0, idx - 1)].id;
  save(); closeModal();
  closeDrawer(); filters = { type: '', who: '', search: '', iter: '', lane: '' }; $('#search').value = '';
  renderSpaceButton(); switchView('kanban');
  toast('空间已删除', '已切换到 ' + esc(S().name), '✕');
}

/* ============ 节点视图（本机 / 云端执行节点） ============ */
let nodeLocalClis = null;
function viewNodes() {
  const s = hookCfg || {};
  return `<div class="view-head"><h2>节点</h2><p>本机与云端执行节点</p></div>
    <div class="grid2">
      <div class="panel node-card">
        <div class="agent-top">
          <div class="agent-av">${ic('server')}</div>
          <div><h3 style="font-size:15px">本机节点</h3><div class="agent-meta">${s.platform || 'mac'} · 客户端 v${s.version || '1.0.0'}</div></div>
          <span class="status-pill idle" style="margin-left:auto">在线</span>
        </div>
        <div class="node-row"><b>状态</b><span>常驻运行 · <span id="nv-uptime">${(document.getElementById('node-uptime') || {}).textContent || '刚刚启动'}</span></span></div>
        <div class="node-row"><b>本机运行时</b><div class="cli-chips" id="nv-clis">${nodeLocalClis === null ? '<span class="cli-chip off">检测中…</span>' : (nodeLocalClis.length ? nodeLocalClis.map(c => `<span class="cli-chip">${esc(c)}</span>`).join('') : '<span class="cli-chip off">未检测到 CLI 运行时</span>')}</div></div>
        <div class="node-row" style="display:block">
          <div style="display:flex;align-items:center;gap:10px"><b style="min-width:96px">执行期间防休眠</b>
            <label class="switch"><input type="checkbox" ${s.preventSleep ? 'checked' : ''} onchange="togglePreventSleep(this.checked)"><i></i></label>
            <span style="font-size:12px;color:var(--ink-faint)">开启后任务执行期间阻止系统休眠（接入电源时合盖也不中断）</span></div>
        </div>
        <div style="font-size:12px;color:var(--ink-faint)">关闭窗口时驻留菜单栏可在「设置 → 客户端」调整；驻留期间本机节点保持在线。</div>
      </div>
      <div class="panel node-card">
        <div class="agent-top">
          <div class="agent-av" style="background:#e8eef6">${ic('cloud')}</div>
          <div><h3 style="font-size:15px">云端节点</h3><div class="agent-meta">${s.cloudUrl ? esc(s.cloudUrl.replace(/^https?:\/\//, '')) : '未配置'}</div></div>
          <span class="status-pill ${s.cloudUrl ? 'idle' : 'offline'}" style="margin-left:auto" id="nv-cloud-pill">${s.cloudUrl ? '检测中' : '未配置'}</span>
        </div>
        <div id="nv-cloud-body" style="font-size:13px;color:var(--ink-dim)">
          ${s.cloudUrl ? '正在检测节点状态…' : `部署 reins-node/server.js 到你的服务器后，CLI 型 Agent 可选择在云端执行。<div style="margin-top:12px"><button class="btn btn-o btn-sm" onclick="switchView('settings')">去设置 → 云端节点</button></div>`}
        </div>
      </div>
    </div>`;
}
async function hydrateNodes() {
  if (curView !== 'nodes') return;
  // 本机 CLI 检测
  if (nodeLocalClis === null && window.reins) {
    try {
      const presets = await window.reins.cliList();
      const r = await window.reins.cliDetect(presets.map(p => p.cmd));
      nodeLocalClis = Object.keys(r).filter(k => r[k]);
      if (curView === 'nodes') render();
    } catch (e) { nodeLocalClis = []; }
  }
  // 云端健康
  const s = hookCfg || {};
  if (s.cloudUrl && window.reins) {
    const r = await window.reins.cloudTest();
    const pill = document.getElementById('nv-cloud-pill');
    const body = document.getElementById('nv-cloud-body');
    if (pill) pill.textContent = r.ok ? '在线' : '离线';
    if (pill && !r.ok) pill.className = 'status-pill offline';
    if (body) body.innerHTML = r.ok
      ? `<div class="node-row"><b>节点名</b><span class="mono">${esc(r.name)}</span></div>
         <div class="node-row"><b>可用运行时</b><div class="cli-chips">${(r.agents || []).length ? r.agents.map(c => `<span class="cli-chip">${esc(c)}</span>`).join('') : '<span class="cli-chip off">未检测到</span>'}</div></div>
         <div class="node-row"><b>仓库根目录</b><span class="mono">${esc(r.repoRoot || '未配置（任务在独立目录执行）')}</span></div>
         <div style="font-size:12px;color:var(--ink-faint)">CLI 型 Agent 在配置里选「执行位置 → 云端节点」即派发到此服务器。</div>`
      : `<div style="color:#c05656">连接失败：${esc(r.error || '')}</div><div style="margin-top:10px"><button class="btn btn-o btn-sm" onclick="switchView('settings')">检查配置</button></div>`;
  }
}
async function togglePreventSleep(on) {
  if (!window.reins) { toast('浏览器模式', '该设置仅在桌面客户端内生效', '⚠'); render(); return; }
  /* 写盘失败（返工①）：开关回弹到磁盘真实状态，不本地先记 */
  if (!settingsApplied(await window.reins.setSettings({ preventSleep: on }))) { render(); return; }
  const ok = await window.reins.caffeinateSet(on);
  hookCfg = { ...hookCfg, preventSleep: on };
  toast(on ? '防休眠已开启' : '防休眠已关闭', on ? (ok ? '任务执行期间系统保持唤醒' : '系统不支持，未生效') : '恢复系统默认策略');
}

/* ============ 交付物中心 ============ */
function viewDeliveries() {
  const ts = S().tasks.filter(t => t.result || t.pr).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0) || (b.key > a.key ? 1 : -1));
  if (!ts.length) return `<div class="view-head"><h2>交付</h2><p>Agent 执行任务的产出物</p></div>
    <div class="panel" style="padding:40px;text-align:center;color:var(--ink-dim)">暂无交付物。<br>任务由 Agent 执行完成后，交付物会显示在这里。</div>`;
  const iterName = id => (S().iterations || []).find(i => i.id === id)?.name || '';
  const rows = ts.map(t => {
    const who = t.assignee ? (t.assignee.kind === 'agent' ? '◆ ' + t.assignee.name : t.assignee.name) : '—';
    return `<div class="dlv-row">
      <div class="dlv-main">
        <div class="k"><span>${t.key}</span>${t.status === 'review' ? '<span class="dlv-wait">待验收</span>' : ''}<span class="pr">${esc(t.pr || '草稿')}</span></div>
        <h3>${esc(t.title)}</h3>
        <div class="dlv-meta">${esc(who)}${iterName(t.iterId) ? ' · ' + esc(iterName(t.iterId)) : ''} · ${t.doneAt ? fmtRel(t.doneAt) : '执行中'}</div>
      </div>
      <div class="dlv-acts">
        <button class="btn btn-o btn-sm" onclick="previewDelivery('${t.id}')">预览</button>
        ${t.result ? `<button class="btn btn-o btn-sm" onclick="copyDelivery('${t.id}')">复制</button>
        <button class="btn btn-p btn-sm" onclick="downloadDelivery('${t.id}')">下载 .md</button>` : ''}
        ${t.delivery?.dir ? `<button class="btn btn-o btn-sm" title="在访达中打开交付目录（report.md / changes.patch）" onclick="revealDeliveryDir('${t.id}')">${ic('folder')} 产物</button>` : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="view-head"><h2>交付</h2><p>共 ${ts.length} 份交付物</p></div>${rows}`;
}
function previewDelivery(id) {
  const t = byId(id);
  openModal(`<div class="modal-head"><h3>${esc(t.title)}</h3><span>${esc(t.pr || t.key)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="result-box" style="max-height:44vh;overflow:auto">${mdToHtml(textOf(t.result) || '（该交付无文本产出）')}${textRefNote(t.result)}</div>
      ${t.delivery?.items?.length ? `<div style="font-size:12px;color:var(--ink-dim);margin:10px 0 4px">交付产物：${t.delivery.items.map(i => esc(i.name || i.file)).join(' · ')}
        ${t.delivery.items.some(i => i.kind === 'log') ? `　<button class="btn btn-o btn-sm" onclick="closeModal();viewSessionLog('${t.id}')">${ic('scroll-text')} 过程日志</button>` : ''}</div>` : ''}
      <div style="max-height:34vh;overflow:auto">${renderDiffPanel(t, true)}</div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">关闭</button>
      ${t.delivery?.dir && window.reins ? `<button class="btn btn-o" onclick="revealDeliveryDir('${t.id}')">${ic('folder')} 产物目录</button>` : ''}
      ${t.result ? `<button class="btn btn-p" onclick="downloadDelivery('${t.id}')">下载 .md</button>` : ''}</div>`);
}
function revealDeliveryDir(id) {
  const t = byId(id);
  if (t.delivery?.dir && window.reins) window.reins.deliveryReveal(t.delivery.dir);
  else toast('不可用', '该交付没有落盘产物目录', '⚠');
}
/* 过程日志查看（第八轮）：读取 deliveries/<KEY>/session.log，多轮执行追加在同一文件 */
async function viewSessionLog(id) {
  const t = byId(id);
  const it = t?.delivery?.items?.find(i => i.kind === 'log');
  if (!it || !t.delivery.dir || !window.reins) { toast('不可用', '该任务没有过程日志', '⚠'); return; }
  const r = await window.reins.deliveryRead(t.delivery.dir, it.file);
  if (!r.ok) { toast('读取失败', r.error || '', '⚠'); return; }
  openModal(`<div class="modal-head"><h3>过程日志</h3><span>${esc(t.key)} · session.log</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <pre style="max-height:52vh;overflow:auto;font-family:var(--mono);font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-all;background:var(--ink-0,#f6f4f0);border:1px solid var(--line,#e4e0d8);border-radius:8px;padding:12px">${esc(r.text)}</pre>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">关闭</button>
      <button class="btn btn-o" onclick="revealDeliveryDir('${t.id}')">${ic('folder')} 产物目录</button>
      <button class="btn btn-p" onclick="navigator.clipboard.writeText(window.__sessLog).then(()=>toast('已复制','过程日志已复制到剪贴板','⧉'))">复制全文</button></div>`);
  window.__sessLog = r.text;
}
function copyDelivery(id) {
  const t = byId(id);
  textFull(t.result).then(full => navigator.clipboard.writeText(full || '')).then(
    () => toast('已复制', t.key + ' 的交付物已复制到剪贴板', '⧉'),
    () => toast('复制失败', '当前环境未授权剪贴板', '⚠'));
}
/* 下载交付：必须取全文。用 textOf 只会下载到 400 字摘要——拿到一个"看起来正常、
   其实残缺"的文件比报错更糟，所以这里 await 全文（取不到时才退回摘要并如实提示） */
async function downloadDelivery(id) {
  const t = byId(id);
  const isRef = isTextRef(t.result);
  const full = await textFull(t.result);
  const truncated = isRef && full === String(t.result.preview || '');
  const blob = new Blob([full], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = t.key + '-' + String(t.title || '交付').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) + '.md';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  if (truncated) toast('正文缺失，已下载摘要', '正文文件不在本机，只有前 ' + full.length + ' 字', '⚠');
  else toast('已下载', a.download, '⇩');
}

function revealWt(id) {
  const t = byId(id);
  if (t?.worktree && window.reins) window.reins.revealWorktree(t.worktree);
  else toast('不可用', '浏览器预览模式下无法打开访达', '⚠');
}

/* —— Git 远程交付（REINS-128）：隔离工作区分支推送 + Pull Request 创建，交付闭环不再切终端 ——
   交付闭环修复：Agent 的改动是 worktree 里的**工作区文件**，分支提交并未前进。
   旧流程直接 push 会推出空分支且 git 返回 0（界面报成功、远程没代码）。
   现在「推送」默认先在 worktree 内提交，再推；一键「提交并创建 PR」把三步串起来。 */
function gitRemoteBlock(t) {
  if (!window.reins || !t.worktree) return '';
  const branch = 'reins/' + t.key;
  return `<div class="d-sec"><h4>远程交付</h4>
    <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-p btn-sm" onclick="gitDeliverTask('${t.id}')">${ic('arrow-right-left')} 提交并创建 PR</button>
      <button class="btn btn-o btn-sm" onclick="gitPushTask('${t.id}')">⇧ 仅推送 ${esc(branch)}</button>
      ${t.prUrl ? `<a class="pr-link" href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR #${esc(String(t.prNo ?? ''))} ↗</a>` : ''}
    </div>
    <div class="git-log" id="git-log"></div>
    <div style="font-size:12px;color:var(--ink-faint);margin-top:6px">推送前会把隔离工作区的改动提交到 <b>${esc(branch)}</b>（提交信息用任务号 + 标题），再推 origin；PR 支持 GitHub / Gitee，令牌在「设置 → Git 远程」配置（需 repo 读写权限）。</div>
  </div>`;
}
const gitLog = html => { const el = document.getElementById('git-log'); if (el) el.innerHTML = html; };

/* 交付结果 → 时间线 + 提示：四类失败（有未提交 / 无新提交 / 认证 / 网络）分别给可操作文案 */
function gitResultEpisode(t, r, doneText) {
  if (r.ok) {
    const msg = String(r.message || '').slice(0, 120);
    gitLog('<span class="ln ok">✓ ' + esc(msg) + '</span>');
    th(t, '⇧', doneText || msg);
    return true;
  }
  gitLog('<span class="ln err">✗ ' + esc(r.message || '') + '</span>');
  const tip = r.kind === 'uncommitted' ? '点「提交并创建 PR」会自动提交后推送'
    : r.kind === 'no-commits' ? '分支没有新提交：确认 Agent 是否真的改了文件'
      : r.kind === 'auth' ? '检查「设置 → Git 远程」的令牌或改用 SSH 远程'
        : r.kind === 'network' ? '检查网络 / 代理' : '';
  if (tip) gitLog('<span class="ln">↳ ' + esc(tip) + '</span>');
  toast(r.kind === 'no-commits' ? '无新提交' : '推送失败', String(r.message || '').slice(0, 60), '⚠');
  return false;
}

/* 推送（默认先在 worktree 内提交 Agent 改动，避免推出空分支） */
async function gitPushTask(id, opts) {
  const t = byId(id); if (!t || !t.worktree || !window.reins) return false;
  const o = opts || {};
  gitLog('<span class="ln act">▸ 正在提交并推送 reins/' + esc(t.key) + ' …</span>');
  const r = await window.reins.gitPush({
    cwd: t.worktree, branch: 'reins/' + t.key,
    commit: o.commit !== false,
    message: t.key + ' ' + String(t.title || '').slice(0, 60),
  }).catch(e => ({ ok: false, message: e.message }));
  const ok = gitResultEpisode(t, r, '分支 reins/' + t.key + ' 已提交并推送到远程');
  if (ok) { save(); if (drawerOpenOn(id)) renderDrawer(id); }
  return ok;
}
async function gitPRTask(id) {
  const t = byId(id); if (!t || !t.worktree || !window.reins) return;
  gitLog('<span class="ln act">▸ 正在识别远程仓库…</span>');
  const info = await window.reins.gitRemote(t.worktree).catch(e => ({ ok: false, message: e.message }));
  if (!info.ok) { gitLog('<span class="ln err">✗ ' + esc(info.message || '') + '</span>'); toast('无法识别远程', String(info.message || '').slice(0, 60), '⚠'); return; }
  if (!info.supported) { gitLog('<span class="ln err">✗ 仅支持 GitHub / Gitee 托管，当前 origin：' + esc(info.origin?.url || '') + '</span>'); toast('不支持的托管平台', '', '⚠'); return; }
  prModal(t, info);
}
function prModal(t, info) {
  const prov = info.origin.provider === 'gitee' ? 'Gitee' : 'GitHub';
  openModal(`<div class="modal-head"><h3>创建 PR</h3><span>${prov} · ${esc(info.origin.slug)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-2col">
        <div class="f-row"><label>源分支（head）</label><input type="text" id="pr-head" value="reins/${esc(t.key)}" readonly></div>
        <div class="f-row"><label>目标分支（base）</label><input type="text" id="pr-base" value="${esc(info.defaultBranch || 'main')}"></div>
      </div>
      <div class="f-row"><label>标题</label><input type="text" id="pr-title" value="${esc(t.key + ' ' + t.title)}"></div>
      <div class="f-row"><label>描述</label><textarea id="pr-body" style="min-height:90px" placeholder="变更说明（默认带入交付摘要）">${esc(textOf(t.result, 2000))}</textarea></div>
      <div class="set-desc">令牌从「设置 → Git 远程」读取；分支需先推送到远程（重复开 PR 会自动找回既有链接）。</div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="prCreate('${t.id}')">创建 PR</button></div>`);
}

/* 一键交付闭环：提交 worktree 改动 → 推送分支 → 创建 PR（任何一步失败都停在可解释的状态）。
   PR 参数用默认值（源分支 reins/<KEY>、目标分支 origin 默认分支、标题任务号+标题、描述交付摘要），
   需要改目标分支或描述时仍可走「创建 PR」单独入口。 */
async function gitDeliverTask(id) {
  const t = byId(id); if (!t || !t.worktree || !window.reins) return;
  if (!t.result) { toast('尚无可交付内容', '任务还没有执行产出，先在看板上让 Agent 执行', '⚠'); return; }
  const btn = document.querySelector('#git-log')?.previousElementSibling?.querySelector('.btn-p');
  if (btn) { btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '交付中…'; setTimeout(() => { btn.disabled = false; btn.innerHTML = old; }, 60000); }

  gitLog('<span class="ln act">▸ ① 提交隔离工作区改动并推送…</span>');
  const pushed = await gitPushTask(id, { commit: true });
  if (!pushed) return;

  gitLog('<span class="ln act">▸ ② 识别远程仓库…</span>');
  const info = await window.reins.gitRemote(t.worktree).catch(e => ({ ok: false, message: e.message }));
  if (!info.ok || !info.supported) {
    const why = !info.ok ? info.message : '仅支持 GitHub / Gitee 托管，当前 origin：' + (info.origin?.url || '');
    gitLog('<span class="ln err">✗ 分支已推送，但无法创建 PR：' + esc(why || '') + '</span>');
    toast('已推送，PR 未创建', String(why || '').slice(0, 60), '⚠');
    return;
  }
  gitLog('<span class="ln act">▸ ③ 创建 PR…</span>');
  const r = await window.reins.gitCreatePR({
    cwd: t.worktree,
    head: 'reins/' + t.key,
    base: info.defaultBranch || 'main',
    title: t.key + ' ' + t.title,
    body: textOf(t.result, 4000),
  }).catch(e => ({ ok: false, message: e.message }));
  if (!r.ok) {
    gitLog('<span class="ln err">✗ PR 创建失败：' + esc(r.message || '') + '</span>'
      + '<span class="ln">↳ 分支已推送成功，可稍后用「创建 PR」重试或手动开 PR</span>');
    toast('已推送，PR 失败', String(r.message || '').slice(0, 60), '⚠');
    return;
  }
  if (r.url) { t.prUrl = r.url; t.prNo = r.number; }
  th(t, '⇄', '交付完成：分支已推送' + (r.url ? '，PR ' + r.url : '（该分支已有打开的 PR）'));
  gitLog('<span class="ln ok">✓ 交付闭环完成' + (r.url ? '：' + esc(r.url) : '（既有 PR 已找回）') + '</span>');
  save(); renderDrawer(id);
  toast(r.exists ? 'PR 已存在' : 'PR 已创建', r.url ? String(r.url).slice(0, 60) : '该分支已有打开的 PR', '⇄');
}
async function prCreate(id) {
  const t = byId(id); if (!t || !window.reins) return;
  const p = {
    cwd: t.worktree,
    head: $('#pr-head')?.value.trim(),
    base: $('#pr-base')?.value.trim() || 'main',
    title: $('#pr-title')?.value.trim() || (t.key + ' ' + t.title),
    body: $('#pr-body')?.value || '',
  };
  if (!p.head) { toast('缺少源分支', '', '⚠'); return; }
  const btn = document.querySelector('.modal-foot .btn-p'); if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
  const r = await window.reins.gitCreatePR(p).catch(e => ({ ok: false, message: e.message }));
  if (btn) { btn.disabled = false; btn.textContent = '创建 PR'; }
  if (!r.ok) { toast('PR 创建失败', String(r.message || '').slice(0, 80), '⚠'); return; }
  if (r.url) { t.prUrl = r.url; t.prNo = r.number; }
  th(t, '⇄', 'PR 已创建' + (r.url ? '：' + r.url : '（该分支已有打开的 PR）'));
  save(); closeModal(); renderDrawer(id);
  toast(r.exists ? 'PR 已存在' : 'PR 已创建', r.url ? r.url.slice(0, 60) : '该分支已有打开的 PR', '⇄');
}

/* —— 拟议变更审查（借鉴 HiFox 确认墙）：按文件 diff 展示，验收人显式"确认应用 / 放弃" —— */
const diffExpanded = new Set();
function renderDiffLines(t, f) {
  const max = diffExpanded.has(t.id + '|' + f.path) ? 5000 : 60;
  const lines = f.lines.slice(0, max).map(l => {
    const cls = l.startsWith('@@') ? 'dhk' : l.startsWith('+') ? 'dadd' : l.startsWith('-') ? 'ddel' : 'dctx';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('');
  const more = f.lines.length > max
    ? `<span class="dmore" onclick="expandDiff('${t.id}','${esc(f.path)}')">… 还有 ${f.lines.length - max} 行，点击展开</span>` : '';
  return `<pre class="dff-lines" style="display:none">${lines}${more}</pre>`;
}
function renderDiffPanel(t, readOnly?) {
  const d = t.delivery && t.delivery.diff;
  if (!d || !d.files || !d.files.length) return '';
  const total = d.files.reduce((s, f) => ({ a: s.a + f.add, d: s.d + f.del }), { a: 0, d: 0 });
  const badge = t.delivery.diffState === 'applied' ? '<span class="dff-badge ok">' + ic('check') + ' 已应用到仓库</span>'
    : t.delivery.diffState === 'discarded' ? '<span class="dff-badge no">已放弃</span>'
    : '<span class="dff-badge warn">未确认写入生效</span>';
  const filesHtml = d.files.map(f => `
    <div class="dff-file" onclick="toggleDiffFile(this)">
      <span class="dff-path">${esc(f.path)}</span>
      <span class="dff-stat">+${f.add}</span><span class="dff-stat del">−${f.del}</span>
    </div>${renderDiffLines(t, f)}`).join('');
  const acts = (readOnly || t.delivery.diffState !== 'pending') ? '' : `
    <div style="display:flex;gap:9px;margin-top:10px">
      <button class="btn btn-p btn-sm" onclick="applyDiff('${t.id}')">${ic('check')} 确认应用到仓库</button>
      <button class="btn btn-o btn-sm btn-danger-o" onclick="discardDiff('${t.id}')">${ic('x')} 放弃变更</button>
    </div>`;
  return `<div class="dff-panel">
    <div class="dff-head"><b>代码变更</b><span>${d.files.length} 个文件 · <span class="dff-stat">+${total.a}</span> <span class="dff-stat del">−${total.d}</span></span>${badge}</div>
    ${filesHtml}${acts}
  </div>`;
}
function toggleDiffFile(el) { const nx = el.nextElementSibling; if (nx) nx.style.display = nx.style.display === 'none' ? '' : 'none'; }
function expandDiff(taskId, p) {
  diffExpanded.add(taskId + '|' + p);
  if (drawerOpenOn(taskId)) renderDrawer(taskId);
  else { const m = document.querySelector('.modal-body .dff-panel'); if (m) { const t = byId(taskId); previewDelivery(taskId); } }
}
function applyDiff(id) {
  const t = byId(id);
  if (!window.reins) return toast('浏览器模式', '请在客户端内操作', '⚠');
  window.reins.deliveryApply(t.worktree).then(r => {
    if (r.ok) {
      t.delivery.diffState = 'applied';
      th(t, '✅', '代码变更已应用到仓库（' + r.applied + ' 个文件）');
      toast('已应用', r.applied + ' 个文件的变更已写入仓库工作区', '✓');
    } else toast('应用失败', esc(r.message || ''), '⚠');
    save(); refreshViews(); if (drawerOpenOn(id)) renderDrawer(id);
  });
}
function discardDiff(id) {
  const t = byId(id);
  if (!window.reins) return toast('浏览器模式', '请在客户端内操作', '⚠');
  window.reins.deliveryDiscard(t.worktree).then(r => {
    if (r.ok) {
      t.delivery.diffState = 'discarded'; t.worktree = null;
      th(t, '🗑', '已放弃代码变更（隔离工作区已移除）');
      toast('已放弃', '代码变更与隔离工作区已清除', '');
    } else toast('操作失败', esc(r.message || ''), '⚠');
    save(); refreshViews(); if (drawerOpenOn(id)) renderDrawer(id);
  });
}
/* —— 开放集成：任务事件推送到用户配置的 Webhook（桌面客户端内由主进程发送） —— */
let hookCfg: any = { webhookUrl: '', webhookEvents: { create: true, done: true, reject: true }, jevUrl: 'https://api.typesafe.ai/v1/systemone', jevKey: '', jevModel: 'jev-latest', triageEngine: 'auto', feishu: null };
function notifyHook(event, task) {
  if (!window.reins) return;
  const key = event.split('.')[1];
  if (hookCfg.webhookUrl && (hookCfg.webhookEvents || {})[key] !== false) {
    window.reins.webhookSend({
      event, at: new Date().toISOString(), space: S().name,
      task: { key: task.key, title: task.title, status: task.status, pri: task.pri, deliver: task.pr || null },
    }).then(r => { if (!r.ok) toast('Webhook 推送失败', r.error || ('HTTP ' + r.status), '⚠'); }).catch(() => { });
  }
  /* 飞书通道：与 Webhook 并行（地址填飞书机器人时 Webhook 那一路也会自动转卡片，这里发的是同一事件的应用通道） */
  notifyFeishu(event, task);
}

/* —— 执行记账：质量指标（成功/失败/耗时/首过）+ 成本（tokens × 单价）+ 执行流水表 ——
   Agent 卡片原来只有「累计完成 / tokens」两个数，回答不了「这个 Agent 靠不靠谱、今天花了多少」。
   现在每次执行结束：记 Agent 累计指标，同时落一条流水到组织（org.execLog，封顶 500 条）——
   逐日成本、最近执行明细都从流水表算。金额走主进程统一计价（services/pricing.js），
   回包后回填流水行的 cost/priced（异步，不阻塞执行完成后的渲染）。 */
function accountRun(agent, info) {
  if (!agent) return;
  const i = info || {};
  agent.stats = agent.stats || { fail: 0, durMs: 0, runs: 0, unpriced: 0 };
  const st = agent.stats;
  st.runs = (st.runs || 0) + 1;
  if (i.ok === false) st.fail = (st.fail || 0) + 1;
  if (Number.isFinite(i.ms) && i.ms > 0) st.durMs = (st.durMs || 0) + i.ms;
  const tokensTotal = i.usage?.total_tokens || i.tokens || 0;
  agent.tokens = (agent.tokens || 0) + tokensTotal;
  /* 首过率样本：只有「交付级完成」计交付（单任务 done 与流水线终段），失败/中间阶段不计 */
  if (i.ok !== false && i.delivery) {
    st.deliveries = (st.deliveries || 0) + 1;
    if (i.firstPass === true) st.firstPass = (st.firstPass || 0) + 1;
  }
  /* 执行流水表（组织维度）：与 Agent 指标同源同刻，坏环境（ExecLog 未注入）静默跳过不丢指标 */
  let row = null;
  try {
    const org = O();
    if (org && typeof window.ExecLog !== 'undefined') {
      org.execLog = Array.isArray(org.execLog) ? org.execLog : [];
      row = ExecLog.makeEntry({
        at: Date.now(), taskId: i.taskId, taskKey: i.taskKey, taskTitle: i.taskTitle,
        agentId: agent.id, agentName: agent.name, model: i.model || agent.model, provider: agent.provider,
        stage: i.stage || null, ok: i.ok !== false, firstPass: i.delivery ? i.firstPass === true : null,
        ms: i.ms || 0, usage: i.usage || null
      });
      ExecLog.push(org.execLog, row);
    }
  } catch (e) { row = null; }
  /* 计价是异步 IPC：不阻塞执行完成后的渲染，回包再补金额（Agent 累计 + 流水行）并刷新 */
  if (tokensTotal && window.reins?.priceEstimate) {
    window.reins.priceEstimate({ usage: i.usage, model: i.model, provider: i.provider }).then(est => {
      if (!est) return;
      if (est.ok) {
        agent.cost = Math.round(((agent.cost || 0) + est.cost) * 10000) / 10000;
        agent.priced = (agent.priced || 0) + 1;
        if (row) { row.cost = est.cost; row.priced = true; }
      } else {
        st.unpriced = (st.unpriced || 0) + 1;
        if (row) row.priced = false;
      }
      save();
      if (curView === 'agents' || curView === 'dash') refreshViews();
    }).catch(() => { st.unpriced = (st.unpriced || 0) + 1; if (row) row.priced = false; });
  } else if (tokensTotal) {
    st.unpriced = (st.unpriced || 0) + 1;
    if (row) row.priced = false;
  } else if (row) {
    row.priced = false;   // 无用量（演示引擎 / 引擎未上报 usage）：无价可计，标未定价而非永久「计价中」
  }
}
/* 失败记账：error 事件调用（用户主动终止不计失败） */
function accountFail(agent, info) {
  if (!agent) return;
  accountRun(agent, Object.assign({ ok: false }, info || {}));
}
/* 金额显示：与主进程 pricing.fmtMoney 同口径（渲染层拿不到 require，重复一份轻实现） */
function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '¥0';
  if (n < 0.01) return '¥' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 1) return '¥' + n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 1000) return '¥' + n.toFixed(2).replace(/\.00$/, '');
  if (n < 1e6) return '¥' + (n / 1000).toFixed(2).replace(/\.00$/, '') + 'k';
  return '¥' + (n / 1e6).toFixed(2) + 'M';
}
/* 成功率：0 次执行返回 null（不显示 0%，那会被误读成"全失败"） */
function successRate(done, fail) {
  const d = Number(done) || 0, f = Number(fail) || 0, total = d + f;
  if (!total) return null;
  return Math.round((d / total) * 1000) / 10;
}
/* 平均耗时文案：durationMs 累计 / runs 样本 → 900ms / 30s / 2m15s */
function fmtAvgDuration(agent) {
  const st = (agent && agent.stats) || {};
  const ms = Number(st.durMs) || 0;
  const n = Number(st.runs) || 0;
  if (!ms || !n) return null;
  const avg = ms / n;
  if (avg < 1000) return Math.round(avg) + 'ms';
  if (avg < 60000) return (avg / 1000).toFixed(avg < 10000 ? 1 : 0) + 's';
  const m = Math.floor(avg / 60000), s = Math.round((avg % 60000) / 1000);
  return m + 'm' + (s ? s + 's' : '');
}

/* —— 飞书事件推送：kind 交给主进程映射成卡片（created / done / rejected / failed / timeout） ——
   静默失败：飞书是旁路通知，不能让推送问题打断任务操作；错误由「集成」页的推送日志兜底展示 */
function notifyFeishu(event, task, extra?) {
  const f = hookCfg.feishu;
  if (!window.reins?.feishuNotify || !f || !f.enabled) return;
  const kind = event === 'task.created' ? 'created' : event === 'task.done' ? 'done'
    : event === 'task.rejected' ? 'rejected' : event === 'task.failed' ? 'failed'
      : event === 'task.timeout' ? 'timeout' : '';
  if (!kind) return;
  window.reins.feishuNotify({
    kind, space: S().name,
    task: {
      key: task.key, title: task.title, status: task.status, pri: task.pri,
      pr: task.pr || null, assignee: task.assignee || null, assigneeName: task.assignee?.name || '',
    },
    reason: extra?.reason || '',
    extra: extra?.extra || null,
  }).catch(() => { });
}

/* —— 侧栏折叠（窄栏图标模式，⌘B） —— */
function toggleSidebar(force?) {
  const min = force !== undefined ? force : !document.body.classList.contains('side-min');
  document.body.classList.toggle('side-min', min);
  try { localStorage.setItem('reins-side-min', min ? '1' : ''); } catch (e) { }
  const btn = document.getElementById('side-collapse');
  if (btn) btn.textContent = min ? '»' : '«';
}
function initSidebar() {
  let min = false;
  try { min = localStorage.getItem('reins-side-min') === '1'; } catch (e) { }
  if (min) toggleSidebar(true);
}

/* —— 关窗驻留提示：主进程在首次关窗时通知；确认后再隐藏窗口（先隐后弹会把窗口重新拉起） —— */
function showTrayNoticeModal() {
  openModal(`<div class="modal-head"><h3>Reins 将驻留菜单栏</h3><span>本机节点</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div style="display:flex;gap:14px;align-items:flex-start">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;color:var(--accent);flex:none">${ic('server', 'ic-lg')}</div>
        <div style="font-size:13px;color:var(--ink-dim);line-height:1.7">
          收起窗口后 <b style="color:var(--ink)">本机节点保持在线</b>，Agent 可继续接收并执行任务。<br>
          随时点菜单栏图标重新打开；如需彻底退出，请用托盘菜单中的「退出」。
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-o" onclick="trayQuitApp()">完全退出…</button>
      <button class="btn btn-p" onclick="trayHideApp()">好，收起窗口</button>
    </div>`);
}
if (window.reins?.onTrayNotice) window.reins.onTrayNotice(showTrayNoticeModal);
function trayHideApp() { closeModal(); window.reins?.trayHide(); }
function trayQuitApp() { closeModal(); window.reins?.trayQuit(); }

/* —— 快捷键帮助 —— */
function openShortcutHelp() {
  const rows = [['⌘1 – ⌘9', '切换视图（概览 / 看板 / 任务 / 交付 / Agent …）'], ['⌘K', '聚焦搜索'], ['⌘N', '新建任务'], ['Esc', '关闭弹窗 / 抽屉 / 菜单'], ['拖拽卡片', '流转状态；拖入「进行中」并指派 Agent 即自动执行']];
  openModal(`<div class="modal-head"><h3>键盘快捷键</h3><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><table class="sk-table">${rows.map(r => `<tr><td><kbd>${r[0]}</kbd></td><td>${r[1]}</td></tr>`).join('')}</table></div>
    <div class="modal-foot"><button class="btn btn-p" onclick="closeModal()">知道了</button></div>`);
}

/* ============ AI 分诊（模型优先，本地规则兜底） ============ */
let triSuggestions = {};
function triageAgent() {
  // 分诊是分析动作：只要 API 型 Agent 配了密钥即可用，不受执行状态位（offline/busy）限制
  return (O().agents || []).find(a => a.mode === 'api' && keyOf(a)) || null;
}
function heuristicTriage(t) {
  const s = (t.title + ' ' + (t.desc || '')).toLowerCase();
  const hit = (ws) => ws.some(w => s.includes(w));
  let type = 'chore', pri = 'P2', why = '未命中明显特征，按杂务处理';
  if (hit(['bug', '缺陷', '报错', '异常', '崩溃', '丢失', '502', '超时', '排查', '修复'])) { type = 'bug'; pri = 'P1'; why = '命中缺陷类关键词'; }
  if (hit(['线上', '紧急', 'p0', '事故'])) pri = 'P0';
  else if (type === 'bug' && !hit(['线上', '紧急'])) pri = 'P1';
  if (type === 'chore') {
    if (hit(['调研', '研究', '竞品', '分析', '行业'])) { type = 'research'; why = '命中调研类关键词'; }
    else if (hit(['文案', '初稿', '公众号', '周报', '文章', '内容'])) { type = 'writing'; why = '命中内容创作关键词'; }
    else if (hit(['发票', '客户', '工单', '咨询', '回复', '投诉'])) { type = 'support'; why = '命中客户支持关键词'; }
    else if (hit(['清洗', '整理', '核对', '表格', '名单', '纪要'])) { type = 'data'; why = '命中数据整理关键词'; }
    else if (hit(['测试', '用例', '回归', 'e2e', '冒烟'])) { type = 'test'; why = '命中测试类关键词'; }
    else if (hit(['登录', '接口', '页面', '适配', '接入'])) { type = 'req'; why = '命中开发需求关键词'; }
  }
  const idle = (O().agents || []).find(a => a.status === 'idle');
  return { type, pri, assignee: idle ? { kind: 'agent', id: idle.id, name: idle.name } : null, reason: why + '（本地规则分诊，配置 API Agent 后可用模型分诊）' };
}
async function runTriage(t) {
  const roster = {
    agents: (O().agents || []).filter(x => x.status !== 'offline').map(x => ({ id: x.id, name: x.name, mode: x.mode })),
    roles: (O().roles || []).filter(r => r.agentId && (O().agents || []).some(x => x.id === r.agentId && x.status !== 'offline'))
      .map(r => ({ id: r.id, name: r.name, agentName: (agentById(r.agentId) || {}).name || '' })),
    members: memberNames(),
  };
  /* 引擎链：Jev 决策模型（结构化判断+概率，百毫秒级）→ API 模型 → 本地规则，逐级降级并如实标注 */
  let jevFail = '';
  if (window.reins && secretOf(hookCfg.jevKey) && (hookCfg.triageEngine || 'auto') !== 'llm') {
    try {
      const r = await window.reins.jevTriage({ task: t, roster });
      if (r && r.ok) {
        const brand = /startlux/i.test(r.engine) ? 'StartLux' : /^jev/i.test(r.engine) ? 'Jev' : '';
        return { ...r.suggestion, engine: brand ? brand + ' 决策（' + r.engine + '）' : '决策引擎（' + r.engine + '）' };
      }
      jevFail = (r && r.message) || '调用失败';
    } catch (e) { jevFail = e.message || '主进程不可达'; }
    if ((hookCfg.triageEngine || 'auto') === 'jev') return { ...heuristicTriage(t), engine: '本地规则（Jev 失败：' + jevFail + '）' };
  }
  const a = triageAgent();
  if (a && window.reins) {
    try {
      const r = await window.reins.triageRun({ task: t, agent: a, roster });
      if (r && r.ok) {
        if (r.usage?.total_tokens) a.tokens = (a.tokens || 0) + r.usage.total_tokens;
        return { ...r.suggestion, engine: a.name + '（' + r.engine + (jevFail ? '，Jev 已降级' : '') + '）' };
      }
      return { ...heuristicTriage(t), engine: '本地规则（' + ((r && r.message) || '模型调用失败') + '）' };
    } catch (e) { /* 主进程不可达等，走兜底 */ }
  }
  return { ...heuristicTriage(t), engine: '本地规则' + (a ? '' : '（未配置 API Agent）') };
}
function triageSugSummary(s) {
  const asg = s.assignee ? (s.assignee.kind === 'agent' ? '◆ ' + s.assignee.name : s.assignee.name) : '保持未指派';
  return `<b>${TYPE_LABEL[s.type] || s.type}</b> · <b class="pri ${s.pri}">${s.pri}</b> · ${esc(asg)}`;
}
async function triageDrawer(id) {
  const btn = $('#tri-btn'); if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
  const s = await runTriage(byId(id));
  triSuggestions[id] = s;
  const out = $('#triage-out');
  if (out) out.innerHTML = `<div class="triage-box">
    <div class="tri-sug">${triageSugSummary(s)}</div>
    ${s.reason ? `<div class="tri-reason">${esc(s.reason)}</div>` : ''}
    <div style="display:flex;gap:9px;margin-top:9px;align-items:center">
      <button class="btn btn-p btn-sm" onclick="applyTriageDrawer('${id}')">应用建议</button>
      <button class="btn btn-o btn-sm" onclick="$('#triage-out').innerHTML=''">忽略</button>
      <span style="font-size:11px;color:var(--ink-faint)">分诊：${esc(s.engine)}</span>
    </div></div>`;
  if (btn) { btn.disabled = false; btn.textContent = '重新分析'; }
}
function applyTriage(id, s, quiet?) {
  const t = byId(id);
  const before = TYPE_LABEL[t.type] + '·' + t.pri;
  if (s.type) t.type = s.type;
  if (s.pri) t.pri = s.pri;
  if (s.assignee) {
    if (s.assignee.kind === 'agent') {
      const a = (O().agents || []).find(x => x.id === s.assignee.id) || (O().agents || []).find(x => x.name === s.assignee.name);
      if (a) t.assignee = { kind: 'agent', id: a.id, name: a.name };
    } else if (s.assignee.kind === 'role') {
      const r = roleById(s.assignee.id) || (O().roles || []).find(x => x.name === s.assignee.name);
      if (r) t.assignee = { kind: 'role', id: r.id, name: r.name };
    } else {
      const nm = memberNames().find(n => n === s.assignee.name);
      if (nm) t.assignee = { kind: 'human', name: nm };
    }
  }
  const to = TYPE_LABEL[t.type] + '·' + t.pri + (t.assignee ? ' · ' + (t.assignee.kind === 'agent' ? '◆' + t.assignee.name : t.assignee.name) : '');
  th(t, '✨', 'AI 分诊：' + before + ' → ' + to);
  addActivity('✨', t.key + ' 完成 AI 分诊（' + (s.engine || '') + '）');
  save(); refreshViews();
  if (!quiet) toast('已应用分诊', t.key + ' → ' + TYPE_LABEL[t.type] + ' · ' + t.pri, '✦');
  delete triSuggestions[id];
}
function applyTriageDrawer(id) { applyTriage(id, triSuggestions[id] || {}); renderDrawer(id); }
async function openTriageBatch() {
  const pool = S().tasks.filter(t => t.status === 'todo' && !t.assignee).slice(0, 8);
  const pool2 = pool.length ? pool : S().tasks.filter(t => t.status === 'todo').slice(0, 8);
  if (!pool2.length) { toast('没有可分诊的任务', '待处理列暂时是空的', '✦'); return; }
  openModal(`<div class="modal-head"><h3>AI 分诊</h3><span>${pool2.length} 个待办 · 逐条分析</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div id="tri-batch">准备中…</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">关闭</button>
      <button class="btn btn-p" onclick="applyAllTriage()">全部应用</button></div>`);
  const rows = [];
  const render = () => {
    const box = $('#tri-batch'); if (!box) return;
    box.innerHTML = `<div style="font-size:12px;color:var(--ink-faint);margin-bottom:10px">分诊引擎：${esc(rows.length ? rows[0].s.engine : '…')}</div>`
      + rows.map(r => `<div class="tri-brow">
        <div class="t">${r.t.key} ${esc(r.t.title)}</div>
        <div class="tri-sug">${triageSugSummary(r.s)}</div>
        ${r.s.reason ? `<div class="tri-reason">${esc(r.s.reason)}</div>` : ''}
        <button class="btn btn-o btn-sm" style="margin-top:7px" onclick="applyTriageRow('${r.t.id}',this)">应用</button>
      </div>`).join('')
      + (rows.length < pool2.length ? '<div class="tri-brow" style="color:var(--ink-faint)">下一条分析中…</div>' : '');
  };
  render();
  for (const t of pool2) {
    const s = await runTriage(t);
    triSuggestions[t.id] = s;
    rows.push({ t, s });
    render();
  }
}
function applyTriageRow(id, el) {
  applyTriage(id, triSuggestions[id] || {}, true);
  toast('已应用', byId(id).key + ' 分诊结果已生效', '✦');
  const row = el.closest('.tri-brow'); if (row) row.remove();
}
function applyAllTriage() {
  const ids = Object.keys(triSuggestions);
  for (const id of ids) { if (byId(id)) applyTriage(id, triSuggestions[id], true); }
  toast('批量分诊完成', ids.length + ' 个任务已应用建议', '✦');
  closeModal();
}

/* ============ 模态 ============ */
function openModal(html) { $('#modal').innerHTML = html; $('#modal-mask').classList.add('show'); }
function closeModal() { $('#modal-mask').classList.remove('show'); }
$('#modal-mask')?.addEventListener('click', e => { if (e.target.id === 'modal-mask') closeModal(); });

function openNewTaskModal() {
  const assigneeOpts = [{ v: '', l: '暂不指派' },
    ...memberNames().map(m => ({ v: 'm:' + m, l: m })),
    ...(O().roles || []).filter(roleUsable).map(r => ({ v: 'r:' + r.id, l: '☆ ' + r.name })),
    ...O().agents.filter(a => agentUsable(a)).map(a => ({ v: 'a:' + a.id, l: a.name }))];
  openModal(`<div class="modal-head"><h3>新建任务</h3><span>REINS-${S().seq}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-row"><label>标题</label><input type="text" id="nt-title" placeholder="用一句话说明要做什么"></div>
      <div class="f-2col">
        <div class="f-row"><label>类型</label>${ds('nt-type', Object.entries(TYPE_LABEL).map(([k, v]) => ({ v: k, l: v })), 'req')}</div>
        <div class="f-row"><label>优先级</label>${ds('nt-pri', ['P2', 'P1', 'P0'].map(p => ({ v: p, l: p })), 'P2')}</div>
      </div>
      <div class="f-row"><label>描述 / 验收标准</label><textarea id="nt-desc" placeholder="背景、期望产出与验收标准"></textarea></div>
      <div class="f-2col">
        <div class="f-row"><label>经办人</label>${ds('nt-assignee', assigneeOpts, '', 'ntSyncModel()')}</div>
        <div class="f-row" style="display:flex;align-items:flex-end"><label class="f-check" style="margin-bottom:9px"><input type="checkbox" id="nt-auto" checked> 指派 Agent 后立即启动</label></div>
      </div>
      <div class="f-row" id="nt-pipe-row">
        <label>流水线</label>
        <label class="pipe-toggle" id="nt-pipe-wrap">
          <input type="checkbox" id="nt-pipe" onchange="ntSyncPipe()">
          <span class="pt-main">
            <b>${ic('compass')} 流水线模式 · 虚拟团队自动流转</b>
            <span>项目经理拆解流程并裁决返工，产品 → 前后端 → 测试接力执行，测试通过后汇总交付</span>
          </span>
        </label>
      </div>
      <div class="f-row" id="nt-model-row" style="display:none"><label>执行模型</label>${ds('nt-model', [{ v: '', l: '默认模型' }], '')}</div>
      ${(S().repos || []).length || S().repoRoot ? `<div class="f-row"><label>代码仓库（CLI 任务在其隔离工作区执行）</label>${ds('nt-repo', repoOpts(''), '')}</div>` : ''}
      <details class="adv-opts">
        <summary>高级选项 · 模型参数（可选，仅 API 引擎生效）</summary>
        <div class="f-2col" style="margin-top:10px">
          <div class="f-row"><label>temperature（0–2）</label><input type="number" id="nt-mp-temp" min="0" max="2" step="0.1" placeholder="${esc(String(hookCfg.modelParams?.temperature ?? 0.6))}"></div>
          <div class="f-row"><label>max_tokens（1–200000）</label><input type="number" id="nt-mp-max" min="1" step="256" placeholder="${esc(String(hookCfg.modelParams?.maxTokens ?? 4096))}"></div>
          <div class="f-row"><label>top_p（0.01–1）</label><input type="number" id="nt-mp-topp" min="0.01" max="1" step="0.05" placeholder="${esc(String(hookCfg.modelParams?.topP ?? 1))}"></div>
        </div>
        <div class="set-desc">留空使用全局默认（设置 → 执行引擎）；仅本次任务生效，执行失败/坏值自动回退默认。</div>
      </details>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="createTask()">创建任务</button></div>`);
  setTimeout(() => { $('#nt-title')?.focus(); ntSyncModel(); }, 60);
}
/* 经办人换成支持选模型的 CLI Agent 时，露出执行模型下拉并回填该 Agent 的模型列表 */
function ntSyncModel() {
  const av = $('#nt-assignee')?.value || '';
  const a = av.startsWith('a:') ? agentById(av.slice(2)) : null;
  const row = $('#nt-model-row');
  const ok = cliCanModel(a);
  if (row) row.style.display = ok ? '' : 'none';
  if (ok) {
    const sel = $('#nt-model');
    if (sel) sel.innerHTML = `<option value="">${esc(a.cliModel ? a.cliModel + '（Agent 默认）' : '默认模型')}</option>`
      + modelOptsSync(a).map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    hydrateModelSelect('nt-model', a, '');
  }
}
/* 流水线开关：勾选后经办人由项目经理统筹，隐藏手工指派 */
function ntSyncPipe() {
  const on = !!$('#nt-pipe')?.checked;
  $('#nt-pipe-wrap')?.classList.toggle('on', on);
  const sel = $('#nt-assignee');
  if (sel) { sel.disabled = on; sel.closest('.f-row').style.opacity = on ? 0.55 : 1; }
  if (on) { const mr = $('#nt-model-row'); if (mr) mr.style.display = 'none'; }
}
function createTask() {
  const title = $('#nt-title').value.trim();
  if (!title) { $('#nt-title').style.borderColor = 'var(--red)'; $('#nt-title').focus(); return; }
  const pipe = !!$('#nt-pipe')?.checked;
  const t: any = {
    id: 't' + S().seq, key: 'REINS-' + S().seq,
    title, type: $('#nt-type').value, pri: $('#nt-pri').value,
    desc: $('#nt-desc').value.trim(), status: 'todo', assignee: null, tags: [], pr: null,
    result: null, thread: [], attachPrompt: null, comments: [], repoRoot: $('#nt-repo')?.value || '',
    runModel: $('#nt-model')?.value || '',
    /* 高级选项（REINS-128）：任务级模型参数临时覆盖，随任务对象透传主进程解析；
       留空的项不入对象（交给全局默认层兜底） */
    modelParams: (() => {
      const g = k => { const v = String($('#nt-mp-' + k)?.value ?? '').trim(); return (v !== '' && Number.isFinite(Number(v))) ? Number(v) : null; };
      const mp = { temperature: g('temp'), maxTokens: g('max'), topP: g('topp') };
      return Object.values(mp).some(v => v !== null) ? mp : null;
    })(),
    createdAt: now(), doneAt: null,
  };
  if (pipe) {
    t.pipeline = { on: true, status: 'idle', mode: '', stages: null, cur: 0, round: 1, maxRework: 5, stageNo: 0, gate: null, reworkCtx: null };
  } else {
    const av = $('#nt-assignee').value;
    if (av.startsWith('m:')) t.assignee = { kind: 'human', name: av.slice(2) };
    else if (av.startsWith('a:')) { const a = agentById(av.slice(2)); t.assignee = { kind: 'agent', id: a.id, name: a.name }; }
  }
  S().tasks.push(t); S().seq++;
  th(t, '➕', '创建了任务' + (pipe ? '（流水线模式）' : ''));
  addActivity('➕', '创建了 ' + t.key + ' ' + t.title + (pipe ? '（流水线）' : ''));
  const auto = $('#nt-auto').checked && (pipe || ['agent', 'role'].includes(t.assignee?.kind));
  save(); closeModal(); refreshViews();
  notifyHook('task.created', t);
  if (auto) startRun(t.id, { byUser: true, openDrawer: true });
  else toast('已创建', t.key + ' ' + esc(t.title), '');
}

/* ---- Agent 配置（真实 API） ---- */
function openAgentConfig(agentId) {
  const a = agentById(agentId); if (!a) return;
  const provOpts = PROVIDER_PRESETS.map(p => ({ v: p.id, l: p.label }));
  const engineFields = a.mode === 'cli' ? `
      <div class="f-2col">
        <div class="f-row"><label>本机命令</label><input type="text" id="ac-cmd" value="${esc(a.cliCommand || '')}" placeholder="例如 claude"></div>
        <div class="f-row" style="display:flex;align-items:flex-end;gap:8px">
          <button class="btn btn-o btn-sm" style="margin-bottom:9px" onclick="acDetectCli('${a.id}')">检测本机命令</button>
        </div>
      </div>
      <div class="f-row"><label>命令模板（{prompt} 为任务提示词占位）</label><input type="text" id="ac-tpl" value="${esc(a.cliTemplate || '')}" placeholder="claude -p {prompt}"></div>
      <div class="f-row"><label>执行位置</label>${ds('ac-runtime', [
        { v: 'local', l: '本机节点（在这台电脑上执行）' },
        { v: 'cloud', l: '云端节点（在设置中配置的服务器上执行）' },
      ], a.runtime === 'cloud' ? 'cloud' : 'local')}</div>
      ${cliCanModel(a) ? `<div class="f-row"><label>执行模型（留空用 CLI 默认）</label><input type="text" id="ac-climodel" list="climodel-list" value="${esc(a.cliModel || '')}" placeholder="例如 glm-5.3-flash">
      <datalist id="climodel-list">${modelOptsSync(a).map(m => `<option value="${m}">`).join('')}</datalist></div>` : ''}`
    : `
      <div class="f-2col">
        <div class="f-row"><label>服务商（OpenAI 兼容）</label>${ds('ac-provider', provOpts, a.provider, 'acProviderChanged()')}</div>
        <div class="f-row"><label>模型</label><input type="text" id="ac-model" value="${esc(a.model || '')}" placeholder="例如 glm-4.7"></div>
      </div>
      <div class="f-row"><label>Base URL</label><input type="text" id="ac-baseurl" value="${esc(a.baseURL || '')}" placeholder="选服务商后自动填入"></div>
      <div class="f-row"><label>API Key（仅保存在本机）</label>${a.__keyLocked ? '<div class="set-desc" style="margin:0 0 6px;color:#c05656">' + ic('triangle-alert') + ' 该密钥已加密但本机解锁失败（系统钥匙串变更？）：留空保存可保留密文，重新填写则覆盖。</div>' : ''}<input type="password" id="ac-key" value="${esc(typeof a.apiKey === 'string' ? a.apiKey : '')}" placeholder="${a.__keyLocked ? '重新填写以覆盖…' : 'sk-…'}" autocomplete="off"></div>`;
  openModal(`<div class="modal-head"><h3>Agent 配置</h3><span>${esc(a.name)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-2col">
        <div class="f-row"><label>名称</label><input type="text" id="ac-name" value="${esc(a.name)}"></div>
        <div class="f-row"><label>执行引擎</label>
          ${ds('ac-mode', [{ v: 'api', l: '真实 API' }, { v: 'cli', l: '本机 CLI' }, { v: 'sim', l: '演示引擎' }], a.mode, `acModeSwap('${a.id}')`)}</div>
      </div>
      ${engineFields}
      <div class="f-row"><label>场景 / 角色附加提示（可选，执行时随任务发送）</label>
        <textarea id="ac-scene" style="min-height:64px" placeholder="例如：你是资深测试工程师，输出必须包含用例表">${esc(a.scenePrompt || '')}</textarea></div>
      <div class="set-banner" style="margin:4px 0 0">密钥与配置仅保存在本机；CLI 模式通过子进程调用本机已安装的命令。</div>
    </div>
    <div class="modal-foot">
      ${a.mode !== 'sim' ? `<button class="btn btn-o" onclick="acTest('${a.id}')">${a.mode === 'cli' ? '试运行' : '测试连接'}</button>` : ''}
      <span style="flex:1"></span>
      <button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="acSave('${a.id}')">保存</button>
    </div>`);
  if (cliCanModel(a)) window.reins && window.reins.cliModels(a).then(list => {
    if (!Array.isArray(list) || !list.length) return;
    _modelOpts[a.cliId] = list;
    const dl = $('#climodel-list');
    if (dl) dl.innerHTML = list.map(m => `<option value="${esc(m)}">`).join('');
  }).catch(() => { });
}
/* 切换服务商：自动带入 Base URL，模型为空时带入预置模型 */
function acProviderChanged() {
  const p = PROVIDER_PRESETS.find(x => x.id === $('#ac-provider')?.value);
  if (!p) return;
  const bu = $('#ac-baseurl'); if (bu && p.baseURL) bu.value = p.baseURL;
  const m = $('#ac-model'); if (m && !m.value.trim() && p.model) m.value = p.model;
}
function acModeSwap(id) {
  const a = agentById(id);
  a.mode = $('#ac-mode').value;
  if (a.mode === 'cli' && !a.cliCommand) { const p = CLI_PRESETS[0]; a.cliCommand = p.cmd; a.cliTemplate = p.template; }
  if (a.mode === 'api' && !a.provider) { a.provider = 'glm'; a.baseURL = PROVIDER_PRESETS[0].baseURL; a.model = PROVIDER_PRESETS[0].model; }
  openAgentConfig(id);
}
async function acDetectCli(id) {
  const a = agentById(id);
  const cmd = $('#ac-cmd')?.value.trim() || a.cliCommand;
  if (!cmd) { toast('请先填写命令', '', '⚠'); return; }
  if (!window.reins) { toast('浏览器模式', '请在客户端内检测', '⚠'); return; }
  const r = await window.reins.cliDetect([cmd]);
  a.detected = !!r[cmd]; save();
  toast(r[cmd] ? '已检测到' : '未安装', cmd + (r[cmd] ? ' 在本机可用' : ' 未在本机 PATH 中找到'), r[cmd] ? '✓' : '⚠');
  openAgentConfig(id);
}
function acCollect(id) {
  const a = agentById(id);
  a.name = $('#ac-name').value.trim() || a.name;
  a.mode = $('#ac-mode').value;
  a.scenePrompt = $('#ac-scene')?.value.trim() || '';
  if (a.mode === 'cli') {
    const cmdVal = $('#ac-cmd')?.value.trim() || '';
    const oldCmd = a.cliCommand;
    if (cmdVal) a.cliCommand = cmdVal;
    const tplVal = $('#ac-tpl')?.value.trim() || '';
    if (tplVal) a.cliTemplate = tplVal;
    /* 命令与模板首 token 保持一致：规范态（模板首 token === 旧命令）下改了"本机命令"，
       同步改写模板首 token（保留其余参数与 {prompt} 段）——实际执行走模板，只改命令不改模板等于没改。
       模板被用户改成非规范形态（首 token ≠ 旧命令，如 env 包装）则不碰模板 */
    const tpl = String(a.cliTemplate || '');
    if (cmdVal && tpl.includes('{prompt}')) {
      const at = tpl.indexOf('{prompt}');
      const head = tpl.slice(0, at), tail = tpl.slice(at);
      const fm = head.trim().match(/^("[^"]*"|'[^']*'|[^\s]+)/);
      const first = fm ? fm[0].replace(/^["']|["']$/g, '') : '';
      if (first && first === oldCmd && first !== cmdVal) {
        const quoted = /\s/.test(cmdVal) ? '"' + cmdVal + '"' : cmdVal;
        a.cliTemplate = head.trim().replace(/^("[^"]*"|'[^']*'|[^\s]+)/, quoted) + ' ' + tail;
      }
    }
    a.runtime = $('#ac-runtime')?.value || 'local';
    if ($('#ac-climodel')) a.cliModel = $('#ac-climodel').value.trim();
  } else if (a.mode === 'api') {
    a.provider = $('#ac-provider')?.value || a.provider;
    a.baseURL = $('#ac-baseurl')?.value.trim() || '';
    a.model = $('#ac-model')?.value.trim() || '';
    /* 空值不抹掉未解锁的密文副本（解锁失败时 apiKey 是密文对象）：用户重填才覆盖 */
    const keyVal = $('#ac-key')?.value.trim() || '';
    if (keyVal || typeof a.apiKey !== 'object') a.apiKey = keyVal;
  }
  return a;
}
function acTest(id) {
  const a = acCollect(id);
  const btn = document.querySelector('.modal-foot .btn-o');
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  (async () => {
    let r;
    if (a.mode === 'cli') {
      const det = window.reins ? await window.reins.cliDetect([a.cliCommand]) : {};
      if (det[a.cliCommand]) {
        r = { ok: true, message: a.cliCommand + ' 已安装，可执行' };
      } else {
        /* 运行时自愈（与主进程 healCliRuntime 同策略）：接入时快照的绝对路径随 CLI 升级/重装失效，
           按 runtimeId（精确）→ cliId 同族（qoder↔qoder-cn）重解析当前发现结果并回写配置 */
        const fam = x => String(x || '').replace(/-cn$/, '');
        const rts = (window.reins ? await window.reins.runtimeDiscover().catch(() => []) : []) || [];
        const rt = rts.find(x => x.id === a.runtimeId) || rts.find(x => fam(x.cliId) === fam(a.cliId));
        const det2 = rt && window.reins ? await window.reins.cliDetect([rt.cliCommand]) : {};
        if (det2[rt.cliCommand]) {
          Object.assign(a, { runtimeId: rt.id, cliCommand: rt.cliCommand, cliTemplate: rt.cliTemplate, cliEnv: rt.cliEnv || undefined, detected: true });
          save();
          /* 同步弹层表单：否则表单还留着旧值，点"保存"会用旧表单把刚自愈的数据覆盖回去（改了又弹回的根因） */
          const cf = $('#ac-cmd'), tf = $('#ac-tpl');
          if (cf) cf.value = a.cliCommand;
          if (tf) tf.value = a.cliTemplate;
          r = { ok: true, message: '原路径已失效，已自动切换到当前安装：' + rt.cliCommand };
        } else {
          r = { ok: false, message: a.cliCommand + ' 未在本机 PATH 中找到' };
        }
      }
    } else {
      r = window.reins ? await window.reins.agentTest(a) : { ok: false, message: '浏览器模式无法测试' };
    }
    if (btn) { btn.disabled = false; btn.textContent = a.mode === 'cli' ? '试运行' : '测试连接'; }
    toast(r.ok ? '连接成功' : '连接失败', esc(r.message || ''), r.ok ? '✓' : '⚠');
  })();
}
function acSave(id) {
  const a = acCollect(id);
  if (a.mode === 'api' && keyOf(a) && a.status === 'offline') a.status = 'idle';
  if (a.mode === 'cli' && a.status === 'offline' && a.detected) a.status = 'idle';
  save(); closeModal(); refreshViews();
  toast('已保存', a.name + '（' + (a.mode === 'api' ? '真实 API' : a.mode === 'cli' ? '本机 CLI' : '演示') + '）', '');
}

/* ---- 接入 Agent ---- */
let APP_RUNTIMES = [];
async function openAddAgentModal() {
  // 本机应用内置运行时（免安装）：发现即接入，模板里已配好绝对路径与配套 node
  APP_RUNTIMES = (window.reins ? await window.reins.runtimeDiscover().catch(() => []) : []) || [];
  const rtCards = APP_RUNTIMES.map(r => `<div class="pick" onclick="addAppRuntime('${r.id}')">
    <b>${ic('server')} ${esc(r.label)}</b><span>${esc(r.note)}</span>
    <span style="color:var(--accent);white-space:nowrap">接入 →</span>
  </div>`).join('');
  const provCards = PROVIDER_PRESETS.map(p => `<div class="pick" onclick="addApiAgent('${p.id}')">
    <b>${brandIcon(PROVIDER_LOGO[p.id]) || brandMono(p.label)} ${p.label}</b><span>${p.model || '自填模型'}</span>
    <span style="color:var(--accent);white-space:nowrap">接入 →</span>
  </div>`).join('');
  const cliCards = CLI_PRESETS.map(p => `<div class="pick" onclick="addCliAgent('${p.id}')" id="cli-${p.id}">
    <b>${brandIcon(CLI_LOGO[p.id]) || brandMono(p.label)} ${p.label}</b><span>${p.cmd}</span>
    <span class="cli-st" data-st="checking">检测中…</span>
  </div>`).join('');
  openModal(`<div class="modal-head"><h3>接入 Agent</h3><span>通过 API Key 或本机 CLI 接入</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      ${rtCards ? `<div class="add-sec-h">本机应用内置运行时 · 免安装</div><div class="picklist">${rtCards}</div>` : ''}
      <div class="add-sec-h"${rtCards ? ' style="margin-top:18px"' : ''}>API 服务商（OpenAI 兼容，需 API Key）</div>
      <div class="picklist">${provCards}</div>
      <div class="add-sec-h" style="margin-top:18px">本机 CLI 工具（子进程调用）</div>
      <div class="picklist">${cliCards}</div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px dashed var(--line)">
        <div style="font-size:12px;color:var(--ink-dim);margin-bottom:10px">不需要真实调用？可添加演示引擎（本地模拟）：</div>
        <button class="btn btn-o btn-sm" onclick="addSimAgent()">＋ 添加演示引擎</button>
      </div>
    </div>`);
  if (window.reins) {
    window.reins.cliDetect(CLI_PRESETS.map(p => p.cmd)).then(found => {
      CLI_PRESETS.forEach(p => {
        const el = document.getElementById('cli-' + p.id);
        if (!el) return;
        const st = el.querySelector('.cli-st');
        st.dataset.st = found[p.cmd] ? 'ok' : 'miss';
        st.textContent = found[p.cmd] ? '✓ 已安装 · 接入' : (p.install ? '未安装 · 点击复制安装命令' : '未安装 · 仍可接入');
        /* 未安装且有官方安装配方（逆向 HiFox 安装表）：点击状态标签直接复制，不触发卡片接入 */
        st.style.cursor = found[p.cmd] || !p.install ? '' : 'pointer';
        st.onclick = found[p.cmd] || !p.install ? null : (ev => {
          ev.stopPropagation();
          if (navigator.clipboard) navigator.clipboard.writeText(p.install).then(() => toast('已复制安装命令', '粘贴到终端执行即可：' + p.install, '⌨'));
        });
      });
    });
  } else {
    CLI_PRESETS.forEach(p => {
      const el = document.getElementById('cli-' + p.id);
      if (el) { const st = el.querySelector('.cli-st'); st.dataset.st = 'miss'; st.textContent = '客户端内可检测'; }
    });
  }
}
function addApiAgent(providerId) {
  const p = PROVIDER_PRESETS.find(x => x.id === providerId);
  const id = 'a' + now();
  O().agents.push({
    id, name: p.label, mode: 'api',
    provider: p.id, baseURL: p.baseURL, model: p.model, apiKey: '',
    status: 'offline', taskId: null, done: 0, tokens: 0,
  });
  save(); closeModal(); refreshViews();
  toast('已接入', p.label + ' · 请填入 API Key', '');
  openAgentConfig(id);
}
function addCliAgent(presetId) {
  const p = CLI_PRESETS.find(x => x.id === presetId);
  const id = 'a' + now();
  O().agents.push({
    id, name: p.label, mode: 'cli',
    cliId: p.id, cliCommand: p.cmd, cliTemplate: p.template,
    scenePrompt: '', detected: false,
    status: 'idle', taskId: null, done: 0, tokens: 0,
  });
  save(); closeModal(); refreshViews();
  toast('已接入', p.label + '（本机 CLI）', '✳');
  openAgentConfig(id);
}
/* 应用内置运行时接入：模板带绝对路径与配套 node，零配置 */
function addAppRuntime(rtId) {
  const r = APP_RUNTIMES.find(x => x.id === rtId);
  if (!r) return;
  const id = 'a' + now();
  O().agents.push({
    id, name: r.label, mode: 'cli',
    cliId: r.cliId, cliCommand: r.cliCommand, cliTemplate: r.cliTemplate,
    cliEnv: r.cliEnv || undefined, runtimeId: r.id, acp: r.acp || undefined,
    scenePrompt: '', detected: true,
    status: 'idle', taskId: null, done: 0, tokens: 0,
  });
  save(); closeModal(); refreshViews();
  toast('已接入', r.label + '（应用内置运行时）', '✳');
  openAgentConfig(id);
}
function addSimAgent() {
  const id = 'a' + now();
  O().agents.push({ id, name: '演示引擎 ' + (O().agents.filter(a => a.mode === 'sim').length + 1), glyph: pick(['✳', '⬡', '⬢', '✦', '◈']), mode: 'sim', status: 'idle', taskId: null, done: 0, tokens: 0 });
  save(); closeModal(); refreshViews();
  toast('已添加', '演示引擎（本地模拟执行）', '✳');
}

function openNewPromptModal() {
  openModal(`<div class="modal-head"><h3>新建提示词</h3><span>保存后可在任务中附加</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-row"><label>标题</label><input type="text" id="np-title" placeholder="例如：发布前检查清单"></div>
      <div class="f-row"><label>一句话说明</label><input type="text" id="np-desc" placeholder="什么场景用这条提示词"></div>
      <div class="f-row"><label>内容</label><textarea id="np-content" style="min-height:140px" placeholder="提示词正文，支持 {{变量}} 占位"></textarea></div>
      <div class="f-row"><label>标签（逗号分隔）</label><input type="text" id="np-tags" placeholder="调研, 模板"></div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="createPrompt()">保存</button></div>`);
}
function createPrompt() {
  const title = $('#np-title').value.trim(); if (!title) { $('#np-title').focus(); return; }
  S().prompts.unshift({
    id: 'p' + now(), title,
    desc: $('#np-desc').value.trim() || '（无说明）',
    content: $('#np-content').value,
    tags: $('#np-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    uses: 0,
  });
  toast('已保存', '「' + esc(title) + '」已存入提示词库', '✎');
  save(); closeModal(); refreshViews();
}

/* ============ 设置 ============ */
function viewSettings() {
  return `<div class="view-head"><h2>设置</h2><p>模型与密钥 · 客户端偏好 · 数据</p></div>
    <div style="max-width:720px">
      <div class="panel" id="agents-cfg-panel" style="margin-bottom:14px"><h3 class="set-h" style="margin-top:0">模型与密钥</h3><div id="agents-cfg">载入中…</div></div>
      <div id="set-panel" class="panel">载入中…</div>
    </div>`;
}
function renderAgentsCfg() {
  const box = document.getElementById('agents-cfg'); if (!box) return;
  box.innerHTML = O().agents.map(a => {
    const ok = a.mode === 'sim' || !!keyOf(a);
    return `<div class="set-row">
      <div><b>${brandOf(a)} ${esc(a.name)} ${a.mode === 'api' ? '<span class="mode-pill api">真实 API</span>' : '<span class="mode-pill sim">演示</span>'}</b>
        <div class="set-desc">${a.mode === 'api' ? esc(providerLabel(a.provider)) + ' · ' + esc(a.model || '—') + ' · ' + (keyOf(a) ? '密钥已配置' : a.__keyLocked ? '<b style="color:#c05656">密钥已加密但本机解锁失败（重配一次即恢复）</b>' : '<b style="color:#c05656">密钥未配置</b>') : '本地模拟执行，无需密钥'}</div></div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        ${a.mode === 'api' ? `<button class="btn btn-o btn-sm" onclick="openAgentConfig('${a.id}')">${ok ? '配置' : '去配置'}</button>` : ''}
      </div>
    </div>`;
  }).join('');
}
async function hydrateSettings() {
  renderAgentsCfg();
  const box = document.getElementById('set-panel'); if (!box) return;
  let s = null;
  if (window.reins) { try { s = await window.reins.getSettings(); } catch (e) { } }
  if (!s) {
    box.innerHTML = `<div class="set-banner">当前在浏览器中运行：执行引擎仅演示模式，客户端设置项在 <b>Reins 桌面客户端</b> 内生效。</div>`
      + settingsHTML({ launchAtLogin: false, keepInTray: true }, false);
    return;
  }
  box.innerHTML = settingsHTML(s, true);
  hydrateSchedules();
  hydrateSec();
  hydratePrices();
  /* 自检面板：已有报告先渲染（打开设置立刻可见），再后台刷新一次 */
  renderIntegrityPanel();
  runIntegrityCheck(false, { silent: true });
}
function settingsHTML(s, live) {
  const row = (id, label, desc, on) => `<div class="set-row"><div><b>${label}</b><div class="set-desc">${desc}</div></div>
    <label class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${live ? '' : 'disabled'} onchange="setClient('${id}',this.checked)"><i></i></label></div>`;
  return `<h3 class="set-h" style="margin-top:0">客户端</h3>
    ${row('launchAtLogin', '开机自动启动', '登录系统后自动运行 Reins，以隐藏窗口启动并驻留', s.launchAtLogin)}
    ${row('keepInTray', '关闭窗口时驻留菜单栏', '保持本机节点在线，Agent 可继续接收并执行任务', s.keepInTray)}
    <h3 class="set-h">执行引擎 · API</h3>
    ${window.reins ? `
    <div class="set-row" style="display:block">
      <div class="f-2col">
        <div class="f-row"><label>无响应超时（秒，默认 120）</label><input type="number" id="se-timeout" min="5" step="5" value="${Math.round((s.apiTimeoutMs || 120000) / 1000)}"></div>
        <div class="f-row"><label>瞬态错误自动重试上限（0–10，默认 3）</label><input type="number" id="se-retries" min="0" max="10" value="${s.apiRetries ?? 3}"></div>
      </div>
      <div class="set-desc" style="margin:8px 0 4px">全局默认模型参数（OpenAI 兼容载荷）；任务创建时可在「高级选项」临时覆盖。</div>
      <div class="f-2col">
        <div class="f-row"><label>temperature（0–2）</label><input type="number" id="se-temp" min="0" max="2" step="0.1" value="${esc(String(s.modelParams?.temperature ?? 0.6))}"></div>
        <div class="f-row"><label>max_tokens（1–200000）</label><input type="number" id="se-maxtok" min="1" step="256" value="${esc(String(s.modelParams?.maxTokens ?? 4096))}"></div>
        <div class="f-row"><label>top_p（0.01–1）</label><input type="number" id="se-topp" min="0.01" max="1" step="0.05" value="${esc(String(s.modelParams?.topP ?? 1))}"></div>
      </div>
      <div class="set-desc" style="margin:6px 0 0">429 / 5xx / 网络超时按 1s→2s→4s→8s 指数退避自动重试（429 优先遵循 Retry-After），重试节奏在任务流式输出区可见；仅作用于 API 通路，CLI / ACP / 云端不受影响。</div>
      <div style="margin-top:8px"><button class="btn btn-p btn-sm" onclick="engineSave()">保存执行策略</button></div>
    </div>` : `<div class="set-row"><div><b>执行引擎</b><div class="set-desc">浏览器预览模式下不可用，请在桌面客户端中配置。</div></div></div>`}
    <h3 class="set-h">模型价格表</h3>
    <div class="set-row" style="display:block">
      <div class="set-desc">按「元 / 百万 tokens」填写单价，用于把 token 折算成金额（概览与 Agent 卡片的花费）。留空表示未定价，该模型的执行只计 tokens、不计金额；同名模型会覆盖内置参考价。</div>
      <div id="price-box" style="margin-top:8px">${window.reins ? '载入中…' : '<span class="set-desc">浏览器预览模式下不可用，请在桌面客户端中配置。</span>'}</div>
    </div>
    <h3 class="set-h">自动化调度</h3>
    <div class="set-row" style="display:block">
      <div class="set-desc" style="margin-bottom:8px">按计划自动生成站报 / 周报并写入<b>当前空间</b>看板；应用重启自动恢复，休眠唤醒后 5 分钟窗口内补执行。</div>
      <div id="sched-box">${window.reins ? '载入中…' : '<span class="set-desc">浏览器预览模式下不可用，请在桌面客户端中配置。</span>'}</div>
      ${window.reins ? '<button class="btn btn-o btn-sm" style="margin-top:8px" onclick="openSchedModal(\'\')">＋ 新增调度</button>' : ''}
    </div>
    <h3 class="set-h">安全存储</h3>
    <div class="set-row" style="display:block"><div id="sec-box">${window.reins ? '载入中…' : '<span class="set-desc">浏览器预览模式下不可用，请在桌面客户端中查看。</span>'}</div></div>
    <h3 class="set-h">Git 远程</h3>
    ${window.reins ? `
    <div class="set-row" style="display:block">
      <div class="set-desc">推送任务分支与创建 PR（GitHub / Gitee）用的访问令牌（PAT，需 repo 读写权限），仅保存在本机。</div>
      <div class="f-2col" style="margin-top:8px">
        <div class="f-row"><label>GitHub Token</label><input type="password" id="gt-github" value="${esc(secretOf(s.gitTokens?.github))}" placeholder="ghp_…（可选）" autocomplete="off"></div>
        <div class="f-row"><label>Gitee Token</label><input type="password" id="gt-gitee" value="${esc(secretOf(s.gitTokens?.gitee))}" placeholder="（可选）" autocomplete="off"></div>
      </div>
      ${secretLocked(s.gitTokens?.github) || secretLocked(s.gitTokens?.gitee) ? '<div class="set-desc" style="margin:6px 0 0;color:#c05656">' + ic('triangle-alert') + ' 有令牌已加密但本机解锁失败：留空保存可保留密文，重新填写则覆盖。</div>' : ''}
      <div style="margin-top:8px;display:flex;gap:9px;align-items:center">
        <button class="btn btn-p btn-sm" onclick="gitTokensSave()">保存令牌</button>
        <button class="btn btn-o btn-sm" onclick="gitPatTest('github')">测试 GitHub</button>
        <button class="btn btn-o btn-sm" onclick="gitPatTest('gitee')">测试 Gitee</button>
        <span class="set-desc" id="gt-test" style="margin:0"></span>
      </div>
      <div class="set-desc" style="margin-top:6px">「测试」用输入框当前内容调 /user 只读探活（未保存也能先验令牌对不对）。</div>
    </div>` : `<div class="set-row"><div><b>Git 远程</b><div class="set-desc">浏览器预览模式下不可用，请在桌面客户端中配置。</div></div></div>`}
    <h3 class="set-h">云端节点</h3>
    ${window.reins ? `
    <div class="set-row" style="display:block">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <b>执行位置可选云端的服务器</b>
        <span class="status-pill ${s.cloudUrl ? 'idle' : 'offline'}" id="cn-pill">${s.cloudUrl ? '已配置' : '未配置'}</span>
      </div>
      <div class="set-desc" style="margin-bottom:8px">部署 reins-node/server.js 到你的服务器后，CLI 型 Agent 可选择云端执行，输出实时回传。</div>
      <div class="f-2col">
        <div class="f-row"><label>节点地址</label><input type="text" id="cn-url" value="${esc(s.cloudUrl || '')}" placeholder="https://node.example.com:8787"></div>
        <div class="f-row"><label>访问令牌（--token）</label>${secretLocked(s.cloudToken) ? '<div class="set-desc" style="margin:0 0 6px;color:#c05656">' + ic('triangle-alert') + ' 令牌已加密但本机解锁失败：留空保存可保留密文，重新填写则覆盖。</div>' : ''}<input type="password" id="cn-token" value="${esc(secretOf(s.cloudToken))}" placeholder="与服务器启动参数一致" autocomplete="off"></div>
      </div>
      <div style="display:flex;gap:9px;margin-top:8px">
        <button class="btn btn-p btn-sm" onclick="cloudSave()">保存</button>
        <button class="btn btn-o btn-sm" onclick="cloudTest()">测试连接</button>
      </div>
      <div id="cn-log" style="margin-top:8px;font-size:12px;color:var(--ink-dim)"></div>
    </div>` : `<div class="set-row"><div><b>云端节点</b><div class="set-desc">浏览器预览模式下不可用，请在桌面客户端中配置。</div></div></div>`}
    <h3 class="set-h">关于</h3>
    <div class="set-row"><div><b>Reins v1.0.0</b><div class="set-desc">Agent 任务协作工具${s.version ? ' · 客户端 ' + esc(s.version) : ''}<br>任务数据保存在本机（${window.reins ? 'userData/reins-data.json' : '浏览器 localStorage'}）</div></div></div>
    <h3 class="set-h">数据</h3>
    <div class="set-row" style="display:block">
      <div><b>数据自检</b><div class="set-desc">检查「正文引用是否都有对应文件」「有没有可回收的孤儿目录」「磁盘占用」——外置正文后如果文件丢了，界面只会静默显示前 400 字摘要，靠这一步才能发现</div></div>
      <div id="integrity-box" style="margin-top:10px">${window.reins ? '载入中…' : '<span class="set-desc">浏览器预览模式下不可用，请在桌面客户端中查看。</span>'}</div>
    </div>
    <div class="set-row"><div><b>导出数据</b><div class="set-desc">导出全部空间与 Agent 配置为 JSON 备份，<b>含全部交付正文</b>（外置的大文本会内联回来，可换机导入）</div></div>
      <button class="btn btn-o btn-sm" data-export-btn onclick="exportData()">导出</button></div>
    <div class="set-row"><div><b>清理交付文件</b><div class="set-desc" id="gc-desc">删除任务时其交付目录已同步清理；若导入过旧档或手工删过任务，可能残留孤儿目录，可在此回收</div></div>
      <button class="btn btn-o btn-sm" onclick="runDeliveryGC()">回收孤儿文件</button></div>
    <div class="set-row"><div><b>导入数据</b><div class="set-desc">从 JSON 备份恢复（将覆盖当前数据）</div></div>
      <button class="btn btn-o btn-sm" onclick="document.getElementById('import-file').click()">导入</button></div>
    <input type="file" id="import-file" accept=".json" style="display:none" onchange="importData(this)">
    <div class="set-row"><div><b>清空数据</b><div class="set-desc">清空全部任务与 Agent 配置，恢复空白工作区</div></div>
      <button class="btn btn-danger btn-sm" onclick="confirmReset()">重置</button></div>`;
}
/* settings:set 返回契约统一收口（REINS-126 返工① · 渲染层补齐）：
   新契约 {ok:true, settings} / {ok:false, error}，兼容旧版直接返回 settings 对象。
   写失败如实提示并返回 null；成功返回 settings 快照——全部调用方（云端/Webhook/Jev/
   客户端开关/防休眠）不再把 {ok,settings} 整包混进业务配置，也不再「界面已保存、磁盘没有」 */
function settingsApplied(r) {
  if (r && r.ok === false) { toast('保存失败', r.error || '设置未能写入磁盘', '⚠'); return null; }
  return r && r.settings !== undefined ? (r.settings || null) : (r || null);
}
function cloudSave() {
  const url = $('#cn-url').value.trim();
  /* 留空且现值是未解锁密文 → 原样带回（同 Agent 表单语义），重填或明文清空才覆盖 */
  const token = secretPick($('#cn-token').value, hookCfg.cloudToken);
  if (url && !/^https?:\/\//.test(url)) { toast('地址无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  window.reins.setSettings({ cloudUrl: url, cloudToken: token }).then(r => {
    const s2 = settingsApplied(r);
    if (!s2) return;   // 写盘失败已如实提示（返工①），不再弹「已保存」
    hookCfg = { ...hookCfg, ...s2, feishu: s2.feishu || hookCfg.feishu };
    toast('已保存', url ? '云端节点：' + esc(url.slice(0, 44)) : '已清空云端节点', '☁');
    hydrateSettings();
  });
}
async function cloudTest() {
  const url = $('#cn-url').value.trim();
  const token = $('#cn-token').value;
  const log = $('#cn-log'); log.textContent = '正在连接…';
  const r = await window.reins.cloudTest(url, token);
  if (!r.ok) { log.textContent = '✗ ' + r.error; toast('连接失败', r.error, '⚠'); return; }
  log.textContent = '✓ 节点 ' + r.name + ' · 在线 · 可用 CLI：' + (r.agents && r.agents.length ? r.agents.join(', ') : '（未检测到）');
  toast('云端节点在线', r.name + (r.agents && r.agents.length ? ' · ' + r.agents.length + ' 个 CLI 可用' : ''), '☁');
}

async function setClient(key, val) {
  if (!window.reins) { toast('浏览器模式', '该设置仅在桌面客户端内生效', '⚠'); hydrateSettings(); return; }
  try {
    if (!settingsApplied(await window.reins.setSettings({ [key]: val }))) return;   // 写盘失败如实可见（返工①）
  } catch (e) { toast('保存失败', '主进程不可达', '⚠'); return; }
  toast('设置已保存',
    key === 'launchAtLogin' ? (val ? '将在系统登录后自动启动' : '已取消开机自启') : (val ? '关闭窗口时将驻留菜单栏' : '关闭窗口即退出客户端'),
    '⚙');
}

/* —— 执行引擎策略（REINS-128）：API 超时 / 重试上限 / 全局默认模型参数 —— */
function engineSave() {
  if (!window.reins) { toast('浏览器模式', '该设置仅在桌面客户端内生效', '⚠'); return; }
  const sec = Math.max(5, Number($('#se-timeout')?.value) || 120);
  const retries = Math.min(10, Math.max(0, Number($('#se-retries')?.value) || 0));
  const mp = {
    temperature: Number($('#se-temp')?.value),
    maxTokens: Math.round(Number($('#se-maxtok')?.value)),
    topP: Number($('#se-topp')?.value),
  };
  window.reins.setSettings({ apiTimeoutMs: sec * 1000, apiRetries: retries, modelParams: mp }).then(r => {
    const s2 = settingsApplied(r);
    if (!s2) return;
    hookCfg = { ...hookCfg, ...s2, feishu: s2.feishu || hookCfg.feishu };
    toast('执行策略已保存', `超时 ${Math.round((s2.apiTimeoutMs || 0) / 1000)}s · 重试 ${s2.apiRetries} 次 · temperature ${s2.modelParams?.temperature ?? '—'}`, '⚙');
  }).catch(() => toast('保存失败', '主进程不可达', '⚠'));
}

/* —— 自动化调度（REINS-128）：主进程时间轮的看板管理（新增/编辑/暂停/删除/立即运行） —— */
let schedCache = [];
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
function schedFreqLabel(sc) {
  if (!sc) return '';
  if (sc.freq === 'cron') return 'cron ' + (sc.cron || '');
  if (sc.freq === 'weekly') return '每周' + (WEEK_CN[sc.weekday ?? 1] || '一') + ' ' + (sc.time || '');
  return '每日 ' + (sc.time || '');
}
function fmtNextRun(ts) {
  if (!Number.isFinite(ts) || !ts) return '—';
  const d = new Date(ts);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return (d.toDateString() === new Date().toDateString() ? '今天 ' : (d.getMonth() + 1) + '月' + d.getDate() + '日 ') + hm;
}
async function hydrateSchedules() {
  const box = document.getElementById('sched-box'); if (!box || !window.reins) return;
  try { schedCache = (await window.reins.scheduleList()) || []; } catch (e) { schedCache = []; }
  box.innerHTML = schedCache.length ? schedCache.map(sc => {
    const off = sc.enabled === false;
    const tgt = sc.orgId && sc.spaceId
      ? (() => { const o = (state.orgs || []).find(x => x.id === sc.orgId); const s2 = o && (o.spaces || []).find(x => x.id === sc.spaceId); return o && s2 ? o.name + ' / ' + s2.name : '定向空间已不存在'; })()
      : '跟随当前空间';
    return `
    <div class="sched-row${off ? ' off' : ''}">
      <div class="sr-main">
        <b>${esc(sc.name)} <span class="sr-tag">${sc.kind === 'weekly' ? '周报' : sc.kind === 'digest' ? '每日摘要' : '站报'}</span>${off ? '<span class="sr-tag">已暂停</span>' : ''}</b>
        <div class="set-desc">${esc(schedFreqLabel(sc))} · 写入 ${esc(tgt)} · ${off ? '<b style="color:var(--ink-dim)">暂停中（不触发）</b>' : '下次 ' + esc(fmtNextRun(sc.nextRun))}${!off && schedOut(sc) !== 'none' ? ' · 推送到' + ({ feishu: '飞书', webhook: 'Webhook', both: '飞书 + Webhook' })[schedOut(sc)] : ''}${!off && sc.lastRun ? ' · 上次运行 ' + fmtRel(sc.lastRun) : ''}</div>
      </div>
      <button class="btn btn-o btn-sm" onclick="schedRunNow('${sc.id}')">立即运行</button>
      <button class="btn btn-o btn-sm" onclick="openSchedModal('${sc.id}')">编辑</button>
      <button class="btn btn-o btn-sm btn-danger-o" onclick="schedRemove('${sc.id}')">删除</button>
      <label class="switch" title="${off ? '启用' : '暂停（期间不触发）'}"><input type="checkbox" ${off ? '' : 'checked'} onchange="schedToggle('${sc.id}',this.checked)"><i></i></label>
    </div>`;
  }).join('') : '<div class="set-desc">还没有调度任务：新增后站报 / 周报 / 每日摘要将按计划自动生成。</div>';
}
async function schedToggle(id, on) {
  const r = await window.reins.scheduleToggle(id, on).catch(() => null);
  if (!r || !r.ok) { toast('操作失败', (r && r.errors && r.errors[0]) || '', '⚠'); hydrateSchedules(); return; }
  toast(on ? '已启用' : '已暂停', (r.schedule && r.schedule.name) || '', on ? '⏰' : '‖');
  hydrateSchedules();
}
async function schedRunNow(id) {
  const r = await window.reins.scheduleRunNow(id).catch(() => null);
  if (!r || !r.ok) { toast('触发失败', (r && r.errors && r.errors[0]) || '', '⚠'); return; }
  toast('已触发', '正在生成 ' + ((r.schedule && r.schedule.name) || ''), '⏰');
  hydrateSchedules();
}
async function schedRemove(id) {
  const sc = schedCache.find(x => x.id === id); if (!sc) return;
  const r = await window.reins.scheduleRemove(id).catch(() => null);
  if (!r || !r.ok) { toast('删除失败', (r && r.errors && r.errors[0]) || '', '⚠'); return; }
  toast('已删除调度', sc.name, '✕');
  hydrateSchedules();
}
function openSchedModal(id) {
  const sc = schedCache.find(x => x.id === id) || { kind: 'standup', name: '', freq: 'daily', time: '09:30', weekday: 5, cron: '0 9 * * 1-5', webhook: false };
  /* 空间定向：所有组织的所有空间平铺（org 名 / 空间名）；缺省「跟随当前空间」 */
  const spaceOpts = [{ v: '', l: '跟随当前空间（触发时所在空间）' }].concat(
    (state.orgs || []).flatMap(o => (o.spaces || []).map(s2 => ({ v: o.id + '/' + s2.id, l: o.name + ' / ' + s2.name }))));
  const spaceCur = sc.orgId && sc.spaceId ? sc.orgId + '/' + sc.spaceId : '';
  openModal(`<div class="modal-head"><h3>${id ? '编辑调度' : '新增调度'}</h3><span>站报 / 周报 / 每日摘要定时生成</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-2col">
        <div class="f-row"><label>调度名称</label><input type="text" id="sc-name" value="${esc(sc.name || '')}" placeholder="站报生成（留空按类型默认）"></div>
        <div class="f-row"><label>类型</label>${ds('sc-kind', [{ v: 'standup', l: '站报（每日站会材料）' }, { v: 'weekly', l: '周报（近 7 天汇总）' }, { v: 'digest', l: '每日摘要（吞吐 + 告警）' }], sc.kind)}</div>
      </div>
      <div class="f-2col">
        <div class="f-row"><label>频率</label>${ds('sc-freq', [{ v: 'daily', l: '每日' }, { v: 'weekly', l: '每周' }, { v: 'cron', l: 'cron 表达式' }], sc.freq, 'schedSyncForm()')}</div>
        <div class="f-row" id="sc-time-row"><label>时间（HH:MM）</label><input type="text" id="sc-time" value="${esc(sc.time || '09:30')}" placeholder="09:30"></div>
      </div>
      <div class="f-2col">
        <div class="f-row" id="sc-week-row"><label>星期（每周频率用）</label>${ds('sc-week', WEEK_CN.map((w, i) => ({ v: String(i), l: '周' + w })), String(sc.weekday ?? 5))}</div>
        <div class="f-row" id="sc-cron-row"><label>cron（分 时 日 月 周）</label><input type="text" id="sc-cron" value="${esc(sc.cron || '0 9 * * 1-5')}" placeholder="30 9 * * 1-5"></div>
      </div>
      <div class="f-2col">
        <div class="f-row"><label>报告写入空间</label>${ds('sc-space', spaceOpts, spaceCur)}</div>
        <div class="f-row"><label>生成后推送到</label>${ds('sc-out', [
          { v: 'none', l: '只写看板（不推送）' },
          { v: 'feishu', l: '飞书（自建应用 / 群机器人）' },
          { v: 'webhook', l: 'Webhook（「集成」页配置的地址）' },
          { v: 'both', l: '飞书 + Webhook' },
        ], schedOut(sc))}</div>
      </div>
      <div class="set-desc" style="margin-top:6px">报告定时写入所选空间看板（已完成状态，定向空间被删后回落当前空间并提示）；周报额外自动下载 Markdown。推送到飞书时以卡片发送（需在「集成」页启用飞书）。cron 为 5 字段标准表达式（分 时 日 月 周）。</div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="schedSave('${id || ''}')">保存</button></div>`);
  schedSyncForm();
}
/* 频率切换：仅露出当前频率需要的字段（隐藏行仍可取值，交主进程校验） */
function schedSyncForm() {
  const f = $('#sc-freq')?.value;
  const wr = $('#sc-week-row'), cr = $('#sc-cron-row'), tr = $('#sc-time-row');
  if (!wr) return;
  wr.style.display = f === 'weekly' ? '' : 'none';
  cr.style.display = f === 'cron' ? '' : 'none';
  if (tr) tr.style.display = f === 'cron' ? 'none' : '';
}
async function schedSave(id) {
  /* 编辑保留原启用态：单次 upsert 直接带真实 enabled（暂停中的编辑后仍是暂停），
     不再「先 true 再补 toggle」——两次 IPC 之间命中 30s tick 会误触发 */
  const editing = schedCache.find(x => x.id === id);
  const [po, ps] = ($('#sc-space')?.value || '').split('/');
  const sc = {
    id: id || undefined,
    kind: $('#sc-kind')?.value || 'standup',
    name: $('#sc-name')?.value.trim() || '',
    freq: $('#sc-freq')?.value || 'daily',
    time: $('#sc-time')?.value.trim() || '',
    weekday: Number($('#sc-week')?.value ?? 5),
    cron: $('#sc-cron')?.value.trim() || '',
    out: $('#sc-out')?.value || 'none',
    webhook: ['webhook', 'both'].includes($('#sc-out')?.value || ''),
    /* 空间定向：空 = 跟随当前空间（旧行为） */
    orgId: po || '',
    spaceId: ps || '',
    enabled: editing ? editing.enabled : true,
  };
  const r = await window.reins.scheduleUpsert(sc).catch(e => ({ ok: false, errors: [e.message] }));
  if (!r || !r.ok) { toast('保存失败', (r && r.errors && r.errors.join('；')) || '调度配置未通过校验', '⚠'); return; }
  closeModal();
  toast('调度已保存', ((r.schedule && r.schedule.name) || '') + ' · ' + schedFreqLabel(r.schedule) + ' · 下次 ' + fmtNextRun(r.schedule && r.schedule.nextRun), '⏰');
  hydrateSchedules();
}

/* —— 调度触发（REINS-128）：主进程时间轮到点通知 → 渲染层生成站报/周报/每日摘要写入看板 —— */
/* 推送去向：sc.out（none/webhook/feishu/both），未给时退回旧字段 sc.webhook 的布尔语义 */
function schedOut(sc) {
  if (sc && typeof sc.out === 'string') return sc.out;
  return sc && sc.webhook ? 'webhook' : 'none';
}
/* 调度空间定向：sc.orgId/spaceId 指定的组织与空间；缺省 = 跟随当前激活空间。
   定向指向的空间已不存在（被删/被移出）时回落当前空间，并如实标注 fallback 让触发方提示用户——
   报告绝不能静默写进一个用户没选的地方 */
function schedResolveSpace(sc) {
  if (sc && typeof sc.orgId === 'string' && sc.orgId && typeof sc.spaceId === 'string' && sc.spaceId) {
    const org = (state.orgs || []).find(o => o.id === sc.orgId);
    const sp = org && (org.spaces || []).find(s => s.id === sc.spaceId);
    if (org && sp) return { org, sp, fallback: false };
    return { org: O(), sp: S(), fallback: true };
  }
  return { org: O(), sp: S(), fallback: false };
}
function handleScheduleFire(info) {
  const sc = info && info.schedule; if (!sc) return;
  try {
    const tgt = schedResolveSpace(sc);
    const sp = tgt.sp, org = tgt.org;
    const digest = sc.kind === 'digest';
    const weekly = sc.kind === 'weekly';
    const text = digest ? buildDigest(sp, org) : weekly ? buildWeekly(sp, org) : buildStandup(sp);
    const d = new Date();
    const tag = info.manual ? '手动触发' : info.missed ? '补执行（休眠唤醒）' : '定时生成';
    const label = digest ? '每日摘要' : weekly ? '周报' : '站报';
    const title = label + ' · ' + sp.name + ' · ' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    const t = {
      id: 't' + sp.seq, key: 'REINS-' + sp.seq, title,
      type: 'writing', pri: 'P2', desc: tag + ' · ' + schedFreqLabel(sc),
      status: 'done', assignee: null, tags: [], pr: null, result: text, thread: [],
      attachPrompt: null, comments: [], repoRoot: '', runModel: '', modelParams: null,
      createdAt: now(), doneAt: now(),
    };
    sp.tasks.unshift(t); sp.seq++; sp.chart[6]++;
    sp.activity.unshift({ at: now(), icon: '⏰', text: title + '（' + schedFreqLabel(sc) + '）' });
    sp.activity = sp.activity.slice(0, 40);
    toast(label + '已自动生成', t.key + ' 已写入看板 · 空间「' + sp.name + '」' + (tgt.fallback ? '（注意：原定向空间已不存在，回落到当前空间）' : ''), tgt.fallback ? '⚠' : '⏰');
    if (weekly) downloadReportMd(title, text);
    const out = schedOut(sc);
    const event = digest ? 'report.digest' : weekly ? 'report.weekly' : 'report.standup';
    if ((out === 'webhook' || out === 'both') && window.reins) {
      /* 复用现有 webhook 通道，内容与手动生成的报告一致（地址是飞书机器人时主进程自动转卡片） */
      window.reins.webhookSend({ event, at: new Date().toISOString(), space: sp.name, schedule: sc.name, report: text })
        .then(r => { if (r && !r.ok) toast('Webhook 推送失败', r.error || ('HTTP ' + r.status), '⚠'); }).catch(() => { });
    }
    if ((out === 'feishu' || out === 'both') && window.reins?.feishuReport) {
      window.reins.feishuReport({ title, text, meta: sc.name + ' · ' + schedFreqLabel(sc) + ' · ' + tag })
        .then(r => { if (r && !r.ok && !r.skipped) toast('飞书推送失败', r.error || '', '⚠'); }).catch(() => { });
    }
    save(); refreshViews();
  } catch (e) { console.error('[schedule] 报告生成失败（不中断）', e); }
}
/* 每日摘要：一眼看清今天的吞吐、在途、验收队列与需要人介入的告警（失败/超时/阻塞） */
function buildDigest(sp, org) {
  sp = sp || S(); org = org || O();   // 调度空间定向：默认当前空间与组织
  const d = new Date();
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const dayStart = t0.getTime();
  const tasks = sp.tasks;
  const doneToday = tasks.filter(t => t.doneAt && t.doneAt >= dayStart);
  const doing = tasks.filter(t => t.status === 'doing');
  const review = tasks.filter(t => t.status === 'review');
  const todo = tasks.filter(t => t.status === 'todo');
  const who = t => t.assignee ? (t.assignee.kind === 'agent' ? '◆ ' + t.assignee.name : t.assignee.name) : '未指派';
  /* 告警口径：时间线里最近一次「执行失败 / 超时」且之后没有成功归档的任务 */
  const failed = tasks.filter(t => t.status !== 'done' && (t.history || []).some(h => /失败|超时/.test(h.text || '')));
  const pipelinePaused = tasks.filter(t => t.pipeline?.on && t.pipeline.status === 'paused');
  const tokensToday = org.agents.reduce((n, a) => n + (a.tokens || 0), 0);
  return [
    `# 每日摘要 · ${d.getMonth() + 1}月${d.getDate()}日`,
    `> 空间「${sp.name}」· 由自动化例程生成 · Reins`,
    ``,
    `## 今日完成（${doneToday.length}）`,
    ...(doneToday.length ? doneToday.slice(0, 10).map(t => `- ${t.key} ${t.title} — ${who(t)}${t.pr ? ' · ' + t.pr : ''}`) : ['- 无']),
    ``,
    `## 在途（${doing.length}）`,
    ...(doing.length ? doing.slice(0, 10).map(t => `- ${t.key} ${t.title} — ${who(t)}${runs[t.id] ? ' · ' + runPct(t.id) + '%' : ''}`) : ['- 无']),
    ``,
    `## 待验收（${review.length}）`,
    ...(review.length ? review.slice(0, 10).map(t => `- ${t.key} ${t.title} — ${who(t)}`) : ['- 无']),
    ``,
    `## 待处理（${todo.length}）`,
    ...(todo.length ? todo.slice(0, 10).map(t => `- [${t.pri}] ${t.key} ${t.title}`) : ['- 无']),
    ``,
    `## 需要关注`,
    ...(failed.length ? failed.slice(0, 8).map(t => `- ⚠ ${t.key} ${t.title} — 最近执行失败/超时`) : []),
    ...(pipelinePaused.length ? pipelinePaused.slice(0, 8).map(t => `- ⏸ ${t.key} ${t.title} — 流水线已暂停，可从断点继续`) : []),
    ...(!failed.length && !pipelinePaused.length ? ['- 无异常'] : []),
    ``,
    `## Agent 台账`,
    ...(org.agents.length ? org.agents.map(a => `- ${a.name}：累计完成 ${a.done || 0} 项 · tokens ${a.tokens >= 1e6 ? (a.tokens / 1e6).toFixed(1) + 'M' : Math.round((a.tokens || 0) / 1e3) + 'K'}`) : ['- 尚未接入 Agent']),
    ``,
    `> 累计 tokens ${tokensToday >= 1e6 ? (tokensToday / 1e6).toFixed(1) + 'M' : Math.round(tokensToday / 1e3) + 'K'}`,
  ].join('\n');
}
function downloadReportMd(title, text) {
  const d = new Date();
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = String(title).replace(/[\\/:*?"<>|\s]+/g, '-') + '-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.md';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* —— 模型价格表（P1 成本估算）：内置参考价可编辑，用户覆盖写进 settings.modelPrices ——
   只列「内置 + 已覆盖 + 当前在用模型」三类，避免把整张表铺成几十行输入框；
   留空某一行 = 删除该覆盖（回落到内置价或未定价）。 */
let priceCache = null;
async function hydratePrices() {
  const box = document.getElementById('price-box'); if (!box || !window.reins) return;
  let t = null;
  try { t = await window.reins.priceTable(); } catch (e) { t = null; }
  if (!t) { box.innerHTML = '<span class="set-desc">价格表暂不可用。</span>'; return; }
  priceCache = t;
  const ov = t.overrides || {};
  /* 当前在用的模型优先列出：用户改价十有八九是为了它 */
  const inUse = O().agents.map(a => a.model).filter(Boolean);
  const names = [...new Set([...inUse, ...Object.keys(ov), ...Object.keys(t.defaults || {})])];
  const row = name => {
    const cur = ov[name] || null;
    const def = (t.defaults || {})[name];
    const src = cur ? '自定义' : def ? '内置' : '未定价';
    return `<div class="price-row">
      <span class="pr-name" title="${esc(name)}">${esc(name)}${inUse.includes(name) ? '<i class="pr-use">在用</i>' : ''}</span>
      <input type="number" min="0" step="0.01" class="pr-in" data-model="${esc(name)}" value="${cur ? esc(String(cur.in)) : (def ? esc(String(def.in)) : '')}" placeholder="输入价">
      <input type="number" min="0" step="0.01" class="pr-out" data-model="${esc(name)}" value="${cur ? esc(String(cur.out)) : (def ? esc(String(def.out)) : '')}" placeholder="输出价">
      <span class="pr-src">${src}</span>
    </div>`;
  };
  box.innerHTML = `<div class="price-head"><span>模型</span><span>输入 元/1M</span><span>输出 元/1M</span><span>来源</span></div>
    ${names.map(row).join('')}
    <div class="price-add">
      <input type="text" id="price-new-model" placeholder="补充模型名（如 glm-4.6）">
      <input type="number" id="price-new-in" min="0" step="0.01" placeholder="输入价">
      <input type="number" id="price-new-out" min="0" step="0.01" placeholder="输出价">
      <button class="btn btn-o btn-sm" onclick="priceAddRow()">添加</button>
      <button class="btn btn-p btn-sm" style="margin-left:auto" onclick="priceSave()">保存价格表</button>
    </div>`;
}
/* 新增一行：把模型名与单价插进表格（保存时才落盘） */
function priceAddRow() {
  const name = ($('#price-new-model')?.value || '').trim();
  const i = Number($('#price-new-in')?.value), o = Number($('#price-new-out')?.value);
  if (!name) { toast('缺少模型名', '例如 glm-4.6 或 deepseek-chat', '⚠'); return; }
  if (!Number.isFinite(i) || i < 0 || !Number.isFinite(o) || o < 0) { toast('单价无效', '填非负数字（元/1M tokens）', '⚠'); return; }
  const box = document.getElementById('price-box');
  const head = box.querySelector('.price-head');
  const div = document.createElement('div');
  div.className = 'price-row';
  div.innerHTML = `<span class="pr-name" title=""><i class="pr-use">在用</i></span>
    <input type="number" min="0" step="0.01" class="pr-in" value="${i}">
    <input type="number" min="0" step="0.01" class="pr-out" value="${o}">
    <span class="pr-src">自定义</span>`;
  div.querySelector('.pr-name').title = name;
  div.querySelector('.pr-name').insertAdjacentHTML('afterbegin', esc(name));
  div.querySelector('.pr-in').dataset.model = name;
  div.querySelector('.pr-out').dataset.model = name;
  head.after(div);
  $('#price-new-model').value = ''; $('#price-new-in').value = ''; $('#price-new-out').value = '';
  toast('已加入', name + ' · 点「保存价格表」生效', '＋');
}
/* 保存：收集所有行，输入/输出都为数字且至少填了一项才写入覆盖表 */
function priceSave() {
  const ov = {};
  document.querySelectorAll('#price-box .price-row').forEach(r => {
    const model = r.querySelector('.pr-in')?.dataset.model || '';
    const iRaw = r.querySelector('.pr-in')?.value, oRaw = r.querySelector('.pr-out')?.value;
    if (!model) return;
    const i = iRaw === '' ? NaN : Number(iRaw), o = oRaw === '' ? NaN : Number(oRaw);
    /* 两个都空 = 用户想删除这条覆盖（回落内置/未定价）；只填一个视为填错，跳过并提示 */
    if (iRaw === '' && oRaw === '') return;
    if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) { toast('已跳过 ' + model, '输入/输出价需同时填写非负数字', '⚠'); return; }
    ov[model] = { in: i, out: o };
  });
  window.reins.setSettings({ modelPrices: ov }).then(r => {
    const s = settingsApplied(r);
    if (!s) return;
    hookCfg = { ...hookCfg, ...s };
    toast('价格表已保存', Object.keys(ov).length ? Object.keys(ov).length + ' 个模型单价已生效' : '已清空覆盖，全部回落到内置参考价', '¥');
    hydratePrices();
    refreshViews();
  });
}

/* —— 密钥安全存储状态（REINS-128）：safeStorage 可用性 / 明文盘点 / 降级确认 —— */
async function hydrateSec() {
  const box = document.getElementById('sec-box'); if (!box || !window.reins) return;
  let st = null;
  try { st = await window.reins.keyStatus(); } catch (e) { }
  if (!st) { box.innerHTML = '<div class="set-desc">密钥存储状态暂不可用。</div>'; return; }
  const c = st.stateKeys || {};
  const backendLine = st.available
    ? `<div style="display:flex;align-items:center;gap:8px"><span class="status-pill idle">系统加密已启用</span><span class="set-desc">密钥经系统钥匙串（${esc(st.backend === 'safeStorage' ? 'macOS Keychain / Windows DPAPI / Linux libsecret' : st.backend)}）加密后落盘，磁盘上不存明文。</span></div>`
    : `<div style="display:flex;align-items:center;gap:8px"><span class="status-pill offline">加密后端不可用</span><span class="set-desc">当前环境 safeStorage 不可用（常见于 Linux 缺 libsecret）。</span></div>`;
  const counts = `<div class="set-desc" style="margin-top:6px">密钥盘点：已加密 ${c.sealed || 0} 个 · 明文 ${c.plaintext || 0} 个${c.locked ? ` · <b style="color:#c05656">解锁失败 ${c.locked} 个（系统钥匙串变更？重配一次 Key 即恢复）</b>` : ''} · 存储策略：${st.policy === 'plain' ? '明文（用户选择）' : '自动（可用即加密）'}</div>`;
  let extra = '';
  if (st.warning) {
    extra = `<div class="sec-warn"><b>${ic('triangle-alert')} 安全警示</b><div>系统加密不可用，且磁盘上存在明文密钥。可在本机配置对应钥匙串服务后重启，或明确选择明文存储（风险自担）。</div>
      <div style="margin-top:8px"><button class="btn btn-o btn-sm" onclick="confirmSecPlain()">我已知晓风险，使用明文存储</button></div></div>`;
  } else if (st.policy === 'plain' && st.available) {
    extra = `<div class="set-desc" style="margin-top:6px">当前策略为明文存储；<span class="lnk" onclick="secRestoreAuto()">恢复自动加密</span>（下次保存/重启时明文密钥自动迁移）。</div>`;
  }
  box.innerHTML = backendLine + counts + extra;
}
function confirmSecPlain() {
  openModal(`<div class="modal-head"><h3>使用明文存储</h3><span>安全确认</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim);line-height:1.7">确认后 API Key 与令牌将以<b>明文</b>写入本机数据文件，任何能读取该文件的程序或人员都可获得它们。仅建议在受控的私人设备上选择此方式。</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="secSetPlain()">确认使用明文</button></div>`);
}
async function secSetPlain() {
  const r = await window.reins.setSettings({ keyStorage: 'plain' }).catch(() => null);
  const s2 = settingsApplied(r);
  closeModal();
  if (!s2) return;
  toast('已切换为明文存储', '后续密钥不再加密落盘', '⚠');
  hydrateSec();
}
async function secRestoreAuto() {
  const r = await window.reins.setSettings({ keyStorage: 'auto' }).catch(() => null);
  const s2 = settingsApplied(r);
  if (!s2) return;
  toast('已恢复自动加密', '下次保存 / 重启时明文密钥将自动迁移为加密存储', '🔒');
  hydrateSec();
}

/* —— Git 远程（REINS-128）：托管平台 PAT（推送走 git 凭据，PR 走令牌） —— */
function gitTokensSave() {
  if (!window.reins) { toast('浏览器模式', '该设置仅在桌面客户端内生效', '⚠'); return; }
  /* settings:set 对 gitTokens 整键替换：留空成员若现值是未解锁密文须原样带回，
     否则改另一个令牌会把这边的密文副本静默抹掉（同 Agent 表单"空值不抹密文"语义） */
  const prev = hookCfg.gitTokens || {};
  const tokens = { github: secretPick($('#gt-github')?.value, prev.github), gitee: secretPick($('#gt-gitee')?.value, prev.gitee) };
  window.reins.setSettings({ gitTokens: tokens }).then(r => {
    const s2 = settingsApplied(r);
    if (!s2) return;
    hookCfg = { ...hookCfg, ...s2, feishu: s2.feishu || hookCfg.feishu };
    toast('令牌已保存', 'GitHub / Gitee PAT 已更新（仅本机）', '⚙');
  }).catch(() => toast('保存失败', '主进程不可达', '⚠'));
}
/* PAT 探活：输入框留空且现值非密文时退回已保存值——没保存过的新令牌也能先测 */
async function gitPatTest(provider) {
  if (!window.reins?.gitPatTest) { toast('浏览器模式', '该测试仅在桌面客户端内可用', '⚠'); return; }
  const box = $('#gt-test');
  const input = $('#gt-' + provider)?.value.trim() || secretOf((hookCfg.gitTokens || {})[provider]);
  if (!input) { if (box) box.innerHTML = '<span style="color:#c05656">请先填写' + (provider === 'github' ? ' GitHub' : ' Gitee') + ' 令牌</span>'; return; }
  if (box) box.textContent = '正在探活…';
  const r = await window.reins.gitPatTest({ provider, token: input }).catch(e => ({ ok: false, message: e.message }));
  if (box) box.innerHTML = r.ok
    ? '<span style="color:#2f7d4e">✓ ' + esc(r.message) + '</span>'
    : '<span style="color:#c05656">✗ ' + esc(r.message) + '</span>';
}

/* 导出备份：**必须把外置正文内联回来**。
   大文本外置后 state 里只有 {__text,ref}，而正文文件在 userData/deliveries/text/ 下——
   备份文件（单个 .json）不包含这个目录。若不内联，导出再导入就是"交付内容全丢、只剩 400 字摘要"，
   而且用户会以为备份是完整的。导入侧同时兼容两种形态（见 importData）。 */
async function exportData() {
  const btn = document.querySelector('[data-export-btn]');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在打包正文…'; }
  let snapshot;
  try {
    snapshot = await inlineAllText(state);
  } catch (e) {
    snapshot = JSON.parse(JSON.stringify(state));   // 取正文失败也别阻断导出：至少结构可用
    toast('部分正文未能打包', '备份仍会导出，但外置正文可能缺失：' + e.message, '⚠');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'reins-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(a.href);
  toast('已导出', '备份已包含全部交付正文（可换机导入）', '⇩');
}
/* 导入兜底：把引用降级成 preview 字符串（返回处理处数）。
   只用在「用户导入的是裸 state 文件、正文没跟着来」的场景——宁可显示摘要，
   也不能让界面拿到指向不存在文件的引用对象 */
function liftTextRefs(st) {
  let n = 0;
  const fix = (obj, field) => {
    const v = obj && obj[field];
    if (!isTextRef(v)) return;
    obj[field] = String(v.preview || '');
    n++;
  };
  for (const org of (st.orgs || [])) {
    for (const sp of (org.spaces || [])) {
      for (const t of (sp.tasks || [])) {
        fix(t, 'result');
        if (Array.isArray(t.thread)) t.thread.forEach(m => fix(m, 'content'));
        const p = t.pipeline;
        if (p && Array.isArray(p.stages)) p.stages.forEach(x => fix(x, 'result'));
        if (p && p.reworkCtx) { fix(p.reworkCtx, 'qaReport'); fix(p.reworkCtx, 'feedback'); }
        if (p && p.gate) fix(p.gate, 'evidence');
      }
    }
  }
  return n;
}

/* 孤儿交付文件回收：把「当前所有任务号」作为保留清单交主进程，其余目录删除。
   放在设置页是为了让用户能自己处理历史残留（导入旧档、手工删任务都会留下） */
async function runDeliveryGC() {
  if (!window.reins?.deliveryGC) { toast('不可用', '请在桌面客户端中操作', '⚠'); return; }
  /* 保留清单按「全部组织」取，不只是当前组织：否则切到别的组织时会把它们的交付目录当孤儿删掉 */
  const keep = [...new Set((state.orgs || []).flatMap(o => (o.spaces || []).flatMap(sp => (sp.tasks || []).map(t => t.key))))];
  const r = await window.reins.deliveryGC(keep).catch(e => ({ ok: false, error: e.message }));
  const desc = document.getElementById('gc-desc');
  if (!r || !r.ok) { toast('回收失败', (r && r.error) || '', '⚠'); return; }
  const mb = (r.bytes / 1024 / 1024).toFixed(1);
  const msg = r.removed ? `已清理 ${r.removed} 个孤儿目录，释放 ${mb}MB` : '没有需要清理的孤儿目录';
  if (desc) desc.innerHTML = esc(msg) + (r.errors && r.errors.length ? `（${r.errors.length} 个失败）` : '');
  toast(r.removed ? '已回收' : '无需回收', msg, '🗑');
  runIntegrityCheck(true, { silent: true });
}

/* —— 数据自检（一致性体检）——
   外置带来的新失败模式是「state 还在、正文文件没了」：不报错，只静默降级成 400 字摘要。
   启动后跑一次，只在发现问题时打扰用户；设置页有面板可随时重扫并处置。 */
let integrityReport = null;
async function runIntegrityCheck(force, opts?) {
  const o = opts || {};
  if (!window.reins?.integrityCheck) return null;
  let r = null;
  try { r = await window.reins.integrityCheck(!!force); } catch (e) { return null; }
  if (!r) return null;
  integrityReport = r;
  renderIntegrityPanel();
  if (!o.silent) return r;
  /* 静默模式：只有「正文缺失」这种会造成数据不可逆的才主动弹，孤儿目录等放在设置页里让用户自己看 */
  const missing = (r.refs && r.refs.missing) || [];
  if (missing.length) {
    toast('数据自检发现正文缺失', missing.length + ' 处内容只剩摘要（前 400 字），点「设置 → 数据自检」查看详情', '⚠');
  }
  return r;
}
/* 设置页面板：健康时一行绿字，有问题时按类型列出并给处置入口 */
function renderIntegrityPanel() {
  const box = document.getElementById('integrity-box');
  if (!box) return;
  const r = integrityReport;
  if (!r) { box.innerHTML = '<div class="set-desc">尚未检查。</div>'; return; }
  const miss = (r.refs && r.refs.missing) || [];
  const orph = (r.orphans && r.orphans.dirs) || [];
  const mb = ((Number(r.totalBytes) || 0) / 1024 / 1024).toFixed(1);
  const head = `<div class="ig-head ${r.healthy && !orph.length ? 'ok' : 'warn'}">
      ${r.healthy && !orph.length ? ic('circle-check') : ic('triangle-alert')}
      <b>${esc(r.healthy ? (orph.length ? '正文完好，有可回收文件' : '数据自检通过') : '发现 ' + miss.length + ' 处正文缺失')}</b>
      <span class="ig-meta">${(r.refs && r.refs.total) || 0} 处正文引用 · 占用 ${mb}MB · ${fmtRel(r.at)}</span>
    </div>`;
  const missHtml = miss.length ? `<div class="ig-sec">
      <div class="ig-title">正文缺失（${miss.length}）</div>
      <div class="set-desc">这些内容只剩前 400 字摘要，导出/下载会拿到不完整内容。常见原因：手工删过 deliveries、只拷了 reins-data.json 没带正文库。</div>
      <div class="ig-list">${miss.slice(0, 12).map(m => `<div class="ig-item"><span class="ig-where">${esc(m.where || m.ref)}</span><span class="ig-ref">${esc(m.ref)}</span></div>`).join('')}
        ${miss.length > 12 ? `<div class="ig-item"><span class="set-desc">…另有 ${miss.length - 12} 处</span></div>` : ''}</div>
      <div class="ig-hint">处置：若之前导出过备份，用「导入数据」恢复；否则这部分内容无法自动找回。</div>
    </div>` : '';
  const orphHtml = orph.length ? `<div class="ig-sec">
      <div class="ig-title">孤儿交付目录（${orph.length}，${((r.orphans.bytes || 0) / 1024 / 1024).toFixed(1)}MB）</div>
      <div class="set-desc">任务已删除或来自旧存档，可安全回收。</div>
      <div class="ig-list">${orph.slice(0, 12).map(n => `<div class="ig-item"><span class="ig-where">${esc(n)}</span></div>`).join('')}</div>
      <div style="margin-top:8px"><button class="btn btn-o btn-sm" onclick="runDeliveryGC()">回收这 ${orph.length} 个目录</button></div>
    </div>` : '';
  box.innerHTML = head + missHtml + orphHtml +
    `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-o btn-sm" onclick="runIntegrityCheck(true).then(r=>r&&toast('自检完成', integritySummary(r),'✓'))">重新检查</button>
      <button class="btn btn-o btn-sm" data-export-btn onclick="exportData()">导出备份（含正文）</button>
      ${window.reins?.textPurge ? '<button class="btn btn-o btn-sm btn-danger-o" onclick="purgeArchivedText()">清理已归档任务正文…</button>' : ''}
    </div>`;
}
/* —— 归档正文清理：done 任务的外置正文显式降级为摘要（purged 标记），文件删除 ——
   只动已归档任务；进行中/待验收任务的正文保持完整（打回重跑还要用全文）。
   降级后体检不再要求文件存在（有意降级 ≠ 数据丢失），导出会拿到摘要并如实提示 */
function collectPurgeTargets() {
  const hits = [];
  const visit = (holder, field, taskKey) => {
    const v = holder && holder[field];
    if (isTextRef(v) && v.purged !== true) hits.push({ holder, field, bytes: Number(v.bytes) || 0, taskKey });
  };
  for (const org of (state.orgs || [])) for (const sp of ((org && org.spaces) || [])) for (const t of ((sp && sp.tasks) || [])) {
    if (!t || typeof t !== 'object' || t.status !== 'done') continue;
    visit(t, 'result', t.key);
    if (Array.isArray(t.thread)) t.thread.forEach(m => visit(m, 'content', t.key));
    const p = t.pipeline;
    if (p && Array.isArray(p.stages)) p.stages.forEach(s => visit(s, 'result', t.key));
    if (p && p.reworkCtx) { visit(p.reworkCtx, 'qaReport', t.key); visit(p.reworkCtx, 'feedback', t.key); }
    if (p && p.gate) visit(p.gate, 'evidence', t.key);
  }
  return hits;
}
function purgeArchivedText() {
  const hits = collectPurgeTargets();
  if (!hits.length) { toast('无可清理正文', '已归档任务没有外置的完整正文', ''); return; }
  const bytes = hits.reduce((n, h) => n + h.bytes, 0);
  const keys = [...new Set(hits.map(h => h.taskKey))];
  openModal(`<div class="modal-head"><h3>清理已归档任务正文</h3><span>不可恢复</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="set-desc">将清理 <b>${keys.length}</b> 个已归档任务的 <b>${hits.length}</b> 处外置正文（约 ${(bytes / 1024).toFixed(0)}KB）：</div>
      <div class="set-desc" style="margin-top:6px;color:#c05656">${ic('triangle-alert')} 正文文件将被删除，引用降级为前 400 字摘要，<b>不可恢复</b>。需要完整内容请先「导出备份（含正文）」。</div>
      <div class="set-desc" style="margin-top:6px">进行中 / 待验收任务的正文不受影响；清理后自检不再把这些位置计为占用。</div>
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="doPurgeArchivedText()">确认清理</button></div>`);
}
async function doPurgeArchivedText() {
  const hits = collectPurgeTargets();
  let freed = 0;
  for (const h of hits) {
    const v = h.holder[h.field];
    h.holder[h.field] = { __text: true, ref: v.ref, bytes: v.bytes, preview: String(v.preview || ''), purged: true, purgedAt: now() };
    freed += h.bytes;
    window.reins.textPurge(v.ref).catch(() => { });   // 删文件失败不影响降级（文件残留可再清，数据不丢）
  }
  save(); closeModal();
  toast('已清理归档正文', hits.length + ' 处已降级为摘要 · 释放约 ' + (freed / 1024).toFixed(0) + 'KB', '');
  runIntegrityCheck(true);
}
function integritySummary(r) {
  const miss = ((r.refs && r.refs.missing) || []).length;
  const orph = ((r.orphans && r.orphans.dirs) || []).length;
  if (!miss && !orph) return ((r.refs && r.refs.total) || 0) + ' 处正文完好';
  return [miss ? miss + ' 处正文缺失' : '', orph ? orph + ' 个孤儿目录' : ''].filter(Boolean).join(' · ');
}

/* 深拷贝 state 并把所有引用换成全文；单个正文缺失时保留 preview（不抛错、不阻断导出） */
async function inlineAllText(st) {
  const clone = JSON.parse(JSON.stringify(st));
  const jobs = [];
  const walkStr = (obj, field) => {
    const v = obj && obj[field];
    if (!isTextRef(v)) return;
    jobs.push(textFull(v).then(full => { obj[field] = full || String(v.preview || ''); }));
  };
  for (const org of (clone.orgs || [])) {
    for (const sp of (org.spaces || [])) {
      for (const t of (sp.tasks || [])) {
        walkStr(t, 'result');
        if (Array.isArray(t.thread)) t.thread.forEach(m => walkStr(m, 'content'));
        const p = t.pipeline;
        if (p && Array.isArray(p.stages)) p.stages.forEach(x => walkStr(x, 'result'));
        if (p && p.reworkCtx) { walkStr(p.reworkCtx, 'qaReport'); walkStr(p.reworkCtx, 'feedback'); }
        if (p && p.gate) walkStr(p.gate, 'evidence');
      }
    }
  }
  await Promise.all(jobs);
  return clone;
}
function importData(input) {
  const file = input.files[0]; if (!file) return;
  const reader: any = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      let n = null;
      if (Array.isArray(data.orgs) && data.orgs.length) n = normalizeState(data);
      else if (Array.isArray(data.spaces) && data.spaces.length) n = normalizeState(toV3(data, '导入的组织'));
      if (!n) throw new Error('格式不符（需要 orgs 或 spaces 条目）');
      /* 兼容两种备份形态：旧备份正文是字符串（原样保留）；新备份若仍含外置引用
         （例如用户直接拷了 reins-data.json），把 preview 提升为正文，避免导入后
         正文指向不存在的 text/ 路径而显示空白。真正的完整备份由 exportData 内联产出 */
      const lifted = liftTextRefs(n);
      if (lifted > 0) {
        toast('备份含外置正文引用', lifted + ' 处正文只有摘要（完整备份请用「导出」重新生成）', '⚠');
      }
      if (!confirm('导入将覆盖当前全部数据，继续？')) return;
      if (window.reins) await window.reins.stateSave(n, true);
      else localStorage.setItem(STORE_KEY, JSON.stringify(n));
      location.reload();
    } catch (e) { toast('导入失败', esc(e.message), '⚠'); }
  };
  reader.readAsText(file);
}
function confirmReset() {
  openModal(`<div class="modal-head"><h3>清空数据</h3><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将清空全部任务、空间与 Agent 配置（含密钥），恢复空白工作区；客户端设置与云端节点配置保留。此操作不可撤销。</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="doReset()">确认重置</button></div>`);
}
async function doReset() {
  if (window.reins) { try { await window.reins.stateSave({ reset: true }, true); } catch (e) { } }
  else localStorage.removeItem(STORE_KEY);
  location.reload();
}

/* ============ 通知 & 动态 ============ */
function toast(title, sub = '', icon = '✓') {
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = `<span class="ic">${gic(icon)}</span><div><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 420); }, 3800);
}
function th(task, icon, text) { task.history = task.history || []; task.history.push({ at: now(), icon, text }); }
function addActivity(icon, text) { S().activity.unshift({ at: now(), icon, text }); S().activity = S().activity.slice(0, 40); save(); renderBell(); }

/* ============ 收件箱（跨空间聚合通知中心） ============ */
let inboxFilter = 'all';
function inboxItems() {
  // 聚合当前组织下全部空间的活动，携带空间与任务线索
  const items = [];
  for (const sp of O().spaces) {
    for (const a of (sp.activity || [])) {
      const m = a.text.match(/(REINS-\d+)/);
      const taskId = m ? (sp.tasks.find(t => t.key === m[1]) || {}).id : null;
      let kind = 'all';
      if (/交付|完成|归档/.test(a.text)) kind = 'done';
      else if (/开始执行|恢复执行|正在/.test(a.text)) kind = 'run';
      else if (/打回/.test(a.text)) kind = 'reject';
      else if (/分诊|创建/.test(a.text)) kind = 'triage';
      items.push({ ...a, spaceId: sp.id, spaceName: sp.name, taskId, kind });
    }
  }
  return items.sort((x, y) => y.at - x.at).slice(0, 30);
}
function unreadCount() { return inboxItems().filter(a => a.at > (S().readAt || 0)).length; }
function renderBell() {
  const badge: any = document.getElementById('bell-badge'); if (!badge) return;
  const n = unreadCount();
  badge.textContent = n > 99 ? '99+' : n;
  badge.style.display = n ? '' : 'none';
  window.reins?.traySetBadge?.(n); // 菜单栏托盘图标同步未读角标
}

/* 托盘角标绘制：图形 + 右侧纯数字（无底衬），整图为单色模板——深色菜单栏渲染为纯白，浅色自动变黑 */
function trayBadgeDataUrl(n) {
  const img: any = document.getElementById('tray-base-src');
  if (!img || !img.complete || !img.naturalWidth) return null;
  const x0: any = (document.getElementById('tray-badge-canvas') as any).getContext('2d');
  const font = 'bold 27px -apple-system,Helvetica';
  x0.font = font;
  const tw = n > 0 ? Math.ceil(x0.measureText(String(Math.min(n, 99))).width) : 0;
  const H = 36;
  const W = 34 + (n > 0 ? 4 + tw : 0);
  const c: any = document.getElementById('tray-badge-canvas');
  c.width = W; c.height = H;              // 重设尺寸会清空画布状态，字体需重设
  const x = c.getContext('2d');
  // 素材可见区 66%：画 40px → 可见 ≈26px@2x（23 偏小 / 29 偏大 之间的定稿值）
  x.drawImage(img, -2, -2, 40, 40);
  if (n > 0) {
    x.fillStyle = '#fff';                 // 模板图只取 alpha，此处填白色仅作占位
    x.textAlign = 'left'; x.textBaseline = 'middle';
    x.font = font;
    x.fillText(String(Math.min(n, 99)), 34, 20);
  }
  return { url: c.toDataURL(), w: W, h: H };
}
const INBOX_FILTERS = [['all', '全部'], ['done', '交付完成'], ['run', '执行中'], ['reject', '打回'], ['triage', '创建/分诊']];
function toggleNotif(e) {
  e && e.stopPropagation();
  const pop = document.getElementById('notif-pop');
  pop.classList.toggle('show');
  if (pop.classList.contains('show')) renderInbox();
}
function renderInbox() {
  const pop = document.getElementById('notif-pop');
  const items = inboxItems().filter(i => inboxFilter === 'all' || i.kind === inboxFilter);
  const isUnread = i => i.at > (S().readAt || 0);
  const GLYPH = { done: '✓', run: '▶', reject: '↩', triage: '✦' }; // 分类单色图标，其余保留原始 emoji
  pop.innerHTML = `
    <div class="ibx-head">
      <div class="ibx-title"><b>收件箱</b><span>来自全部空间的动态</span></div>
      <button class="ibx-mark" onclick="markAllRead()">全部已读</button>
    </div>
    <div class="ibx-filters">${INBOX_FILTERS.map(([k, l]) => `<button class="${inboxFilter === k ? 'on' : ''}" onclick="inboxFilter='${k}';renderInbox()">${l}</button>`).join('')}</div>
    <div class="ibx-list">${items.map(i => `
      <div class="ntf-item k-${i.kind === 'all' ? 'misc' : i.kind} ${isUnread(i) ? 'unread' : ''} ${i.taskId ? 'lnk' : ''}" ${i.taskId ? `onclick="openInboxTask('${i.spaceId}','${i.taskId}')"` : ''}>
        <span class="fic">${gic(GLYPH[i.kind] || i.icon)}</span>
        <div class="ntf-body"><div class="ntf-text">${esc(i.text)}</div><div class="ft">${esc(i.spaceName)} · ${fmtRel(i.at)}</div></div>
        ${i.taskId ? '<span class="ntf-go">›</span>' : ''}
      </div>`).join('') || '<div class="ntf-empty">暂无通知</div>'}</div>`;
  S().readAt = now(); save(); renderBell();
}
function openInboxTask(spaceId, taskId) {
  document.getElementById('notif-pop')?.classList.remove('show');
  if (state.activeSpaceId !== spaceId) { state.activeSpaceId = spaceId; save(); renderSpaceButton(); }
  switchView('kanban');
  openTask(taskId);
}
function markAllRead() {
  for (const sp of O().spaces) sp.readAt = now();
  save(); renderBell(); renderInbox();
  toast('收件箱', '全部标记为已读', '✓');
}

/* ============ 初始化 ============ */
let bootTs = Date.now();
function updateNodePill() {
  const el = document.getElementById('node-uptime'); if (!el) return;
  const m = Math.max(0, Math.round((Date.now() - bootTs) / 60000));
  // 胶囊文案有宽度上界（去掉「已运行」前缀 + 紧凑单位）；完整时长放悬停 title
  let s, full;
  if (m < 1) { s = '刚刚启动'; full = '刚刚启动'; }
  else if (m < 60) { s = `${m} 分钟`; full = `已运行 ${m} 分钟`; }
  else if (m < 1440) { s = `${Math.floor(m / 60)} 时 ${m % 60} 分`; full = `已运行 ${Math.floor(m / 60)} 小时 ${m % 60} 分`; }
  else if (m < 14400) { s = `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 时`; full = `已运行 ${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`; }
  else { s = `${Math.floor(m / 1440)} 天`; full = `已运行 ${Math.floor(m / 1440)} 天`; }
  el.textContent = s;
  document.querySelector('.node-pill')?.setAttribute('title', '本机节点在线 · ' + full + '\n桌面客户端保持在线，Agent 才能继续接收并执行任务');
  const nv = document.getElementById('nv-uptime'); if (nv) nv.textContent = s; // 节点视图里的镜像同步刷新
}

/* —— 数据体检：无论数据来自本地存档、导入文件还是旧版迁移，进入渲染层前统一补齐缺失字段、
      修正坏值（如历史版本把成员对象拼成字符串留下的 "[object Object]"），保证界面永远拿到合法结构 —— */
function normalizeState(st) {
  if (!st || typeof st !== 'object') return null;
  if (!Array.isArray(st.orgs) || !st.orgs.length) return null;
  st.version = 3;
  delete st.comfyJobs;   // 漫剧/视频生成已下线：历史遗留的生成任务记录一并清除
  if (!st.orgs.some(x => x.id === st.activeOrgId)) st.activeOrgId = st.orgs[0].id;
  for (const org of st.orgs) {
    org.name = typeof org.name === 'string' && org.name.trim() ? org.name : '未命名组织';
    org.badge = typeof org.badge === 'string' && org.badge ? org.badge : org.name[0];
    if (!Array.isArray(org.execLog)) org.execLog = [];   // 执行流水表（组织维度，封顶滚动）
    if (!Array.isArray(org.agents)) org.agents = seedAgents();
    for (const a of org.agents) if (a.mode === 'cli' && a.runtime !== 'cloud') a.runtime = 'local';
    /* qoder 族默认模板升级（一次性迁移）：无头 -p 默认权限档拒写文件（PM/文档阶段产物落不了盘），
       官方默认模板追加 accept_edits。只替换与旧默认完全一致的模板——用户自定义过参数的不碰 */
    for (const a of org.agents) {
      if (a.mode === 'cli' && ['qoder', 'qoder-cn'].includes(a.cliId) && a.cliTemplate
        && a.cliTemplate === (a.cliCommand || '') + ' -p {prompt}' && !/--permission-mode/.test(a.cliTemplate)) {
        a.cliTemplate += ' --permission-mode accept_edits';
      }
    }
    if (!Array.isArray(org.spaces) || !org.spaces.length) {
      org.spaces = [{ id: 'sp' + now(), name: '默认空间', badge: '空', sprint: '', members: [{ name: '我', role: 'owner' }],
        tasks: [], prompts: [], autos: seedAutos(), chart: [0, 0, 0, 0, 0, 0, 0], integ: {},
        activity: [], iterations: [], epics: [], seq: 1, deliverSeq: 1, repoRoot: '', readAt: 0 }];
    }
    for (const sp of org.spaces) normalizeSpace(sp);
  }
  const og = st.orgs.find(x => x.id === st.activeOrgId);
  if (!og.spaces.some(s => s.id === st.activeSpaceId)) st.activeSpaceId = og.spaces[0].id;
  return st;
}

function normalizeSpace(sp) {
  sp.name = typeof sp.name === 'string' && sp.name.trim() ? sp.name : '未命名空间';
  sp.badge = typeof sp.badge === 'string' && sp.badge ? sp.badge : sp.name[0];
  sp.sprint = typeof sp.sprint === 'string' ? sp.sprint : '';
  sp.repoRoot = typeof sp.repoRoot === 'string' ? sp.repoRoot : '';
  sp.repos = Array.isArray(sp.repos) ? sp.repos.filter(r => r && typeof r.path === 'string') : [];
  if (sp.repoRoot && !sp.repos.some(r => r.path === sp.repoRoot)) sp.repos.unshift({ name: repoName(sp.repoRoot), path: sp.repoRoot });
  for (const t of (sp.tasks || [])) if (typeof t.repoRoot !== 'string') t.repoRoot = '';
  sp.members = (Array.isArray(sp.members) ? sp.members : []).map(m =>
    typeof m === 'string' ? { name: m, role: 'member' }
      : { name: typeof m?.name === 'string' && m.name.trim() ? m.name : '成员', role: ['owner', 'member', 'guest'].includes(m?.role) ? m.role : 'member' });
  for (const k of ['iterations', 'epics', 'prompts', 'autos', 'activity', 'chart']) if (!Array.isArray(sp[k])) sp[k] = [];
  if (typeof sp.chartDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sp.chartDay)) {
    /* 旧档无日切锚点：桶龄不可知，按「近 7 日」展示即是编造——清洗归零，从今天起如实计数 */
    sp.chart = [0, 0, 0, 0, 0, 0, 0];
    sp.chartDay = dayStr(now());
  }
  delete sp.comics;   // 漫剧功能已下线：旧档的漫剧项目数据清除
  if (!sp.integ || typeof sp.integ !== 'object') sp.integ = {};
  sp.seq = Number.isFinite(sp.seq) ? sp.seq : 1;
  sp.deliverSeq = Number.isFinite(sp.deliverSeq) ? sp.deliverSeq : 1;
  sp.readAt = Number.isFinite(sp.readAt) ? sp.readAt : 0;
  sp.tasks = (Array.isArray(sp.tasks) ? sp.tasks : []).map(t => {
    if (!t || typeof t !== 'object') return null;
    if (t.linkComicId || t.type === 'comic') return null;   // 漫剧联动任务卡随漫剧功能一并下线
    t.title = typeof t.title === 'string' && t.title.trim() ? t.title : '（无标题）';
    t.status = STATUS_FLOW.includes(t.status) ? t.status : 'todo';
    t.type = TYPE_LABEL[t.type] ? t.type : 'chore';
    t.pri = ['P0', 'P1', 'P2'].includes(t.pri) ? t.pri : 'P2';
    if (t.assignee && t.assignee.kind === 'human' && (typeof t.assignee.name !== 'string' || t.assignee.name === '[object Object]')) t.assignee = null;
    for (const k of ['thread', 'comments', 'history']) if (!Array.isArray(t[k])) t[k] = [];
    return t;
  }).filter(Boolean);
}

async function init() {
  let saved = await loadState();
  let booted = false;
  try {
    if (saved && Array.isArray(saved.orgs) && saved.orgs.length) {
      const n = normalizeState(saved); if (n) { state = n; booted = true; }
    } else if (saved && Array.isArray(saved.spaces) && saved.spaces.length) {
      state = normalizeState(toV3(saved, '我的组织')) || seed(); booted = true;
    } else if (saved && Array.isArray(saved.tasks)) {
      state = normalizeState(toV3(migrateV1(saved), '我的组织')) || seed(); booted = true;
    }
  } catch (e) { console.error('[boot] 状态数据异常，回退初始数据', e); booted = false; }
  if (!booted) state = seed();
  save();

  // 分步容错：任何一步渲染失败都不阻断后续步骤，避免停在空白壳
  const faults = [];
  const boot = (label, fn) => { try { fn(); } catch (e) { faults.push(label); console.error('[boot] ' + label, e); } };
  boot('sidebar', () => initSidebar());
  boot('org-line', () => renderOrgLine());
  boot('space-button', () => renderSpaceButton());
  boot('cli-presets', () => { if (window.reins) window.reins.cliList().then(list => { if (Array.isArray(list) && list.length) CLI_PRESETS.splice(0, CLI_PRESETS.length, ...list); }).catch(() => { }); });
  boot('nav', () => renderNav());
  boot('chart-roll', () => rollChartDaily());
  boot('first-view', () => switchView(curView));   // 默认落在「在役面板」（概览）
  if (faults.includes('first-view')) {
    $('#content').innerHTML = `<div class="panel" style="padding:26px"><h3 style="margin:0 0 8px">视图渲染失败</h3>
      <div style="font-size:13px;color:var(--ink-dim)">部分数据可能损坏。可先导出备份，再尝试「清空数据」。</div></div>`;
  }
  if (faults.length) toast('界面初始化遇到问题', '已尽量恢复，详见控制台', '⚠');
  updateNodePill(); setInterval(updateNodePill, 30000);
  boot('bell', () => renderBell());
  /* 数据自检：启动后静默跑一次，只有发现问题才提示（正常情况不打扰） */
  boot('integrity', () => setTimeout(() => runIntegrityCheck(true, { silent: true }), 2500));

  // 主进程执行事件 → 更新运行 UI；调度器触发 → 生成站报/周报写入看板
  window.reins?.onRunEvent(evt => handleRunEvent(evt));
  window.reins?.onScheduleFire?.(info => handleScheduleFire(info));
  /* 飞书群指令 → 主进程反向调用渲染层执行（任务状态在多空间内存态里，只有这里拿得到） */
  window.reins?.onFeishuCall?.(req => handleFeishuCall(req));
  /* 就绪信号：控制台未就绪期间收到的飞书群指令在主进程排队，这里通知回放。
     必须放在 onFeishuCall 注册之后——回放靠该监听器接住主进程的转发 */
  window.reins?.rendererReady?.().catch(() => { });
  window.reins?.getSettings?.().then(s => { if (s) { hookCfg = { ...hookCfg, ...s }; feishuCfg = { ...feishuCfg, ...(s.feishu || {}) }; } }).catch(() => { });

  $('#search').addEventListener('input', e => { filters.search = e.target.value; if (curView === 'kanban' || curView === 'list') render(); });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); }
    if (e.key === 'Escape') { closeSpaceMenu(); closeOrgMenu(); closeModal(); closeDrawer(); document.getElementById('notif-pop')?.classList.remove('show'); document.querySelectorAll('.ds.open').forEach(d => d.classList.remove('open')); }
    const tag = document.activeElement?.tagName;
    if ((e.metaKey || e.ctrlKey) && /^[0-9]$/.test(e.key) && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      e.preventDefault(); const vi = e.key === '0' ? 9 : Number(e.key) - 1; switchView(VIEWS[vi].id);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); openShortcutHelp(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
  });
    document.addEventListener('click', e => {
      if (!e.target.closest('.space-menu')) { closeSpaceMenu(); closeOrgMenu(); }
      // 收件箱弹层：点击顶栏铃铛以外任意处即收起（铃铛按钮自带 stopPropagation，不会误关）
      if (!e.target.closest('.topbar-bell')) document.getElementById('notif-pop')?.classList.remove('show');
      document.querySelectorAll('.ds.open').forEach(d => { if (!e.target.closest('.ds') || d !== e.target.closest('.ds')) d.classList.remove('open'); });
    });

  // 恢复/演示：进行中且指派演示引擎的任务自动继续（真实 API 不自动续跑，避免无感知扣费）
  setTimeout(() => {
    S().tasks.filter(t => t.status === 'doing' && ['agent', 'role'].includes(t.assignee?.kind) && !runs[t.id])
      .forEach((t, i) => {
        const a = t.assignee.kind === 'role' ? (resolveRoleAgent(t) || {}).agent : agentById(t.assignee.id);
        if (a && a.mode === 'sim') setTimeout(() => {
          /* 流水线中断续跑：并行阶段实例逐个恢复（与派发同构，键 taskId#阶段id），避免兄弟阶段卡在运行态 */
          const inFlight = (t.pipeline?.on && t.pipeline.stages || []).filter(s => ['running', 'rework'].includes(s.state) && s.id);
          if (inFlight.length) {
            a.status = 'working'; a.taskId = t.id;
            addActivity('🚀', a.name + ' 恢复执行 ' + t.key + ' ' + t.title + '（并行阶段 × ' + inFlight.length + '）');
            inFlight.forEach(s => {
              if (runs[t.id + '#' + s.id]) return;
              runs[t.id + '#' + s.id] = { mode: 'sim', steps: buildSteps(t), idx: 0, log: [], done: false, stageId: s.id, stageNo: s.no };
              stepRun(t.id + '#' + s.id);
            });
            return;
          }
          if (!runs[t.id]) {
            a.status = 'working'; a.taskId = t.id;
            runs[t.id] = { mode: 'sim', steps: buildSteps(t), idx: 0, log: [], done: false };
            addActivity('🚀', a.name + ' 恢复执行 ' + t.key + ' ' + t.title);
            stepRun(t.id);
          }
        }, 900 + i * 700);
      });
  }, 600);
}
/* —— 全局兜底：运行中任何渲染错误都给出可见提示并尝试自愈刷新，不再让界面停在半路 —— */
let lastHeal = 0;
function healUi(e) {
  const msg = String((e && (e.message || e.reason?.message)) || '');
  if (!msg) return;                       // 资源加载失败等无信息事件，忽略
  console.error('[reins]', e);
  const t = Date.now();
  if (t - lastHeal < 5000) return;        // 节流，避免错误风暴引发循环刷新
  lastHeal = t;
  try { refreshViews(); toast('界面已自动恢复', '渲染错误：' + msg.slice(0, 80) + '，详见控制台', '⚠'); } catch (err) { }
}
window.addEventListener('error', healUi);
window.addEventListener('unhandledrejection', healUi);

document.addEventListener('DOMContentLoaded', init);
