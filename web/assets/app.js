/* ============================================================
   Reins — 控制台逻辑
   · 桌面客户端：状态经 IPC 落盘 userData/reins-data.json；
    执行引擎分两档——「真实 API」（OpenAI 兼容协议，主进程流式调用）
    与「演示引擎」（本地模拟，零配置可玩）。浏览器打开时自动降级
    localStorage + 仅演示引擎。
   ============================================================ */
'use strict';

const STORE_KEY = 'reins-state-v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

const TYPE_LABEL = { req: '需求', bug: '缺陷', support: '支持', test: '测试', chore: '杂务', research: '调研', writing: '文案', data: '数据', comic: '漫剧' };
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
  { id: 'claude-code', label: 'Claude Code', cmd: 'claude', template: 'claude -p {prompt} --output-format text' },
  { id: 'codex', label: 'Codex CLI', cmd: 'codex', template: 'codex exec --skip-git-repo-check {prompt}' },
  { id: 'codebuddy', label: '腾讯 CodeBuddy Code', cmd: 'codebuddy', template: 'codebuddy -y -p {prompt} --output-format text' },
  { id: 'workbuddy', label: '腾讯 WorkBuddy', cmd: 'workbuddy', template: 'workbuddy -y -p {prompt} --output-format text' },
  { id: 'zcode', label: 'ZCode', cmd: 'zcode', template: 'zcode -p {prompt} --no-color' },
  { id: 'opencode', label: 'OpenCode', cmd: 'opencode', template: 'opencode run {prompt}' },
  { id: 'gemini-cli', label: 'Gemini CLI', cmd: 'gemini', template: 'gemini {prompt}' },
  { id: 'cursor-cli', label: 'Cursor CLI', cmd: 'cursor-agent', template: 'cursor-agent {prompt}' },
  { id: 'qwen-code', label: 'Qwen Code', cmd: 'qwen', template: 'qwen {prompt}' },
  { id: 'copilot', label: 'GitHub Copilot CLI', cmd: 'copilot', template: 'copilot -p {prompt}' },
  { id: 'droid', label: 'Droid', cmd: 'droid', template: 'droid {prompt}' },
  { id: 'amp', label: 'Amp', cmd: 'amp', template: 'amp {prompt}' },
  { id: 'openclaw', label: 'OpenClaw', cmd: 'openclaw', template: 'openclaw {prompt}' },
  { id: 'cline', label: 'Cline', cmd: 'cline', template: 'cline {prompt}' },
  { id: 'goose', label: 'Goose', cmd: 'goose', template: 'goose run {prompt}' },
  { id: 'grok', label: 'Grok CLI', cmd: 'grok', template: 'grok {prompt}' },
  { id: 'kimi-cli', label: 'Kimi CLI', cmd: 'kimi', template: 'kimi -p {prompt}' },
  { id: 'kilo', label: 'Kilo Code', cmd: 'kilo', template: 'kilo {prompt}' },
  { id: 'kiro', label: 'Kiro', cmd: 'kiro', template: 'kiro {prompt}' },
  { id: 'trae', label: 'Trae', cmd: 'trae', template: 'trae {prompt}' },
  { id: 'qoder', label: 'Qoder', cmd: 'qoder', template: 'qoder {prompt}' },
  { id: 'auggie', label: 'Auggie', cmd: 'auggie', template: 'auggie {prompt}' },
  { id: 'qwenpaw', label: 'QwenPaw', cmd: 'qwenpaw', template: 'qwenpaw {prompt}' },
  { id: 'hermes', label: 'Hermes', cmd: 'hermes', template: 'hermes {prompt}' },
  { id: 'pi', label: 'Pi', cmd: 'pi', template: 'pi {prompt}' },
];
const providerLabel = id => (PROVIDER_PRESETS.find(p => p.id === id) || {}).label || id;

/* 无头 CLI 的执行模型（codebuddy/workbuddy 引擎 --model 实测支持）；派发与 Agent 配置共用 */
const CLI_CAN_MODEL = ['codebuddy', 'workbuddy'];
const CB_MODELS = ['hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'space-bunny', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3-pay', 'minimax-m2.7', 'kimi-k3-2', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'];

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
let curView = 'kanban';
let drawerTaskId = null;
let filters = { type: '', who: '', search: '', iter: '', lane: '' };

function now() { return Date.now(); }

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
    seq: 1, deliverSeq: 1, repoRoot: '', readAt: 0,
  };
  return {
    version: 3, activeOrgId: 'og1', activeSpaceId: 'sp1',
    orgs: [{ id: 'og1', name: '我的团队', badge: '团', agents: [], spaces: [space] }],
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
const agentUsable = a => a && (a.mode === 'sim' || a.mode === 'cli' ? a.status !== 'offline' : !!(a.apiKey && a.status !== 'offline'));

/* ============ 时间 ============ */
function fmtRel(ts) {
  const d = new Date(ts), n = new Date();
  const diff = n - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === n.toDateString()) return hm;
  const yd = new Date(n - 864e5);
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
  { id: 'comics', ic: 'clapperboard', label: '漫剧', sub: '从设定到成片的漫剧生产线', group: 'work' },
  { id: 'nodes', ic: 'server', label: '节点', sub: '本机与云端执行节点', group: 'work' },
  { id: 'agents', ic: 'bot', label: 'Agent', sub: '接入 API 或本机 CLI，统一指派任务', group: 'cmd' },
  { id: 'prompts', ic: 'library', label: '提示词库', sub: '共享的提示词，执行时可附加到任务', group: 'cmd' },
  { id: 'autos', ic: 'workflow', label: '自动化', sub: '站会、分诊与周报例程', group: 'cmd' },
  { id: 'integ', ic: 'webhook', label: '集成', sub: 'Webhook 推送与分诊引擎', group: 'cmd' },
  { id: 'settings', ic: 'settings', label: '设置', sub: '模型与密钥 · 客户端偏好 · 数据', group: 'sys' },
];

function renderNav() {
  const sec = (label, ids) => `${label ? `<div class="nav-label">${label}</div>` : ''}${ids.map(id => navItem(VIEWS.find(v => v.id === id))).join('')}`;
  $('#nav').innerHTML = sec('工作台', ['dash', 'kanban', 'list', 'deliveries', 'comics', 'nodes'])
    + sec('指挥', ['agents', 'prompts', 'autos', 'integ'])
    + sec('', ['settings']);
}
function navItem(v) {
  let cnt = '';
  if (v.id === 'kanban') cnt = (S()?.tasks || []).filter(t => t.status !== 'done').length;
  if (v.id === 'agents') cnt = (O().agents || []).filter(a => a.status !== 'offline').length;
  if (v.id === 'comics') cnt = (S()?.comics || []).filter(c => c.status === 'running').length;
  return `<button class="nav-item ${curView === v.id ? 'on' : ''}" onclick="switchView('${v.id}')">
    <span class="ic">${ic(v.ic)}</span><span class="txt">${v.label}</span>${cnt ? `<span class="cnt">${cnt}</span>` : ''}</button>`;
}
function switchView(id) {
  curView = id;
  if (id === 'comic-detail') {
    // 隐藏路由：不进 VIEWS/侧栏，标题随当前漫剧（curComicId）动态生成
    const c = S() && (S().comics || []).find(x => x.id === curComicId);
    $('#view-title').textContent = c ? c.title : '漫剧';
    $('#view-sub').textContent = c ? `共 ${(c.episodes || []).length} 集 · ${CM_STATUS[c.status] ? CM_STATUS[c.status].label : ''}` : '';
  } else {
    const v = VIEWS.find(x => x.id === id);
    $('#view-title').textContent = v.label;
    $('#view-sub').textContent = v.sub;
  }
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
  else if (curView === 'comics') el.innerHTML = viewComics();
  else if (curView === 'comic-detail') el.innerHTML = viewComicDetail();
  else if (curView === 'nodes') el.innerHTML = viewNodes();
  else if (curView === 'agents') el.innerHTML = viewAgents();
  else if (curView === 'prompts') el.innerHTML = viewPrompts();
  else if (curView === 'autos') el.innerHTML = viewAutos();
  else if (curView === 'integ') el.innerHTML = viewInteg();
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
  if (t.assignee.kind === 'agent') {
    const a = agentById(t.assignee.id);
    return ['a:' + t.assignee.id, t.assignee.name, 'agent'];
  }
  return ['h:' + t.assignee.name, t.assignee.name, 'human'];
}
function viewKanban() {
  const typeOpts = [{ v: '', l: '全部类型' }, ...Object.keys(TYPE_LABEL).map(k => ({ v: k, l: TYPE_LABEL[k] }))];
  const whoOpts = [{ v: '', l: '全部经办' }, { v: 'none', l: '未指派' }, { v: 'human', l: '团队成员' }, ...O().agents.map(a => ({ v: 'a:' + a.id, l: a.name }))];
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
  const ct = t.linkComicId ? comicById(t.linkComicId) : null;   // 漫剧联动卡：进度/失败态取漫剧实时状态
  const running = runs[t.id];
  const pct = ct ? (ct.progress?.pct || 0) : running ? runPct(t.id) : 0;
  const assignee = t.assignee
    ? (t.assignee.kind === 'agent'
      ? `<span class="assignee agent">◆ ${esc(t.assignee.name)}</span>`
      : `<span class="assignee human"><span class="av">${esc(t.assignee.name[0])}</span>${esc(t.assignee.name)}</span>`)
    : `<span class="assignee" style="color:var(--ink-faint)">未指派</span>`;
  return `<div class="tcard" draggable="true" data-task="${t.id}" onclick="${ct ? `openComicDetail('${ct.id}')` : `openTask('${t.id}')`}">
    <div class="k"><span>${t.key}</span><span class="pri ${t.pri}">${t.pri}</span></div>
    <div class="t">${esc(t.title)}</div>
    <div class="row"><span class="ttag ${t.type}">${TYPE_LABEL[t.type] || t.type}</span>${assignee}</div>
    ${ct && ct.status === 'running' ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    ${ct && ct.status === 'failed' ? `<div class="pr-chip" style="background:#fbe5e5;color:#b04848">✕ 生成失败 · 可续跑</div>` : ''}
    ${t.status === 'review' && t.pr ? `<div class="pr-chip">⇄ ${esc(t.pr)} · 待验收</div>` : ''}
    ${t.status === 'done' && t.pr ? `<div class="pr-chip" style="background:#e3f3ea;color:#3d8a5f">✓ ${esc(t.pr)} · 已归档</div>` : ''}
    ${running ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    ${t.status === 'doing' && t.assignee?.kind === 'agent' && !running ? '<div class="bar"><i style="width:6%"></i></div>' : ''}
  </div>`;
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
  if (t.linkComicId) {
    // 漫剧联动卡：不触发 Agent 自动执行与交付号；验收归档语义与普通任务一致
    if (st === 'done') {
      t.doneAt = now(); S().chart[6]++;
      addActivity('🎬', t.key + ' 漫剧已验收归档');
      toast('漫剧已归档', t.key + ' ' + esc(t.title), '🎬');
    }
  } else {
    if (st === 'doing') {
      if (t.assignee?.kind === 'agent') {
        if (!runs[t.id]) startRun(t.id, { byUser: true });
      } else if (!t.assignee) {
        t.assignee = { kind: 'human', name: '我' };
        toast('已自动指派', t.key + ' 已指派给我');
      }
    }
    if (st === 'review' && !t.pr && t.assignee?.kind === 'agent') t.pr = '交付 #' + (S().deliverSeq++);
    if (st === 'done') {
      t.doneAt = now(); S().chart[6]++;
      addActivity('✅', t.key + ' 已归档' + (t.pr ? ' · ' + t.pr : ''));
      toast('任务完成', t.key + ' ' + esc(t.title), '✓');
    }
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
      <td>${t.assignee ? (t.assignee.kind === 'agent' ? '◆ ' + esc(t.assignee.name) : esc(t.assignee.name)) : '<span style="color:var(--ink-faint)">未指派</span>'}</td>
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
          <div class="agent-meta">${a.mode === 'api' ? esc(providerLabel(a.provider)) + ' · ' + esc(a.model || '—') + (a.apiKey ? '' : ' · <b style="color:#c05656">未配置密钥</b>') : a.mode === 'cli' ? (a.runtime === 'cloud' ? '☁ 云端执行 · ' : '本机命令 <b style="font-weight:600">') + (a.runtime === 'cloud' ? esc(a.cliCommand || '—') : '') + (a.runtime === 'cloud' ? '' : '</b>' + (a.detected ? ' · ✓ 已检测到' : '')) : '本地模拟 · 无需配置'}</div>
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
    <div class="grid3">${empty}${cards}<div class="add-card" onclick="openAddAgentModal()"><span class="plus">${ic('plus')}</span>接入 Agent</div></div>`;
}

function toggleAgent(id) {
  const a = agentById(id);
  if (a.status === 'working') { toast('无法离线', a.name + ' 正在执行任务，请先等待完成或终止', '⚠'); return; }
  if (a.mode === 'api' && !a.apiKey && a.status === 'offline') { toast('缺少密钥', '请先在配置中填写 API Key', ''); openAgentConfig(id); return; }
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

function buildStandup() {
  const yst = S().tasks.filter(t => t.doneAt && t.doneAt > now() - 864e5);
  const doing = S().tasks.filter(t => t.status === 'doing');
  const focus = S().tasks.filter(t => t.status === 'todo' && t.pri !== 'P2').sort((a, b) => a.pri.localeCompare(b.pri));
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
function buildWeekly() {
  const wk = S().tasks.filter(t => t.doneAt && t.doneAt > now() - 7 * 864e5);
  const review = S().tasks.filter(t => t.status === 'review');
  const doing = S().tasks.filter(t => t.status === 'doing');
  const whoName = t => t.assignee ? (t.assignee.kind === 'agent' ? '◆ ' + t.assignee.name : t.assignee.name) : '未指派';
  const byWho = {};
  for (const t of wk) byWho[whoName(t)] = (byWho[whoName(t)] || 0) + 1;
  const iters = (S().iterations || []).map(it => {
    const ts = S().tasks.filter(t => t.iterId === it.id);
    const done = ts.filter(t => t.status === 'done').length;
    return { name: it.name, total: ts.length, done, pct: ts.length ? Math.round(done / ts.length * 100) : 0 };
  }).filter(x => x.total);
  const d = new Date();
  const agents = O().agents.filter(a => a.done > 0);
  return [
    `# 周报 · ${S().name} · ${d.getMonth() + 1}月${d.getDate()}日`,
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
function viewInteg() {
  const cfg = hookCfg || {};
  const evs = [['create', '任务创建'], ['done', '完成归档'], ['reject', '验收打回']];
  const roadmap = [['Linear', '双向同步 · 规划中'], ['TAPD', '双向同步 · 规划中'], ['GitHub Issues', '双向同步 · 规划中'], ['GitLab', '双向同步 · 规划中'], ['飞书项目', '双向同步 · 规划中'], ['Jira', '双向同步 · 规划中']];
  const engineSel = cfg.triageEngine || 'auto';
  return `<div class="view-head"><h2>集成</h2><p>任务事件推送与分诊引擎</p></div>
    <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:14px;align-items:start">
      <div style="display:grid;gap:14px">
      <div class="panel integ-card">
        <div class="integ-brand">
          <div class="lg" style="background:#cf8a3e">${ic('webhook')}</div>
          <div><h3>Webhook 开放接口</h3><span>任务事件实时推送到任意系统</span></div>
          <span class="status-pill ${cfg.webhookUrl ? 'idle' : 'offline'}" style="margin-left:auto">${cfg.webhookUrl ? '已配置' : '未配置'}</span>
        </div>
        <div class="integ-desc">任务事件会以 JSON POST 发送到你指定的地址，群机器人、自动化平台或自建服务均可直接接收。</div>
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
          <span class="status-pill ${cfg.jevKey ? 'idle' : 'offline'}" style="margin-left:auto">${cfg.jevKey ? '已配置' : '未配置'}</span>
        </div>
        <div class="integ-desc">将任务分诊（类型、优先级、经办人）交给决策模型：输入任务与候选名单，输出带概率的结构化建议，适合批量分诊。不配置时继续用 API 模型分诊。</div>
        ${window.reins ? `
        <div class="f-row"><label>API Key（console.typesafe.ai 创建）</label><input type="password" id="jev-key" value="${esc(cfg.jevKey || '')}" placeholder="sk-…"></div>
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
          <b style="color:var(--ink)">关于集成方式</b><br>Webhook 是最通用的集成方式，任何能接收 HTTP 的系统都能直接对接；决策模型负责分诊这类高频判断，不占用通用模型。双向同步（状态回写、评论互转）在规划中。
        </div>
      </div>
    </div>`;
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
    hookCfg = { ...hookCfg, ...s };
    toast('已保存', url ? '事件将推送到 ' + esc(url.slice(0, 48)) : '已清空推送地址', '⇄');
    render();
  });
}
async function whTest() {
  const url = $('#wh-url').value.trim();
  if (url && !/^https?:\/\//.test(url)) { toast('地址无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  if (url && url !== (hookCfg.webhookUrl || '')) {
    const s = settingsApplied(await window.reins.setSettings({ webhookUrl: url }));
    if (s) hookCfg = { ...hookCfg, ...s };
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
  /* settings:set 契约收口（返工①）：同 whSave，成功提示移入回调、失败如实报出 */
  window.reins.setSettings({ jevKey: key, jevUrl: url, jevModel: model, triageEngine: engine }).then(r => {
    const s = settingsApplied(r);
    if (!s) return;
    hookCfg = { ...hookCfg, ...s };
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
    const u = a.status === 'working' ? Math.min(96, a.taskId && runs[a.taskId] ? 20 + runPct(a.taskId) * 0.76 : 40) : 0;
    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:13px">
      <span style="width:130px;font-size:12px;font-weight:600;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${brandOf(a)} ${esc(a.name)}</span>
      <div class="util" style="flex:1;margin:0"><i style="width:${u}%"></i></div>
      <span style="width:140px;font-size:11px;color:var(--ink-faint);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${cur ? cur.key + ' · ' + Math.round(u) + '%' : '空闲'}</span>
    </div>`;
  }).join('');
  return `<div class="stats">
      <div class="stat"><span class="ic" style="color:var(--doing)">${ic('play')}</span><b>${doing.length}</b><span>进行中</span><div class="trend">含 Agent 执行 ${doing.filter(t => t.assignee?.kind === 'agent').length} 项</div></div>
      <div class="stat"><span class="ic" style="color:var(--review)">${ic('clock')}</span><b>${review.length}</b><span>待验收</span><div class="trend">需人工验收</div></div>
      <div class="stat"><span class="ic" style="color:var(--done)">${ic('check')}</span><b>${doneToday.length}</b><span>今日归档</span></div>
      <div class="stat"><span class="ic" style="color:var(--accent)">${ic('bot')}</span><b>${working.length}/${online.length}</b><span>Agent 执行中 / 在线</span></div>
    </div>
    <div class="grid2" style="margin-bottom:14px">
      <div class="panel"><h3 style="font-size:14px;margin-bottom:4px">近 7 日吞吐</h3><span style="font-size:12px;color:var(--ink-faint)">归档任务数 / 天</span><div class="chart">${bars}</div></div>
      <div class="panel"><h3 style="font-size:14px;margin-bottom:14px">Agent 负载</h3>${utilRows}</div>
    </div>
    <div class="panel"><h3 style="font-size:14px;margin-bottom:6px">最近动态</h3>
      <ul class="feed">${S().activity.slice(0, 10).map(a => `<li><span class="fic">${gic(a.icon)}</span><div><div>${esc(a.text)}</div><div class="ft">${fmtRel(a.at)}</div></div></li>`).join('')}</ul>
    </div>`;
}

/* ============ 抽屉：任务详情 ============ */
function openTask(id) {
  const t = byId(id);
  if (t?.linkComicId && comicById(t.linkComicId)) return openComicDetail(t.linkComicId);   // 漫剧联动卡直达详情页
  drawerTaskId = id; document.body.classList.add('drawer-open'); renderDrawer(id);
}
function closeDrawer() { drawerTaskId = null; document.body.classList.remove('drawer-open'); }
function drawerOpenOn(id) { return drawerTaskId === id && document.body.classList.contains('drawer-open'); }

function renderDrawer(id) {
  const t = byId(id); if (!t) { closeDrawer(); return; }
  const r = runs[id];
  const pct = runPct(id);
  const assigneeOpts = [{ v: '', l: '未指派' },
    ...memberNames().map(m => ({ v: 'm:' + m, l: m })),
    ...O().agents.map(a => ({ v: 'a:' + a.id, l: a.name + (a.status === 'working' && a.taskId !== id ? '（忙）' : ''), dis: !agentUsable(a) }))];
  const promptOpts = [{ v: '', l: '不附加' }, ...S().prompts.map(p => ({ v: p.id, l: p.title }))];

  let execHTML = '';
  if (r) {
    execHTML = `<div class="d-sec"><h4>${r.mode === 'api' ? '真实执行 · 流式输出' : 'Agent 执行 · 实时输出'} · ${pct ? pct + '%' : '运行中'}</h4>
      <div class="run-box">
        <div class="run-head"><span class="agent-name">${esc(t.assignee?.name || 'Agent')}</span><span>${r.mode === 'api' ? esc(r.model || '') : 'workspaces/' + t.key}</span><span class="pct" id="run-pct">${pct}%</span></div>
        <div class="run-bar"><i id="run-bar" style="width:${pct}%"></i></div>
        <div class="term-scroll" id="drawer-log">${r.log.map(([c, x]) => `<div class="ln ${c}">${esc(x)}</div>`).join('')}<div class="ln stream" id="drawer-stream">${esc(r.stream || '')}</div></div>
      </div>
      <div class="run-actions">
        <button class="btn btn-o btn-sm" onclick="cancelRun('${t.id}')">■ 终止执行</button>
      </div></div>`;
  } else if (t.status === 'todo' && t.assignee?.kind === 'agent') {
    const a = agentById(t.assignee.id);
    const canModel = a && a.mode === 'cli' && CLI_CAN_MODEL.includes(a.cliId);
    execHTML = `<div class="d-sec"><h4>Agent 执行</h4>
      <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-p" onclick="startRun('${t.id}',{byUser:true});renderDrawer('${t.id}')">▶ 指派并启动</button>
        ${canModel ? `<label style="font-size:12.5px;color:var(--ink-dim);display:flex;align-items:center;gap:7px">执行模型
          ${ds('run-model', [{ v: '', l: a.cliModel ? a.cliModel + '（Agent 默认）' : '默认模型' }, ...CB_MODELS.map(m => ({ v: m, l: m }))], t.runModel || '', `byId('${t.id}').runModel=this.value;save()`, 'inline')}</label>` : ''}
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
        ${t.result ? `<div class="result-box">${mdToHtml(t.result)}</div>`
        : `<p>执行已完成，请核对改动后验收</p>`}
        <div style="display:flex;gap:9px;margin-top:12px">
          <button class="btn btn-p btn-sm" onclick="mergeTask('${t.id}')">✓ 通过并归档</button>
          <button class="btn btn-o btn-sm" onclick="rejectTask('${t.id}')">✗ 打回重做</button>
        </div>
      </div>
      ${t.thread?.length ? `<div class="thread-note">该任务已执行 ${t.thread.filter(m => m.role === 'assistant').length} 轮，打回时 Agent 会结合此前的交付与反馈继续修改。</div>` : ''}</div>`;
  } else if (t.status === 'done' && t.pr) {
    execHTML = `<div class="d-sec"><h4>结果</h4><div class="done-box">✓ 已归档 <span class="pr">${esc(t.pr)}</span> · 完成于 ${t.doneAt ? fmtRel(t.doneAt) : '—'}</div>
      ${t.result ? `<div class="result-box" style="margin-top:10px">${mdToHtml(t.result)}</div>` : ''}</div>`;
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
          ${ds('d-assignee', assigneeOpts, t.assignee?.kind === 'human' ? 'm:' + t.assignee.name : t.assignee?.kind === 'agent' ? 'a:' + t.assignee.id : '', `updateAssignee('${t.id}',this.value)`)}
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
      ${(t.history && t.history.length) ? `<div class="d-sec"><h4>动态 · ${t.history.length}</h4>
        <ul class="tl">${t.history.slice().reverse().map(h => `<li><span class="fic">${gic(h.icon)}</span><div><div>${esc(h.text)}</div><div class="ft">${fmtRel(h.at)}</div></div></li>`).join('')}</ul>
      </div>` : ''}
      <div class="d-sec"><h4>评论 · ${t.comments.length}</h4>
        ${t.comments.map(c => `<div class="comment"><div class="av">${esc(c.who[0])}</div><div class="bubble"><div class="who"><b>${esc(c.who)}</b> · ${fmtRel(c.at)}</div>${esc(c.text)}</div></div>`).join('') || '<div style="font-size:12px;color:var(--ink-faint)">还没有评论</div>'}
        <div class="c-input"><input id="c-input" placeholder="输入评论，回车发送" onkeydown="if(event.key==='Enter')sendComment('${t.id}')"><button class="btn btn-o btn-sm" onclick="sendComment('${t.id}')">发送</button></div>
      </div>
      <div class="d-sec d-del"><button class="btn btn-o btn-sm btn-danger-o" onclick="confirmDeleteTask('${t.id}')">删除任务</button><span>永久删除，含执行记录、评论与交付物</span></div>
    </div>`;
  const dl = $('#drawer-log'); if (dl) dl.scrollTop = dl.scrollHeight;
}

function updateAssignee(id, val) {
  const t = byId(id);
  if (!val) { t.assignee = null; }
  else if (val.startsWith('m:')) { t.assignee = { kind: 'human', name: val.slice(2) }; }
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
  const feedback = ($('#rj-text').value || '验收未通过，请按意见修改。').trim();
  t.thread = t.thread || [];
  t.thread.push({ role: 'user', content: '【验收反馈】' + feedback });
  t.status = 'todo'; t.pr = null;
  t.comments.push({ who: 'Reins', text: '验收打回：' + feedback, at: now() });
  th(t, '↩️', '验收打回：' + feedback.slice(0, 40));
  addActivity('↩️', t.key + ' 验收打回，等待重做');
  toast('已打回', t.key + ' 回到待处理，可重新指派执行', '↩');
  notifyHook('task.rejected', t);
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
  const r = runs[taskId] = { mode: 'api', log: [], stream: '', model: agent.model, usage: null, done: false };
  r.log.push(['act', `▸ 装配任务上下文（${t.key} · ${TYPE_LABEL[t.type] || t.type}）`]);
  const extra = t.attachPrompt ? (S().prompts.find(p => p.id === t.attachPrompt)?.content || '') : '';
  if (extra) r.log.push(['ok', `✓ 已附加团队提示词「${S().prompts.find(p => p.id === t.attachPrompt)?.title}」`]);
  if (t.thread?.length) r.log.push(['', `↻ 带此前 ${t.thread.filter(m => m.role === 'assistant').length} 轮交付继续修改`]);
  r.log.push(['ok', agent.mode === 'cli'
    ? agent.runtime === 'cloud'
      ? `☁ 已派发云端节点：${agent.cliCommand || '命令见配置'}（流式回传）`
      : `✓ 调用本机 CLI：${agent.cliCommand || '命令见配置'}（子进程流式）`
    : `✓ 调用 ${providerLabel(agent.provider)} · ${agent.model}（流式）`]);
  const effAgent = (agent.mode === 'cli' && t.runModel && CLI_CAN_MODEL.includes(agent.cliId)) ? { ...agent, cliModel: t.runModel } : agent;
  if (agent.mode === 'cli') r.model = effAgent.cliModel || '默认模型';
  const execLabel = agent.mode === 'cli'
    ? (agent.cliCommand || 'CLI') + (effAgent.cliModel ? ' · ' + effAgent.cliModel : ' · 默认模型')
    : providerLabel(agent.provider) + ' · ' + agent.model;
  th(t, '▶', '开始执行 · ' + execLabel);
  window.reins.runStart({ task: t, agent: effAgent, extraPrompt: extra, repoRoot: agent.mode === 'cli' ? (t.repoRoot || S().repoRoot || '') : '', runtime: agent.mode === 'cli' && agent.runtime === 'cloud' ? 'cloud' : 'local' });
  updateRunUI(taskId);
}

function handleRunEvent(evt) {
  const { taskId } = evt;
  const r = runs[taskId]; if (!r) return;
  const t = byId(taskId);
  if (evt.type === 'delta') {
    r.stream += evt.text;
    const box = $('#drawer-stream');
    if (box && drawerOpenOn(taskId)) { box.textContent = r.stream; const dl = $('#drawer-log'); if (dl) dl.scrollTop = dl.scrollHeight; }
    document.querySelectorAll(`[data-task="${taskId}"] .bar i`).forEach(el => el.style.width = runPct(taskId) + '%');
    return;
  }
  if (evt.type === 'usage') { r.usage = evt.usage; return; }
  // 主进程上报的执行模型（start 即报，CLI 事件流的 init 帧随后用真实模型修正——默认模型也能显示）
  if (evt.type === 'model') {
    r.model = evt.model;
    if (evt.final && t) th(t, '◆', '执行模型 ' + evt.model); // init 帧确认的真实模型入时间线，事后可查
    updateRunUI(taskId); return;
  }
  if (evt.type === 'note') { r.log.push(['', evt.text]); updateRunUI(taskId); return; }
  if (evt.type === 'done') {
    // stream 里已经有完整执行过程（工具调用日志），只在为空时才用交付文本补位，别把过程日志冲掉
    r.done = true; if (!r.stream) r.stream = evt.result || '';
    const t2 = byId(taskId); const a = t2.assignee ? agentById(t2.assignee.id) : null;
    t2.result = evt.result;
    t2.thread = t2.thread || [];
    t2.thread.push({ role: 'assistant', content: evt.result });
    t2.status = 'review'; t2.pr = '交付 #' + (S().deliverSeq++);
    if (evt.worktree) { t2.worktree = evt.worktree; th(t2, '🌿', '改动落在隔离工作区 reins/' + t2.key); }
    if (Array.isArray(evt.changes) && evt.changes.length) {
      t2.changes = evt.changes;
      th(t2, '📝', `实际改动 ${evt.changes.length} 个文件：` + evt.changes.slice(0, 5).map(c => c.file).join('、') + (evt.changes.length > 5 ? ' 等' : ''));
    }
    if (a) { a.status = 'idle'; a.done++; a.taskId = null; }
    const used = evt.usage?.total_tokens || 0;
    if (a) a.tokens += used;
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
    r.log.push(['err', '✕ 调用失败：' + evt.message]);
    if (t) {
      t.status = 'todo';
      const a = t.assignee ? agentById(t.assignee.id) : null;
      if (a) { a.status = 'idle'; a.taskId = null; }
    }
    toast('执行失败', String(evt.message).slice(0, 60), '⚠');
    delete runs[taskId];
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
    return;
  }
  if (evt.type === 'cancelled') {
    r.log.push(['err', '■ 已终止']);
    if (t) {
      t.status = 'todo';
      const a = t.assignee ? agentById(t.assignee.id) : null;
      if (a) { a.status = 'idle'; a.taskId = null; }
    }
    delete runs[taskId];
    save(); refreshViews();
    if (drawerTaskId === taskId) renderDrawer(taskId);
  }
}

function cancelRun(taskId) {
  const r = runs[taskId]; if (!r) return;
  if (r.mode === 'api') { window.reins?.runCancel(taskId); }
  else { clearTimeout(r.timer); delete runs[taskId]; const t = byId(taskId); if (t) t.status = 'todo'; save(); refreshViews(); if (drawerTaskId === taskId) renderDrawer(taskId); }
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
}

/* ---- 演示引擎（本地模拟，零配置） ---- */
function buildSteps(task, inst) {
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

function startRun(taskId, opts = {}) {
  const t = byId(taskId);
  if (!t.assignee || t.assignee.kind !== 'agent') { toast('无法启动', '请先将任务指派给一个 Agent', '⚠'); return; }
  const a = agentById(t.assignee.id);
  if (!a) { toast('Agent 不存在', '', '⚠'); return; }
  if (a.status === 'offline' || (a.mode === 'api' && !a.apiKey)) {
    toast(a.mode === 'api' ? '缺少密钥' : 'Agent 离线', a.mode === 'api' ? '请在设置中配置 API Key' : '请先上线 ' + esc(a.name), '⚠');
    if (a.mode === 'api') openAgentConfig(a.id);
    return;
  }
  if (a.mode === 'cli' && a.runtime === 'cloud' && !hookCfg.cloudUrl) {
    toast('未配置云端节点', '先在「设置 → 云端节点」填写服务器地址与令牌', '☁');
    switchView('settings');
    return;
  }
  if (runs[taskId]) return;
  t.status = 'doing'; a.status = 'working'; a.taskId = taskId;
  th(t, '🚀', a.name + ' 开始执行');
  addActivity('🚀', a.name + ' 开始执行 ' + t.key + ' ' + t.title);
  if (opts.byUser) toast('已指派并启动', a.name + ' 开始执行 ' + t.key, '▶');
  save();

  if ((a.mode === 'api' || a.mode === 'cli') && window.reins) {
    startApiRun(taskId, a, opts);
  } else {
    runs[taskId] = { mode: 'sim', steps: buildSteps(t), idx: 0, log: [], done: false };
    stepRun(taskId);
  }
  refreshViews();
  if (opts.openDrawer) openTask(taskId);
  else if (drawerTaskId === taskId) renderDrawer(taskId);
}
function stepRun(taskId) {
  const r = runs[taskId]; if (!r) return;
  if (r.idx >= r.steps.length) { finishRun(taskId); return; }
  const [cls, text] = r.steps[r.idx];
  r.log.push([cls, text]);
  const t = byId(taskId), a = t?.assignee ? agentById(t.assignee.id) : null;
  if (a) a.tokens += rnd(6, 24) * 1000;
  r.idx++;
  updateRunUI(taskId);
  r.timer = setTimeout(() => stepRun(taskId), rnd(500, 1050));
}
function finishRun(taskId) {
  const r = runs[taskId]; const t = byId(taskId);
  if (!r || !t) return;
  const a = t.assignee ? agentById(t.assignee.id) : null;
  t.status = 'review'; t.pr = '交付 #' + (S().deliverSeq++);
  t.result = t.result || [
    `【演示引擎 · 模拟交付】${t.key} ${t.title}`,
    '',
    `- 执行轮次：${r.log.length} 步 · 用时 ${(rnd(40, 180) / 10).toFixed(1)} 分钟（模拟）`,
    `- 产出：演示引擎生成的示意内容，接入 API 或 CLI Agent 后显示完整产出`,
    `- 建议：验收通过后归档，或打回并附上修改要求`,
  ].join('\n');
  if (a) { a.status = 'idle'; a.done++; a.taskId = null; a.tokens += rnd(30, 80) * 1000; }
  delete runs[taskId];
  addActivity('🔀', t.key + ' 完成，' + t.pr + ' 等待验收（' + (t.assignee?.name || 'Agent') + '）');
  toast('任务完成', t.key + ' 已产出 ' + t.pr + '，等待验收', '✓');
  save(); refreshViews();
  if (drawerTaskId === taskId) renderDrawer(taskId);
}
function updateRunUI(taskId) {
  const r = runs[taskId]; if (!r) return;
  const pct = runPct(taskId);
  if (drawerOpenOn(taskId)) {
    const dl = $('#drawer-log');
    if (dl) {
      const [cls, text] = r.log[r.log.length - 1] || ['', ''];
      const div = document.createElement('div'); div.className = 'ln ' + cls; div.textContent = text;
      const stream = $('#drawer-stream');
      stream ? dl.insertBefore(div, stream) : dl.appendChild(div);
      dl.scrollTop = dl.scrollHeight;
      const pb = $('#run-bar'); if (pb) pb.style.width = pct + '%';
      const pp = $('#run-pct'); if (pp) pp.textContent = pct + '%';
    }
  }
  document.querySelectorAll(`[data-task="${taskId}"] .bar i`).forEach(el => el.style.width = pct + '%');
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
    tasks: [], prompts: tpl === 'team' ? seedPrompts() : [], autos: tpl === 'team' ? seedAutos() : [],
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
      </div>
    </div>`;
  }).join('');
  return `<div class="view-head"><h2>交付</h2><p>共 ${ts.length} 份交付物</p></div>${rows}`;
}
function previewDelivery(id) {
  const t = byId(id);
  openModal(`<div class="modal-head"><h3>${esc(t.title)}</h3><span>${esc(t.pr || t.key)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div class="result-box" style="max-height:56vh;overflow:auto">${mdToHtml(t.result || '（该交付无文本产出）')}</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">关闭</button>
      ${t.result ? `<button class="btn btn-p" onclick="downloadDelivery('${t.id}')">下载 .md</button>` : ''}</div>`);
}
function copyDelivery(id) {
  const t = byId(id);
  navigator.clipboard.writeText(t.result || '').then(
    () => toast('已复制', t.key + ' 的交付物已复制到剪贴板', '⧉'),
    () => toast('复制失败', '当前环境未授权剪贴板', '⚠'));
}
function downloadDelivery(id) {
  const t = byId(id);
  const blob = new Blob([t.result || ''], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = t.key + '-' + String(t.title || '交付').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) + '.md';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已下载', a.download, '⇩');
}

function revealWt(id) {
  const t = byId(id);
  if (t?.worktree && window.reins) window.reins.revealWorktree(t.worktree);
  else toast('不可用', '浏览器预览模式下无法打开访达', '⚠');
}

/* ============ 漫剧工作流（REINS-126） ============
   数据由渲染层持有（S().comics，随 save() 持久化）；执行在主进程的体检副本上，
   comic/episode/shot 补丁事件增量应用（handleComicEvent），与任务抽屉的流式体验同构。
   引擎契约见 services/comic.js：七阶段 bible→script→storyboard→image→video→voice→assemble。 */
const CM_STAGES = [
  { id: 'bible', label: '设定' },
  { id: 'script', label: '剧本' },
  { id: 'storyboard', label: '分镜' },
  { id: 'image', label: '首帧' },
  { id: 'video', label: '视频' },
  { id: 'voice', label: '配音', optional: true },
  { id: 'assemble', label: '合成' },
];
const CM_STATUS = {
  draft: { label: '草稿', cls: 's-draft' },
  running: { label: '生成中', cls: 's-running' },
  paused: { label: '已暂停 · 可续跑', cls: 's-paused' },
  failed: { label: '失败', cls: 's-failed' },
  done: { label: '已完成', cls: 's-done' },
};
let curComicId = null;          // 详情页路由（隐藏视图 comic-detail，不进侧栏）
const cmExpand = {};            // episodeId -> 是否展开镜头网格
const cmSeqSeen = {};           // comicId -> 已应用的最大事件序号（乱序事件丢弃）
let comicRenderEngine = null;   // 渲染引擎配置快照（新建表单 / 设置页显示用）
let cmLogBuf = [];              // 详情页运行日志行 [cls, text, key?]；key 行为流式缓冲
let cmShotCtx = null;           // 镜头预览模态上下文（复制提示词用）
let cmPackCtx = null;           // 合成包模态上下文（复制/下载用）

const comicsOf = () => (S()?.comics || []);
const comicById = id => (S()?.comics || []).find(c => c.id === id);

/* 渲染引擎配置缺口的前端口径（与主进程 renderConfigError 同口径 · 返工修复③）：
   新建表单与设置摘要据此点名缺哪个字段（地址 / Key / 模型名），而不是笼统一句「未配置」；
   配音模型为可选阶段，缺口不计。返回 '' 表示配置完整可用 */
function cmRenderGapLabel(e) {
  if (!e || (!e.baseURL && !e.apiKey)) return '渲染引擎未配置';
  if (!e.baseURL) return '渲染引擎缺服务地址（Base URL）';
  if (!e.apiKey) return '渲染引擎缺 API Key';
  const miss = [];
  if (!e.imageModel) miss.push('图像模型名');
  if (!e.videoModel) miss.push('视频模型名');
  if (miss.length) return '渲染引擎缺' + miss.join(' / ');
  return '';
}

/* —— 通用迷你菜单（卡片 ⋯ / 详情 ⋯ / 剧集 ⋯ / 阶段节点共用；点外部或 Esc 关闭） —— */
let cmMenuEl = null;
function cmMenuClose() { if (cmMenuEl) { cmMenuEl.remove(); cmMenuEl = null; } }
function cmMenu(btn, items) {
  cmMenuClose();
  const el = document.createElement('div');
  el.className = 'cm-menu';
  el.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}"${it.danger ? ' class="danger"' : ''}>${esc(it.label)}</button>`).join('');
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(10, Math.min(r.right - w, window.innerWidth - w - 10)) + 'px';
  el.style.top = (r.bottom + 6 + h > window.innerHeight - 10 ? r.top - h - 6 : r.bottom + 6) + 'px';
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const it = items[Number(b.dataset.i)];
    cmMenuClose();
    it && it.fn && it.fn();
  });
  cmMenuEl = el;
}
document.addEventListener('click', e => { if (cmMenuEl && !e.target.closest('.cm-menu')) cmMenuClose(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') cmMenuClose(); });

/* ============ 视图一：漫剧库 ============ */
function viewComics() {
  const cs = comicsOf();
  if (!cs.length) return `<div class="view-head"><h2>漫剧</h2><p>从设定到成片的漫剧生产线</p></div>
    <div class="panel" style="padding:40px;text-align:center;color:var(--ink-dim)">
      还没有漫剧项目。新建一部，Reins 将从世界观设定一路生成到可下载的成片合成包。<br><br>
      <button class="btn btn-p" onclick="openNewComicModal()">${ic('plus')} 新建漫剧</button>
    </div>`;
  const running = cs.filter(c => c.status === 'running').length;
  return `<div class="view-head"><h2>漫剧</h2><p>共 ${cs.length} 部${running ? ' · ' + running + ' 部生成中' : ''}</p>
      <span class="act"><button class="btn btn-p" onclick="openNewComicModal()">${ic('plus')} 新建漫剧</button></span></div>
    <div class="cm-grid">${cs.map(cmCardHTML).join('')}</div>`;
}
function cmCardHTML(c) {
  const ep0 = (c.episodes || [])[0];
  const sh0 = ep0 && (ep0.shots || [])[0];
  const img = sh0 && (sh0.coverUrl || sh0.imageUrl);
  const st = CM_STATUS[c.status] || CM_STATUS.draft;
  const running = c.status === 'running';
  const pct = running ? (c.progress?.pct || 0) : 100;
  /* data-* 标记供 cmSyncCard 定向刷新（返工修复②）：胶囊/进度条/文案就地更新，
     封面 <img> 只在素材地址变化时换节点 —— 快速连续事件下封面不再反复重载闪烁 */
  return `<div class="cm-card" data-cm="${c.id}" onclick="openComicDetail('${c.id}')">
    <div class="cm-cover" style="aspect-ratio:${(c.aspect || '9:16').replace(':', '/')}">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="ph">${ic('clapperboard')}</span>`}
      <span class="cm-pill ${st.cls}" data-st="${c.status}"${c.status === 'failed' && c.progress?.note ? ` title="${esc(c.progress.note)}"` : ''}>${running ? '<span class="pulse"></span>' : ''}${st.label}</span>
      ${running || c.status === 'failed' ? `<div class="prog${c.status === 'failed' ? ' fail' : ' doing'}" data-pct="${pct}" role="progressbar" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>` : ''}
      <button class="cm-more" title="更多操作" onclick="event.stopPropagation();cmCardMenu(this,'${c.id}')">${ic('more-horizontal')}</button>
    </div>
    <div class="cm-card-txt" data-sig="${esc(cmCardTxtSig(c))}">${cmCardTxtHTML(c)}</div>
  </div>`;
}
function cmCardTxtSig(c) { return [(c.episodes || []).length, c.shotsPer, c.aspect, c.updatedAt].join('|'); }
function cmCardTxtHTML(c) {
  return `<b>${esc(c.title)}</b>
    <span>${(c.episodes || []).length} 集 · 约 ${c.shotsPer} 镜/集</span>
    <span>${esc(c.aspect)} · ${fmtRel(c.updatedAt)}</span>`;
}
/* 库视图卡片定向刷新（REINS-126 返工修复②）：此前每个事件批整页 render()，
   运行中每 120ms 重建全部卡片 <img>（封面闪烁、悬停态丢失）。改为就地更新：
   胶囊换状态、进度条改宽度、文案按签名替换；结构变化（卡片增删）才回退整渲 */
function cmSyncCard(c) {
  const el = document.querySelector(`.cm-card[data-cm="${c.id}"]`);
  if (!el) { render(); return; }
  const st = CM_STATUS[c.status] || CM_STATUS.draft;
  const running = c.status === 'running';
  const pill = el.querySelector('.cm-pill');
  if (pill && pill.dataset.st !== c.status) {
    pill.dataset.st = c.status;
    pill.className = 'cm-pill ' + st.cls;
    pill.innerHTML = (running ? '<span class="pulse"></span>' : '') + st.label;
    if (c.status === 'failed' && c.progress?.note) pill.setAttribute('title', c.progress.note);
    else pill.removeAttribute('title');
  }
  const pct = running ? (c.progress?.pct || 0) : 100;
  let prog = el.querySelector('.prog');
  if (running || c.status === 'failed') {
    const cls = 'prog' + (c.status === 'failed' ? ' fail' : ' doing');
    if (!prog) el.querySelector('.cm-cover')?.insertAdjacentHTML('beforeend',
      `<div class="${cls}" data-pct="${pct}" role="progressbar" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`);
    else if (prog.dataset.pct !== String(pct) || prog.className !== cls) {
      prog.className = cls; prog.dataset.pct = String(pct); prog.setAttribute('aria-valuenow', String(pct));
      const i = prog.querySelector('i'); if (i) i.style.width = pct + '%';
    }
  } else if (prog) prog.remove();
  /* 封面：src 没变绝不重建 <img>（重节点 = 重网络/解码）；占位 → 图 的跃迁一次性换节点 */
  const ep0 = (c.episodes || [])[0];
  const sh0 = ep0 && (ep0.shots || [])[0];
  const src = (sh0 && (sh0.coverUrl || sh0.imageUrl)) || '';
  const img = el.querySelector('.cm-cover img');
  if (src) {
    if (img) {
      if (img.getAttribute('src') !== src) { img.setAttribute('src', src); img.style.display = ''; }
    } else el.querySelector('.cm-cover .ph')?.replaceWith(Object.assign(document.createElement('img'),
      { src, alt: '', loading: 'lazy', onerror: function () { this.style.display = 'none'; } }));
  }
  const txt = el.querySelector('.cm-card-txt');
  const tsig = cmCardTxtSig(c);
  if (txt && txt.dataset.sig !== tsig) { txt.dataset.sig = tsig; txt.innerHTML = cmCardTxtHTML(c); }
}
function cmCardMenu(btn, id) {
  cmMenu(btn, [
    { label: '打开', fn: () => openComicDetail(id) },
    { label: '重命名', fn: () => openComicRename(id) },
    { label: '复制项目', fn: () => cmDuplicate(id) },
    { label: '删除漫剧', danger: true, fn: () => confirmDeleteComic(id) },
  ]);
}
function cmDuplicate(id) {
  const c = comicById(id); if (!c) return;
  const d = JSON.parse(JSON.stringify(c));
  d.id = 'cp' + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);
  d.title = (c.title + ' 副本').slice(0, 60);
  d.status = 'draft'; d.progress = null; d.createdAt = d.updatedAt = now();
  S().comics.unshift(d); syncComicTask(S(), d); save(); refreshViews();
  toast('已复制', '「' + esc(d.title) + '」已创建', '⧉');
}
function openComicRename(id) {
  const c = comicById(id); if (!c) return;
  openModal(`<div class="modal-head"><h3>重命名漫剧</h3><span>${esc(c.title)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div class="f-row" style="margin-bottom:0"><label>标题</label><input type="text" id="cr-title" value="${esc(c.title)}" maxlength="60"></div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="cmRename('${id}')">保存</button></div>`);
  setTimeout(() => { const el = $('#cr-title'); el?.focus(); el?.select(); }, 60);
}
function cmRename(id) {
  const c = comicById(id); if (!c) return;
  const v = $('#cr-title').value.trim();
  if (!v) { $('#cr-title').style.borderColor = 'var(--red)'; $('#cr-title').focus(); return; }
  c.title = v; c.updatedAt = now(); syncComicTask(S(), c); save(); closeModal();
  toast('已重命名', esc(v), '✎');
  if (curView === 'comic-detail' && curComicId === id) switchView('comic-detail'); else refreshViews();
}
function confirmDeleteComic(id) {
  const c = comicById(id); if (!c) return;
  openModal(`<div class="modal-head"><h3>删除漫剧</h3><span>${esc(c.title)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将永久删除「<b style="color:var(--ink)">${esc(c.title)}</b>」及其全部剧集、镜头产物与执行记录${c.status === 'running' ? '；正在执行的生成任务会被立即终止' : ''}。此操作不可撤销。</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-danger" onclick="deleteComic('${id}')">确认删除</button></div>`);
}
async function deleteComic(id) {
  const c = comicById(id); if (!c) { closeModal(); return; }
  if (c.status === 'running' && window.reins) { try { await window.reins.comicCancel(id); } catch (e) { } }
  S().comics = S().comics.filter(x => x.id !== id);
  S().tasks = (S().tasks || []).filter(x => x.linkComicId !== id);   // 联动任务卡一并移除
  delete cmSeqSeen[id];
  addActivity('🗑', '删除了漫剧「' + c.title + '」');
  save(); closeModal();
  if (curComicId === id) { curComicId = null; switchView('comics'); } else refreshViews();
  toast('已删除', '「' + esc(c.title) + '」已移除', '✕');
}

/* ============ 视图二：新建漫剧（模态） ============ */
let ncmAspect = '9:16';
function openNewComicModal() {
  ncmAspect = '9:16';
  const usable = (O().agents || []).filter(a => a.mode === 'api' && a.apiKey && a.status !== 'offline');
  const writerOpts = usable.length
    ? usable.map(a => ({ v: a.id, l: a.name + ' · ' + (a.model || providerLabel(a.provider)) }))
    : [{ v: '', l: '暂无可用编剧 Agent', dis: true }];
  const re = comicRenderEngine;
  const reGap = cmRenderGapLabel(re);   // 逐字段缺口点名（返工③）：缺模型名也拦在创建前，而非启动才失败
  openModal(`<div class="modal-head"><h3>新建漫剧</h3><span>设定 → 剧本 → 分镜 → 首帧 → 视频 → 配音 → 合成</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-row"><label>标题</label><input type="text" id="ncm-title" maxlength="60" placeholder="例如：都市逆袭短剧第一季"></div>
      <div class="f-row"><label>题材 / 故事方向</label><textarea id="ncm-theme" style="min-height:56px" placeholder="例：都市逆袭、末世求生、甜宠日常……越具体，设定越准"></textarea></div>
      <div class="f-row"><label>画风偏好</label><input type="text" id="ncm-style" maxlength="120" placeholder="例：电影感厚涂、高饱和国漫、黑白漫画"></div>
      <div class="f-row"><label>画幅</label>${cmSegHTML()}</div>
      <div class="f-2col">
        <div class="f-row"><label>集数（1 – 24）</label>${cmStepHTML('ncm-eps', 6, 1, 24)}</div>
        <div class="f-row"><label>每集镜头数（4 – 16）</label>${cmStepHTML('ncm-shots', 8, 4, 16)}</div>
      </div>
      <div class="f-2col">
        <div class="f-row"><label>编剧引擎（API Agent）</label>${ds('ncm-writer', writerOpts, usable[0] ? usable[0].id : '')}</div>
        <div class="f-row"><label>渲染引擎（图像 / 视频）</label>
          <div class="cm-engine-line">${reGap
            ? `<span class="warn">${ic('triangle-alert')} ${esc(reGap)}</span><a href="javascript:void 0" onclick="closeModal();switchView('settings')">去设置 →</a>`
            : `<span class="ok">${ic('check')} ${esc(re.provider === 'zhipu' ? '智谱 CogView · CogVideoX' : '自定义端点')} · 密钥已配置</span>`}</div>
        </div>
      </div>
      ${usable.length ? '' : `<div class="cm-hint">${ic('triangle-alert')} 暂无可用编剧 Agent，<a href="javascript:void 0" onclick="closeModal();switchView('agents')">去接入 →</a>（需 API 模型）</div>`}
      <div class="set-banner" style="margin:2px 0 0">生成会消耗图像 / 视频 API 额度；配音为可选阶段，渲染引擎未配置配音模型时自动跳过。</div>
    </div>
    <div class="modal-foot">
      <a class="lnk" style="margin-right:auto;font-size:12px;cursor:pointer" href="javascript:void 0" onclick="cmCreate(false)">仅创建草稿</a>
      <button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="cmCreate(true)">${ic('play')} 创建并开始生成</button>
    </div>`);
  $('#modal').classList.add('cm-wide');
  setTimeout(() => $('#ncm-title')?.focus(), 60);
}
function cmSegHTML() {
  const items = [['9:16', '竖屏 9:16'], ['16:9', '横屏 16:9'], ['1:1', '方形 1:1']];
  return `<div class="cm-seg">${items.map(([v, l]) => `<button type="button" class="${v === ncmAspect ? 'on' : ''}" data-v="${v}" onclick="cmSegPick(this)"><i class="ratio r-${v.replace(':', '-')}"></i>${l}</button>`).join('')}</div>`;
}
function cmSegPick(btn) {
  ncmAspect = btn.dataset.v;
  btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
}
function cmStepHTML(id, val, lo, hi) {
  return `<div class="cm-step" data-lo="${lo}" data-hi="${hi}">
    <button type="button" onclick="cmStep('${id}',-1)" aria-label="减少">−</button><b id="${id}">${val}</b><button type="button" onclick="cmStep('${id}',1)" aria-label="增加">＋</button></div>`;
}
function cmStep(id, d) {
  const el = document.getElementById(id); const wrap = el?.closest('.cm-step'); if (!wrap) return;
  const v = Math.min(Number(wrap.dataset.hi), Math.max(Number(wrap.dataset.lo), Number(el.textContent) + d));
  el.textContent = v;
}
async function cmCreate(run) {
  const title = $('#ncm-title').value.trim();
  if (!title) { const el = $('#ncm-title'); el.style.borderColor = 'var(--red)'; el.focus(); return; }
  if (!window.reins) { toast('浏览器预览模式', '漫剧生成需要在桌面客户端中使用', '⚠'); return; }
  const r = await window.reins.comicCreate({
    title,
    theme: $('#ncm-theme').value.trim(),
    style: $('#ncm-style').value.trim(),
    aspect: ncmAspect,
    episodesPer: Number($('#ncm-eps').textContent) || 6,
    shotsPer: Number($('#ncm-shots').textContent) || 8,
    writerAgentId: $('#ncm-writer').value || '',
  });
  if (!r || !r.ok) { toast('创建失败', (r && r.error) || '未知错误', '⚠'); return; }
  S().comics.unshift(r.comic); syncComicTask(S(), r.comic); save();
  addActivity('🎬', '创建了漫剧「' + r.comic.title + '」');
  closeModal();
  openComicDetail(r.comic.id);
  if (run) cmRun(r.comic.id);
  else toast('已创建', '「' + esc(r.comic.title) + '」草稿已就绪', '🎬');
}

/* ============ 视图三：漫剧详情 ============ */
function openComicDetail(id) {
  if (!comicById(id)) return;
  curComicId = id;
  cmLogBuf = [];
  switchView('comic-detail');
}
function viewComicDetail() {
  const c = comicById(curComicId);
  if (!c) { curComicId = null; return viewComics(); }
  return cmHeadHTML(c) + cmStagebarHTML(c) + `<div class="cm-detail">
      <div class="cm-main">${cmEpListHTML(c)}</div>
      <div class="cm-side">${cmBibleHTML(c)}${cmLogHTML(c)}</div>
    </div>`;
}

/* —— 详情头（吸附）：状态 + 主操作 + 横贯进度条 ——
   data-sig 签名（返工修复②）：快速连续事件下头部/阶段轨内容未变时零 DOM 写入，
   不再每 120ms 重建一次按钮（悬停态丢失的根源） */
function cmHeadSig(c) {
  const p = c.progress || {};
  return [c.status, p.stage || '', p.pct ?? 0, p.note || ''].join('|');
}
function cmHeadHTML(c) {
  const st = CM_STATUS[c.status] || CM_STATUS.draft;
  const p = c.progress;
  const running = c.status === 'running';
  const note = running && p ? [p.note, p.pct + '%'].filter(Boolean).join(' · ')
    : (p && p.note && (c.status === 'paused' || c.status === 'failed') ? p.note : '');
  let acts = '';
  if (running) acts = `<button class="btn btn-danger" onclick="confirmCancelComic('${c.id}')">${ic('power')} 终止</button>`;
  else if (c.status === 'done') acts = `<button class="btn btn-o" onclick="confirmRerunComic('${c.id}')">${ic('refresh-cw')} 重新生成</button>`;
  else acts = `<button class="btn btn-p" onclick="cmRun('${c.id}')">${ic('play')} ${c.status === 'draft' ? '开始生成' : '继续生成'}</button>`;
  return `<div class="cm-head" id="cm-head" data-sig="${esc(cmHeadSig(c))}">
    <button class="cm-back" onclick="switchView('comics')" title="返回漫剧库">${ic('chevron-right')}</button>
    <div class="cm-head-main">
      <div class="cm-head-row"><b>${esc(c.title)}</b>
        <span class="cm-pill ${st.cls}"${c.status === 'failed' && p?.note ? ` title="${esc(p.note)}"` : ''}>${running ? '<span class="pulse"></span>' : ''}${st.label}</span></div>
      ${note ? `<span class="cm-head-note" title="${esc(note)}">${esc(note)}</span>` : ''}
    </div>
    <div class="cm-head-acts">${acts}
      <button class="cm-more ghost" title="更多操作" onclick="cmDetailMenu(this,'${c.id}')">${ic('more-horizontal')}</button>
    </div>
    ${running ? `<div class="prog doing cm-prog-line" role="progressbar" aria-valuenow="${p?.pct || 0}"><i style="width:${p?.pct || 0}%"></i></div>` : ''}
  </div>`;
}
function cmDetailMenu(btn, id) {
  cmMenu(btn, [
    { label: '重命名', fn: () => openComicRename(id) },
    { label: '复制项目', fn: () => cmDuplicate(id) },
    { label: '删除漫剧', danger: true, fn: () => confirmDeleteComic(id) },
  ]);
}

/* —— 阶段轨：完成度口径与引擎 _predicates 等价（产物在场即完成） —— */
function cmStageStats(c) {
  const eps = c.episodes || [];
  const shots = eps.flatMap(e => e.shots || []);
  const running = c.status === 'running';
  const st = c.progress?.stage || '';
  const voiceTotal = shots.filter(s => s.dialogue).length;   // 无台词镜头无需配音
  const mk = (meta, done, total, hasErr) => ({
    ...meta,
    done, total,
    state: done >= total && total > 0 ? 'done' : (running && st === meta.id) ? 'doing' : hasErr ? 'error' : 'todo',
  });
  const stats = [
    mk(CM_STAGES[0], c.bible && (c.bible.characters || []).length ? 1 : 0, 1,
      c.status === 'failed' && st === 'bible'),
    mk(CM_STAGES[1], eps.filter(e => (e.shots || []).length > 0).length, eps.length,
      c.status === 'failed' && st === 'script'),
    mk(CM_STAGES[2], eps.filter(e => (e.shots || []).length > 0 && e.shots.every(s => s.imagePrompt)).length, eps.length,
      c.status === 'failed' && st === 'storyboard'),
    mk(CM_STAGES[3], shots.filter(s => s.imageUrl).length, shots.length,
      shots.some(s => s.err && !s.imageUrl)),
    mk(CM_STAGES[4], shots.filter(s => s.videoUrl).length, shots.length,
      shots.some(s => s.err && s.imageUrl && !s.videoUrl)),
    mk(CM_STAGES[5], shots.filter(s => s.audioUrl).length, voiceTotal,
      shots.some(s => s.err && s.dialogue && !s.audioUrl)),
    mk(CM_STAGES[6], eps.filter(e => e.package).length, eps.length,
      c.status === 'failed' && st === 'assemble'),
  ];
  return stats;
}
function cmStagebarSig(c) { return cmStageStats(c).map(s => s.state + ':' + s.done + '/' + s.total).join(','); }
function cmStagebarHTML(c) {
  const stats = cmStageStats(c);
  return `<div class="cm-stagebar" id="cm-stagebar" data-sig="${esc(cmStagebarSig(c))}">${stats.map((s, i) => `
    <button class="cm-stage ${s.state}" title="${esc(s.label)}阶段：${s.total ? s.done + '/' + s.total + ' 完成' : '尚未开始'}${s.optional ? '（可选）' : ''}"
      aria-label="${esc(s.label)}阶段${s.total ? ' ' + s.done + '/' + s.total + ' 完成' : '未开始'}" onclick="cmStageMenu(this,'${c.id}','${s.id}')">
      <span class="dot">${s.state === 'done' ? ic('check') : s.state === 'error' ? '!' : s.state === 'doing' ? '<span class="pulse"></span>' : ''}</span>
      <span class="lbl">${s.label}${s.optional ? '<sup>可选</sup>' : ''}</span>
    </button>${i < stats.length - 1 ? `<span class="lnk${stats[i].state === 'done' ? ' done' : ''}"></span>` : ''}`).join('')}</div>`;
}
function cmStageMenu(btn, cid, stage) {
  const label = (CM_STAGES.find(s => s.id === stage) || {}).label || stage;
  cmMenu(btn, [{ label: '从此阶段重跑', fn: () => cmRerunStage(cid, stage) , danger: true}]);
}
function cmRerunStage(cid, stage) {
  const c = comicById(cid); if (!c) return;
  const label = (CM_STAGES.find(s => s.id === stage) || {}).label || stage;
  openModal(`<div class="modal-head"><h3>重跑「${label}」阶段</h3><span>${esc(c.title)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将强制重跑「<b style="color:var(--ink)">${label}</b>」阶段：该阶段已有产物会被覆盖或作废（重跑剧本会清空对应剧集的旧镜头与产物），并重新消耗 API 额度。继续？</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="closeModal();cmRun('${cid}',{stage:'${stage}'},true)">重跑</button></div>`);
}

/* —— 左栏：剧集列表 + 镜头网格 —— */
function cmEpListHTML(c) {
  return `<div class="panel cm-ep-list">${(c.episodes || []).map(ep => cmEpRowHTML(c, ep)).join('')}</div>`;
}
function cmEpRowHTML(c, ep) {
  const open = !!cmExpand[ep.id];
  return `<div class="cm-ep-row" data-ep="${ep.id}">
    ${cmEpHeadHTML(c, ep)}
    <div class="cm-ep-body" ${open ? '' : 'hidden'}>${cmShotgridHTML(c, ep)}</div>
  </div>`;
}
function cmEpHeadSig(c, ep) {
  const sh = ep.shots || [];
  return [ep.status, ep.err || '', ep.title || '', ep.synopsis || '', sh.length,
    sh.filter(s => s.videoUrl).length, ep.package ? 'p' : ''].join('|');
}
function cmEpHeadHTML(c, ep) {
  const label = `第 ${ep.n} 集` + (ep.title && ep.title !== `第 ${ep.n} 集` ? ' · ' + ep.title : '');
  const st = ep.status === 'done' ? CM_STATUS.done : ep.status === 'running' ? CM_STATUS.running
    : ep.status === 'failed' ? CM_STATUS.failed : CM_STATUS.draft;
  const n = (ep.shots || []).length;
  const dur = n ? ep.shots.reduce((s, x) => s + (x.duration || 0), 0) : 0;
  const meta = [n ? n + ' 镜头' : '未拆镜头', dur ? '约 ' + dur + 's' : '', ep.package ? '合成包就绪' : '', ep.err || '']
    .filter(Boolean).join(' · ');
  return `<div class="cm-ep-head" data-sig="${esc(cmEpHeadSig(c, ep))}" onclick="cmToggleEp('${ep.id}')">
    <span class="cm-caret${cmExpand[ep.id] ? ' open' : ''}">${ic('chevron-right')}</span>
    <div class="cm-ep-info">
      <b>${esc(label)}</b>
      ${ep.synopsis ? `<span class="syn">${esc(ep.synopsis)}</span>` : ''}
      ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
    </div>
    <span class="cm-pill ${st.cls}"${ep.status === 'failed' && ep.err ? ` title="${esc(ep.err)}"` : ''}>${ep.status === 'running' ? '<span class="pulse"></span>' : ''}${st.label}${ep.status === 'running' && n ? ' ' + Math.round(ep.shots.filter(s => s.videoUrl).length / n * 100) + '%' : ''}</span>
    <button class="cm-more" title="本集操作" onclick="event.stopPropagation();cmEpMenu(this,'${c.id}','${ep.id}')">${ic('more-horizontal')}</button>
  </div>`;
}
function cmToggleEp(id) {
  cmExpand[id] = !cmExpand[id];
  const row = document.querySelector(`.cm-ep-row[data-ep="${id}"]`); if (!row) return;
  row.querySelector('.cm-caret')?.classList.toggle('open', !!cmExpand[id]);
  const body = row.querySelector('.cm-ep-body'); if (body) body.hidden = !cmExpand[id];
}
function cmEpMenu(btn, cid, eid) {
  const c = comicById(cid); const ep = c && c.episodes.find(e => e.id === eid); if (!ep) return;
  cmMenu(btn, [
    { label: '重跑本集', fn: () => cmRerunEpisode(cid, eid) },
    ep.synopsis ? { label: '复制梗概', fn: () => navigator.clipboard?.writeText(ep.synopsis).then(() => toast('已复制', '第 ' + ep.n + ' 集梗概', '⧉')) } : null,
    ep.package ? { label: '导出本集合成包', fn: () => openComicPackage(cid, eid) } : null,
  ].filter(Boolean));
}
function cmRerunEpisode(cid, eid) {
  const c = comicById(cid); const ep = c && c.episodes.find(e => e.id === eid); if (!ep) return;
  openModal(`<div class="modal-head"><h3>重跑第 ${ep.n} 集</h3><span>${esc(c.title)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将重新生成第 ${ep.n} 集的剧本并重渲其全部镜头（旧镜头与产物一并作废），会重新消耗 API 额度。其他集不受影响。继续？</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="closeModal();cmRun('${cid}',{episodeId:'${eid}'},true)">重跑本集</button></div>`);
}
function cmShotgridHTML(c, ep) {
  if (!(ep.shots || []).length) return `<div class="cm-shot-empty">尚未拆分镜头。${c.status === 'running' ? '剧本与分镜生成后会自动填充。' : '开始生成后，编剧引擎将先产出剧本并拆分镜头。'}</div>`;
  return `<div class="cm-shotgrid">${ep.shots.map(s => `
    <div class="cm-shot${s.err ? ' err' : ''}" data-shot="${s.id}" onclick="openComicShot('${c.id}','${ep.id}','${s.id}')">${cmShotInner(c, ep, s)}</div>`).join('')}</div>`;
}
/* 判断镜头卡在哪个渲染阶段失败（重跑按钮定位用）：缺首帧→image，否则缺视频→video */
function cmShotFailedStage(s) { return !s.imageUrl ? 'image' : !s.videoUrl ? 'video' : 'voice'; }
/* —— 稳定层签名（REINS-126 返工修复②）——
   镜头卡拆 media / txt 两段渲染：media 段（<img>/角标/忙碌态）带签名，产物地址与
   忙碌态没变就绝不重建 <img>——此前每个事件批整卡 innerHTML 重建，封面反复重载
   闪烁；txt 段纯文本，签名无关、可整体替换（无重节点，代价可忽略） */
function cmShotBusy(c, s) {
  const stg = c.status === 'running' ? (c.progress?.stage || '') : '';
  return ['image', 'video', 'voice'].includes(stg) && !s.err
    && (stg === 'image' ? !s.imageUrl : stg === 'video' ? (s.imageUrl && !s.videoUrl) : (s.dialogue && !s.audioUrl))
    ? stg : '';
}
function cmShotMediaSig(c, s) {
  return [(s.coverUrl || s.imageUrl || ''), s.videoUrl ? 1 : 0, cmShotBusy(c, s), c.aspect].join('|');
}
function cmShotMediaHTML(c, s) {
  const stg = cmShotBusy(c, s);
  return `<div class="media" data-sig="${esc(cmShotMediaSig(c, s))}" style="aspect-ratio:${(c.aspect || '9:16').replace(':', '/')}">
      ${s.imageUrl ? `<img src="${esc(s.coverUrl || s.imageUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="ph">${ic('image')}</span>`}
      <span class="idx">#${s.index}</span>
      ${s.videoUrl ? `<span class="vico" title="视频已生成">${ic('film')}</span>` : ''}
      ${stg ? `<div class="busy"><span class="spin">${ic('refresh-cw')}</span><i>${({ image: '首帧生成中…', video: '视频生成中…', voice: '配音生成中…' })[stg]}</i></div>` : ''}
    </div>`;
}
function cmShotTxtHTML(c, ep, s) {
  const stg = c.status === 'running' ? (c.progress?.stage || '') : '';
  const mini = (name, done, doing) => `<span class="${done ? 'done' : doing ? 'doing' : 'off'}">${ic(name)}</span>`;
  return `<div class="txt">
      <span class="meta">${s.duration}s${s.camera ? ' · ' + esc(s.camera) : ''}</span>
      ${s.desc ? `<p>${esc(s.desc)}</p>` : ''}
      ${s.dialogue ? `<q>“${esc(s.dialogue)}”</q>` : ''}
      <div class="mini">
        ${mini('image', !!s.imageUrl, stg === 'image' && !s.imageUrl)}
        ${mini('film', !!s.videoUrl, stg === 'video' && !s.videoUrl)}
        ${s.dialogue ? mini('mic', !!s.audioUrl, stg === 'voice' && !s.audioUrl) : '<span class="off" title="无台词，无需配音">—</span>'}
      </div>
      ${s.err ? `<div class="shot-err">${ic('triangle-alert')}<span>${esc(s.err)}</span></div>
        <button class="btn btn-o btn-sm" onclick="event.stopPropagation();cmRunShot('${c.id}','${ep.id}','${s.id}','${cmShotFailedStage(s)}')">${ic('refresh-cw')} 重跑此镜头</button>` : ''}
    </div>`;
}
function cmShotInner(c, ep, s) { return cmShotMediaHTML(c, s) + cmShotTxtHTML(c, ep, s); }
function cmRunShot(cid, eid, sid, stage) { cmRun(cid, { episodeId: eid, shotId: sid, stage }); }

/* —— 镜头预览模态：大图 / 视频播放 + 提示词全文 + 单阶段重跑 —— */
function openComicShot(cid, eid, sid) {
  const c = comicById(cid); const ep = c && c.episodes.find(e => e.id === eid);
  const s = ep && ep.shots.find(x => x.id === sid); if (!s) return;
  cmShotCtx = { cid, eid, sid };
  const ar = (c.aspect || '9:16').replace(':', '/');
  const media = s.videoUrl
    ? `<video class="cm-shot-media" style="aspect-ratio:${ar}" src="${esc(s.videoUrl)}"${s.imageUrl ? ` poster="${esc(s.imageUrl)}"` : ''} controls autoplay playsinline></video>`
    : s.imageUrl
      ? `<img class="cm-shot-media" style="aspect-ratio:${ar}" src="${esc(s.imageUrl)}" alt="镜头 ${s.index} 首帧">`
      : `<div class="cm-shot-media empty">${ic('image')}<span>尚无首帧</span></div>`;
  const retry = c.status !== 'running' ? `
    <div class="cm-shot-retry">
      ${!s.imageUrl ? `<button class="btn btn-o btn-sm" onclick="closeModal();cmRunShot('${cid}','${eid}','${sid}','image')">${ic('refresh-cw')} 重跑首帧</button>` : ''}
      ${s.imageUrl && !s.videoUrl ? `<button class="btn btn-o btn-sm" onclick="closeModal();cmRunShot('${cid}','${eid}','${sid}','video')">${ic('refresh-cw')} 重跑视频</button>` : ''}
      ${s.dialogue && !s.audioUrl ? `<button class="btn btn-o btn-sm" onclick="closeModal();cmRunShot('${cid}','${eid}','${sid}','voice')">${ic('refresh-cw')} 重跑配音</button>` : ''}
    </div>` : '';
  openModal(`<div class="modal-head"><h3>镜头 #${s.index}</h3><span>第 ${ep.n} 集 · ${s.duration}s${s.camera ? ' · ' + esc(s.camera) : ''}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      ${media}
      ${s.dialogue ? `<div class="cm-shot-line">“${esc(s.dialogue)}”</div>` : ''}
      ${s.desc ? `<div class="cm-shot-desc">${esc(s.desc)}</div>` : ''}
      ${s.imagePrompt ? `<div class="f-row"><label>首帧提示词</label><div class="result-box cm-prompt">${esc(s.imagePrompt)}</div></div>` : ''}
      ${s.motionPrompt ? `<div class="f-row"><label>动态提示词</label><div class="result-box cm-prompt">${esc(s.motionPrompt)}</div></div>` : ''}
      ${s.err ? `<div class="cm-shot-err">${ic('triangle-alert')}<span>${esc(s.err)}</span></div>` : ''}
      ${retry}
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="copyShotPrompts()">复制提示词</button>
      <button class="btn btn-p" onclick="closeModal()">关闭</button></div>`);
}
function copyShotPrompts() {
  if (!cmShotCtx) return;
  const c = comicById(cmShotCtx.cid); const ep = c && c.episodes.find(e => e.id === cmShotCtx.eid);
  const s = ep && ep.shots.find(x => x.id === cmShotCtx.sid); if (!s) return;
  const txt = [
    s.imagePrompt ? '【首帧】\n' + s.imagePrompt : '',
    s.motionPrompt ? '【动态】\n' + s.motionPrompt : '',
  ].filter(Boolean).join('\n\n');
  if (!txt) { toast('无提示词', '该镜头尚未生成分镜提示词', '⚠'); return; }
  navigator.clipboard?.writeText(txt).then(
    () => toast('已复制', '镜头 #' + s.index + ' 的提示词', '⧉'),
    () => toast('复制失败', '当前环境未授权剪贴板', '⚠'));
}

/* —— 右栏：设定卡 + 运行日志 —— */
function cmBibleHTML(c) {
  const b = c.bible;
  const body = !b || !(b.characters || []).length
    ? `<div class="cm-bible-empty">${ic('clapperboard')}<p>尚无设定。开始生成后，编剧引擎将先产出世界观与角色。</p></div>`
    : `${b.logline ? `<p class="logline">${esc(b.logline)}</p>` : ''}
      ${b.style ? `<div class="cm-chips">${b.style.split(/[,，、;；\s]+/).filter(Boolean).map(x => `<span class="cm-chip">${esc(x)}</span>`).join('')}</div>` : ''}
      ${(b.characters || []).map(ch => `<div class="cm-char">
        <div><b>${esc(ch.name)}</b><span class="role${/反派/.test(ch.role) ? ' villain' : /主角/.test(ch.role) ? ' lead' : ''}">${esc(ch.role || '配角')}</span></div>
        <p>${esc(ch.look || '')}${ch.voice ? `<span class="voice">${ic('mic')} ${esc(ch.voice)}</span>` : ''}</p>
      </div>`).join('')}
      ${(b.scenes || []).length ? `<div class="cm-chips neutral">${b.scenes.map(s => `<span class="cm-chip" title="${esc(s.look || '')}">${esc(s.name)}</span>`).join('')}</div>` : ''}`;
  return `<div class="panel cm-bible">
    <div class="cm-panel-head">${ic('book-open')}<b>世界观设定</b>
      <button class="btn btn-o btn-sm" style="margin-left:auto" onclick="cmRerunStage('${c.id}','bible')" title="强制重新生成设定">${ic('refresh-cw')} 重生成</button></div>
    ${body}</div>`;
}
function cmLogRowHTML(cls, text, key) {
  return `<div class="cm-log-row ${cls || ''}"${key ? ` data-key="${esc(key)}"` : ''}>${esc(text)}</div>`;
}
function cmLogHTML(c) {
  if (!cmLogBuf.length && c.status !== 'running') return '';
  return `<div class="panel cm-log" id="cm-log-panel">
    <div class="cm-panel-head">${ic('list')}<b>运行日志</b>
      <button class="cm-log-clear" title="清屏" onclick="cmLogClear()">${ic('trash-2')}</button></div>
    <div class="cm-log-body" id="cm-log-body">${cmLogBuf.map(([cls, t, k]) => cmLogRowHTML(cls, t, k)).join('')}</div>
  </div>`;
}
/* 批量落日志（REINS-126 返工修复②）：一批事件只做一次 DOM 插入与一次滚动。
   此前批内 N 条 stage/note = N 次 insertAdjacentHTML + N 次强制回流；
   同 key 的流式增量仍并进最后一行（保留原 delta 合并语义） */
function cmLogAppendMany(rows) {
  if (!rows || !rows.length) return;
  const body = $('#cm-log-body');
  let html = '';
  for (const row of rows) {
    const [cls, text, key] = row;
    if (key) {
      const last = cmLogBuf[cmLogBuf.length - 1];
      if (last && last[2] === key) {   // 流式行：同 key 的增量并进最后一行，避免逐 token 换行
        last[1] += text;
        if (body) { const el = body.querySelector(`[data-key="${CSS.escape(key)}"]`); if (el) el.textContent = last[1]; }
        continue;
      }
    }
    cmLogBuf.push([cls, text, key]);
    html += cmLogRowHTML(cls, text, key);
  }
  if (cmLogBuf.length > 400) cmLogBuf.splice(0, cmLogBuf.length - 400);
  if (body && html) { body.insertAdjacentHTML('beforeend', html); body.scrollTop = body.scrollHeight; }
}
function cmLogAppend(cls, text, key) { cmLogAppendMany([[cls, text, key]]); }
function cmLogClear() { cmLogBuf = []; const b = $('#cm-log-body'); if (b) b.innerHTML = ''; }

/* ============ 合成包导出（模态） ============ */
async function openComicPackage(cid, eid) {
  const c = comicById(cid); const ep = c && c.episodes.find(e => e.id === eid); let pkg = ep && ep.package;
  if (!pkg) return;
  /* 导出前按当前镜头数据重建合成包（REINS-126 返工修复）：单镜头重跑/重生成后
     不再拿到旧包——旧包的 ffmpeg concat 清单与分镜表会缺失已补齐的镜头 */
  if (window.reins && window.reins.comicPackage && ep.shots && ep.shots.length) {
    try {
      const r = await window.reins.comicPackage(c, eid);
      if (r && r.ok && r.package) { ep.package = pkg = r.package; save(); }
    } catch (e) { /* 重建失败回退存量包，不阻塞导出 */ }
  }
  cmPackCtx = { title: c.title, n: ep.n, srt: pkg.srt || '', sh: pkg.ffmpegSh || '', md: pkg.shotlistMd || '' };
  const dl = (kind, label, fn) => `<button class="btn btn-o btn-sm" onclick="${fn}">${label}</button>`;
  openModal(`<div class="modal-head"><h3>第 ${ep.n} 集 · 合成包</h3>
      <span>${(ep.shots || []).length} 镜头 · 约 ${pkg.durationSec}s${pkg.missing ? ` · <b style="color:var(--red)">缺 ${pkg.missing} 个镜头视频</b>` : ' · 全镜头就绪'}</span>
      <button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="cm-pkg-sec">
        <div class="cm-pkg-h"><b>字幕 ep.srt</b><span>按镜头时长切分的 SRT</span>
          ${dl('', '复制', 'cmPackCopy(\'srt\')')}${dl('', '下载 .srt', 'cmPackDownload(\'srt\')')}</div>
        <pre class="cm-pkg-pre">${esc(pkg.srt ? pkg.srt.split('\n').slice(0, 12).join('\n') + (pkg.srt.split('\n').length > 12 ? '\n…' : '') : '（本集无台词，字幕为空）')}</pre>
      </div>
      <div class="cm-pkg-sec">
        <div class="cm-pkg-h"><b>合成脚本 ffmpeg.sh</b><span>下载后放同目录执行：下载镜头、拼接、烧字幕、混配音</span>
          ${dl('', '复制', 'cmPackCopy(\'sh\')')}${dl('', '下载 .sh', 'cmPackDownload(\'sh\')')}</div>
        <pre class="cm-pkg-pre">${esc(pkg.ffmpegSh.split('\n').slice(0, 10).join('\n'))}\n…</pre>
      </div>
      <div class="cm-pkg-sec" style="margin-bottom:0">
        <div class="cm-pkg-h"><b>分镜表 shotlist.md</b><span>镜头/台词/景别/时长一览</span>
          ${dl('', '复制', 'cmPackCopy(\'md\')')}${dl('', '下载 .md', 'cmPackDownload(\'md\')')}</div>
        <div class="result-box cm-pkg-md">${mdToHtml(pkg.shotlistMd)}</div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-p" onclick="closeModal()">关闭</button></div>`);
  $('#modal').classList.add('cm-xwide');
}
function cmPackText(which) {
  const p = cmPackCtx || {};
  return which === 'srt' ? p.srt : which === 'sh' ? p.sh : p.md;
}
function cmPackCopy(which) {
  const txt = cmPackText(which);
  navigator.clipboard?.writeText(txt).then(
    () => toast('已复制', which === 'srt' ? 'SRT 字幕' : which === 'sh' ? 'ffmpeg 脚本' : '分镜表', '⧉'),
    () => toast('复制失败', '当前环境未授权剪贴板', '⚠'));
}
function cmPackDownload(which) {
  const p = cmPackCtx || {};
  const ext = which === 'srt' ? 'srt' : which === 'sh' ? 'sh' : 'md';
  const mime = which === 'srt' ? 'text/plain' : which === 'sh' ? 'text/x-shellscript' : 'text/markdown';
  const name = `${String(p.title || '漫剧').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)}-第${p.n || 1}集.ep.${ext}`;
  const blob = new Blob([cmPackText(which) || ''], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已下载', name, '⇩');
}

/* ============ 任务启动 / 终止 / 事件应用 ============ */
function cmRun(cid, scope = {}, force = false) {
  const c = comicById(cid); if (!c) return;
  if (!window.reins) { toast('浏览器预览模式', '漫剧生成需要在桌面客户端中使用', '⚠'); return; }
  if (c.status === 'running') { toast('执行中', '该漫剧正在生成，请先终止或等待完成', '⚠'); return; }
  const agent = c.writerAgentId ? agentById(c.writerAgentId) : null;
  const payload = { comic: c, scope: force ? { ...scope, force: true } : scope };
  if (agent && agent.mode === 'api') payload.writerAgent = agent;
  window.reins.comicStart(payload).then(r => {
    if (!r || !r.ok) {
      const msg = (r && r.error) || '未知错误';
      /* 预检缺口（返工③）：主进程逐字段错误全文在 toast 里放不下也不可行动，
         改为模态展示 + 直达「设置 → 渲染引擎」配置入口 */
      if (/渲染引擎/.test(msg)) cmStartFail(msg);
      else toast('无法启动', msg, '⚠');
      render(); return;
    }
    c.status = 'running';
    c.progress = { stage: scope.stage || '', pct: c.progress?.pct || 0, note: scope.stage ? '启动中…' : '从断点续跑…' };
    cmSeqSeen[c.id] = 0;
    cmLogBuf = [];
    save();
    if (curView === 'comic-detail' && curComicId === c.id) render();
    else renderNav();
  }).catch(() => toast('无法启动', '主进程不可用', '⚠'));
}
function confirmCancelComic(cid) {
  const c = comicById(cid); if (!c) return;
  openModal(`<div class="modal-head"><h3>终止生成</h3><span>${esc(c.title)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">终止后已完成的设定、剧本与镜头产物全部保留；再次「继续生成」会从断点续跑，不重复消耗额度。正在渲染中的镜头会回到待执行状态。</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">继续生成</button>
      <button class="btn btn-danger" onclick="cmCancel('${cid}')">终止</button></div>`);
}
async function cmCancel(cid) {
  closeModal();
  if (window.reins) { try { await window.reins.comicCancel(cid); } catch (e) { } }
  // 状态翻转等 cancelled 事件回传；此处延迟对账兜底（事件丢失时也能恢复可操作态）
  setTimeout(() => {
    const c = comicById(cid);
    if (c && c.status === 'running' && window.reins) {
      window.reins.comicSnapshot(cid).then(s => {
        if (!s || !s.running) { c.status = 'paused'; save(); render(); }
      }).catch(() => { });
    }
  }, 1000);
}
function confirmRerunComic(cid) {
  const c = comicById(cid); if (!c) return;
  openModal(`<div class="modal-head"><h3>重新生成</h3><span>${esc(c.title)}</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div style="font-size:13px;color:var(--ink-dim)">将强制重跑全部阶段（设定、剧本、分镜与全部镜头渲染），已有产物会被覆盖，并重新消耗 API 额度。继续？</div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="closeModal();cmRun('${cid}',{},true)">全部重跑</button></div>`);
}

/* 启动预检失败弹层（REINS-126 返工修复③）：渲染引擎缺口的长文案改为模态承载——
   错误全文不截断（toast 放不下），并给「去配置渲染引擎」直达入口一步到位 */
function cmStartFail(msg) {
  openModal(`<div class="modal-head"><h3>无法启动生成</h3><span>渲染引擎预检未通过</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body"><div class="cm-start-err">${ic('triangle-alert')}<div>${esc(msg)}</div></div></div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">知道了</button>
      <button class="btn btn-p" onclick="closeModal();switchView('settings');setTimeout(openRenderEngineModal,60)">去配置渲染引擎</button></div>`);
}

/* 主进程事件 → 渲染层增量应用（seq 递增，乱序丢弃）。
   主进程按窗口把事件打包成 {type:'batch', events:[...]} 单条推送（终态立即冲刷）：
   这里一次 IPC 只做一次落盘（REINS-126 返工修复）。
   返工修复②（快速连续事件 DOM 稳定性）：批与批可能背靠背到达（120ms 窗口帧 +
   终态冲刷），此前每批同步直写 DOM —— 每秒最多 ~8 轮 outerHTML 重建，悬停态丢失、
   封面 <img> 反复重载闪烁、同帧多次强制回流。现在数据应用仍在批内即时完成
   （seq / 落盘语义不变），DOM 收尾合并进同一动画帧：同帧多批 → 脏集合去重一次写入；
   头部 / 阶段轨 / 集头 / 镜头 media 均带签名，内容未变零 DOM；库视图按卡定向刷新 */
let cmSaveTimer = null;
function cmSaveSoon() {
  if (cmSaveTimer) return;   // 节流：窗口内的多次事件合并进同一次 pending 落盘（触发时序列化的是最新 state）
  cmSaveTimer = setTimeout(() => { cmSaveTimer = null; save(); }, 250);
}
window.addEventListener('beforeunload', () => { if (cmSaveTimer) { clearTimeout(cmSaveTimer); cmSaveTimer = null; save(); } });

/* —— DOM 收尾合帧调度器：脏集合 + 单 rAF 冲刷 —— */
const cmDirtyNew = () => ({ cid: null, full: false, cards: new Set(), eps: new Set(), shots: new Set() });
let cmDom = cmDirtyNew();
let cmRaf = 0;
function cmMark(mark) {
  if (mark.cid) cmDom.cid = mark.cid;
  if (mark.full) cmDom.full = true;
  if (mark.cards) for (const x of mark.cards) cmDom.cards.add(x);
  if (mark.eps) for (const x of mark.eps) cmDom.eps.add(x);
  if (mark.shots) for (const x of mark.shots) cmDom.shots.add(x);
  if (!cmRaf) cmRaf = requestAnimationFrame(cmFlushDom);
}
function cmFlushDom() {
  cmRaf = 0;
  const d = cmDom; cmDom = cmDirtyNew();   // 先取走再重置：冲刷期间新到的事件重新排队到下一帧
  if (d.full) { render(); return; }        // 结构性变化（设定首产/日志面板缺位/卡片增删）整页重渲
  if (curView === 'comics') { for (const id of d.cards) { const c = comicById(id); if (c) cmSyncCard(c); } return; }
  if (curView !== 'comic-detail' || !d.cid) return;
  const c = comicById(d.cid); if (!c || c.id !== curComicId) return;
  const head = $('#cm-head'), bar = $('#cm-stagebar');
  if (head && head.dataset.sig !== cmHeadSig(c)) head.outerHTML = cmHeadHTML(c);
  if (bar && bar.dataset.sig !== cmStagebarSig(c)) bar.outerHTML = cmStagebarHTML(c);
  for (const epId of d.eps) cmSyncEp(c, epId);
  for (const sk of d.shots) { const i = sk.indexOf('\u0000'); if (i > 0) cmSyncShot(c, sk.slice(0, i), sk.slice(i + 1)); }
}
function handleComicEvent(frame) {
  const list = frame && frame.type === 'batch' && Array.isArray(frame.events) ? frame.events : [frame];
  const first = list.find(e => e && e.comicId);
  const c = first && comicById(first.comicId); if (!c) return;
  const statusBefore = c.status;
  const viewing = curView === 'comic-detail' && curComicId === c.id;
  const epOf = id => (c.episodes || []).find(e => e.id === id);
  const epName = ep => ep ? `第 ${ep.n} 集` : '';
  const pendLog = [];                                        // 批内日志先攒后一次落（返工修复②）
  const log = (...a) => { if (viewing) pendLog.push(a); };
  /* 批内聚合提示：每集/每镜头只保留最后一次补丁事件，收尾时定向刷新一次 */
  const epEvts = new Map(), shotEvts = new Map();
  let bibleArrived = false, terminal = false, curStage = '';
  for (const evt of list) {
    if (!evt || !evt.type) continue;
    if (evt.seq) { if (evt.seq <= (cmSeqSeen[c.id] || 0)) continue; cmSeqSeen[c.id] = evt.seq; }
    if (evt.stage) curStage = (CM_STAGES.find(s => s.id === evt.stage) || {}).label || '';
    switch (evt.type) {
      case 'comic':
        Object.assign(c, evt.patch);
        if (evt.patch && evt.patch.bible) bibleArrived = true;
        break;
      case 'episode': {
        const ep = epOf(evt.episodeId); if (ep) Object.assign(ep, evt.patch);
        epEvts.set(evt.episodeId, evt);
        break;
      }
      case 'shot': {
        const ep = epOf(evt.episodeId); const s = ep && ep.shots.find(x => x.id === evt.shotId);
        if (s) Object.assign(s, evt.patch);
        shotEvts.set(evt.episodeId + ':' + evt.shotId, evt);
        if (!epEvts.has(evt.episodeId)) epEvts.set(evt.episodeId, { episodeId: evt.episodeId });   // 镜头变化也带动集头进度刷新
        break;
      }
      case 'stage':
        log('dim', `[${curStage}] ${evt.episodeId ? epName(epOf(evt.episodeId)) + ' · ' : ''}${evt.state === 'start' ? '开始' + (evt.count ? ' · ' + evt.count + ' 个镜头' : '') : '完成'}`);
        break;
      case 'delta': log('', evt.text, evt.stage + ':' + (evt.episodeId || '')); break;
      case 'note':
        log(/^✕/.test(evt.text) ? 'bad' : /^✓/.test(evt.text) ? 'ok' : 'dim',
          (evt.episodeId ? epName(epOf(evt.episodeId)) + ' ' : '') + evt.text);
        break;
      case 'error':
        toast('漫剧执行失败', String(evt.message).slice(0, 90), '⚠');
        log('bad', '✕ ' + (curStage ? `[${curStage}] ` : '') + evt.message);
        terminal = true;
        break;
      case 'done': {
        const s = evt.summary || {};
        const m = Math.floor((s.elapsedMs || 0) / 60000), sec = Math.round((s.elapsedMs || 0) % 60000 / 1000);
        log('ok', `完成：${s.episodes || 0} 集 · ${s.shots || 0} 镜头${(s.failed || []).length ? ` · ${s.failed.length} 个镜头待重跑` : ''} · ${m}分${sec}秒`);
        toast('漫剧完成', `${c.title} · ${s.shots || 0} 个镜头${(s.failed || []).length ? '，' + s.failed.length + ' 个待重跑' : ''}`, '🎬');
        addActivity('🎬', `漫剧「${c.title}」生成完成（${s.episodes || 0} 集 / ${s.shots || 0} 镜头）`);
        terminal = true;
        break;
      }
      case 'cancelled': log('dim', '■ 已终止，已完成阶段保留，可续跑'); terminal = true; break;
    }
  }
  cmLogAppendMany(pendLog);   // 一批事件一次日志 DOM 插入（返工修复②）
  syncComicTask(S(), c);   // 漫剧状态 → 联动任务卡（看板列随事件流动）
  if (terminal) save(); else cmSaveSoon();   // 终态立即落盘；过程态走节流
  /* —— UI 收尾：状态翻转才重渲侧栏（角标）；DOM 变化合帧定向应用 —— */
  if (statusBefore !== c.status) {
    renderNav();
    if (curView === 'comics') { render(); return; }   // 状态翻转低频（每轮 ≤2 次）：整渲一次让库头「N 部生成中」计数归真
  }
  if (curView === 'comics') { cmMark({ cards: [c.id] }); return; }   // 库视图：只定向刷新该卡
  if (!viewing) return;
  /* 结构性变化走整页重渲（设定首产 / 日志面板缺位）；其余定向更新合并到同一帧 */
  if (bibleArrived || (!$('#cm-log-panel') && (c.status === 'running' || cmLogBuf.length))) {
    cmMark({ full: true, cid: c.id }); return;
  }
  cmMark({ cid: c.id, eps: [...epEvts.keys()], shots: [...shotEvts.keys()].map(k => k.replace(':', '\u0000')) });
}
/* 剧集镜头序列签名：重跑剧本产出同数量全新镜头时，数量比对看不出变化、
   ID 序列比对能（返工修复②：网格不再停留在过期镜头上） */
function cmEpShotSig(ep) { return (ep.shots || []).map(s => s.id).join(','); }
function cmSyncEp(c, epId) {
  const ep = (c.episodes || []).find(e => e.id === epId); if (!ep) return;
  const row = document.querySelector(`.cm-ep-row[data-ep="${epId}"]`); if (!row) return;
  const head = row.querySelector('.cm-ep-head');
  if (head && head.dataset.sig !== cmEpHeadSig(c, ep)) head.outerHTML = cmEpHeadHTML(c, ep);
  const body = row.querySelector('.cm-ep-body');
  if (body) {
    const sig = cmEpShotSig(ep);
    if (body.dataset.shots !== sig) { body.innerHTML = cmShotgridHTML(c, ep); body.dataset.shots = sig; }
  }
}
function cmSyncShot(c, epId, shotId) {
  const ep = (c.episodes || []).find(e => e.id === epId);
  const s = ep && ep.shots.find(x => x.id === shotId);
  const card = document.querySelector(`.cm-ep-row[data-ep="${epId}"] .cm-shot[data-shot="${shotId}"]`);
  if (!card || !s) { cmSyncEp(c, epId); return; }
  const media = card.querySelector(':scope > .media'), txt = card.querySelector(':scope > .txt');
  if (!media || !txt) { card.innerHTML = cmShotInner(c, ep, s); }   // 结构不符（旧 DOM/异常）兜底整卡重建
  else {
    if (media.dataset.sig !== cmShotMediaSig(c, s)) media.outerHTML = cmShotMediaHTML(c, s);   // 产物/忙碌态变化才碰 <img>
    txt.innerHTML = cmShotTxtHTML(c, ep, s);                                                  // 文本段无重节点，直接换
  }
  card.classList.toggle('err', !!s.err);
}

/* 应用重启 / 页面重载后的对账：running 档要么接上主进程活任务，要么收养为 paused */
async function hydrateComics() {
  if (!window.reins || !window.reins.comicSnapshot) return;
  let dirty = false;
  for (const org of state.orgs) for (const sp of org.spaces) {
    for (const c of (sp.comics || [])) {
      if (c.status !== 'running') continue;
      try {
        const snap = await window.reins.comicSnapshot(c.id);
        if (snap && snap.running && snap.comic) Object.assign(c, snap.comic);   // 活任务：以主进程副本为准
        else { const a = await window.reins.comicAdopt(c); if (a) Object.assign(c, a); }
        syncComicTask(sp, c);   // 对账后同步联动任务卡列位
        dirty = true;
      } catch (e) { }
    }
  }
  if (dirty) {
    save();
    if (curView === 'comics' || curView === 'comic-detail') render();
    renderNav();
  }
}

/* —— 看板融合（AC-5）：每个漫剧挂一张联动任务卡（task.linkComicId 双向定位） ——
   漫剧状态单向同步任务状态（done→待验收，验收=原生拖拽到已归档）；
   已归档的任务不被回流，除非漫剧重新启动生成；联动卡不触发 Agent 自动执行。 */
const COMIC_TASK_ST = { draft: 'todo', running: 'doing', paused: 'todo', failed: 'todo', done: 'review' };
function syncComicTask(sp, c) {
  if (!sp || !c) return;
  const t = (sp.tasks || []).find(x => x.linkComicId === c.id);
  if (!t) {
    sp.tasks.push({
      id: 't' + sp.seq, key: 'REINS-' + sp.seq, linkComicId: c.id,
      title: '漫剧 · ' + c.title, type: 'comic', pri: 'P1',
      desc: c.theme || '', status: COMIC_TASK_ST[c.status] || 'todo', assignee: null, tags: [],
      pr: null, result: null, thread: [], attachPrompt: null, comments: [], repoRoot: '',
      runModel: '', createdAt: now(), doneAt: null,
    });
    sp.seq++;
    return;
  }
  t.title = '漫剧 · ' + c.title;                                        // 重命名跟随
  if (t.status === 'done' && c.status !== 'running') return;            // 已验收归档：不被回流
  const want = COMIC_TASK_ST[c.status] || 'todo';
  if (t.status !== want) t.status = want;
}

/* —— 开放集成：任务事件推送到用户配置的 Webhook（桌面客户端内由主进程发送） —— */
let hookCfg = { webhookUrl: '', webhookEvents: { create: true, done: true, reject: true }, jevUrl: 'https://api.typesafe.ai/v1/systemone', jevKey: '', jevModel: 'jev-latest', triageEngine: 'auto' };
function notifyHook(event, task) {
  if (!window.reins || !hookCfg.webhookUrl) return;
  const key = event.split('.')[1];
  if (hookCfg.webhookEvents && hookCfg.webhookEvents[key] === false) return;
  window.reins.webhookSend({
    event, at: new Date().toISOString(), space: S().name,
    task: { key: task.key, title: task.title, status: task.status, pri: task.pri, deliver: task.pr || null },
  }).then(r => { if (!r.ok) toast('Webhook 推送失败', r.error || ('HTTP ' + r.status), '⚠'); }).catch(() => { });
}

/* —— 侧栏折叠（窄栏图标模式，⌘B） —— */
function toggleSidebar(force) {
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
  return (O().agents || []).find(a => a.mode === 'api' && a.apiKey) || null;
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
    members: memberNames(),
  };
  /* 引擎链：Jev 决策模型（结构化判断+概率，百毫秒级）→ API 模型 → 本地规则，逐级降级并如实标注 */
  let jevFail = '';
  if (window.reins && hookCfg.jevKey && (hookCfg.triageEngine || 'auto') !== 'llm') {
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
function applyTriage(id, s, quiet) {
  const t = byId(id);
  const before = TYPE_LABEL[t.type] + '·' + t.pri;
  if (s.type) t.type = s.type;
  if (s.pri) t.pri = s.pri;
  if (s.assignee) {
    if (s.assignee.kind === 'agent') {
      const a = (O().agents || []).find(x => x.id === s.assignee.id) || (O().agents || []).find(x => x.name === s.assignee.name);
      if (a) t.assignee = { kind: 'agent', id: a.id, name: a.name };
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
function closeModal() { $('#modal-mask').classList.remove('show'); $('#modal').classList.remove('cm-wide', 'cm-xwide'); }
$('#modal-mask')?.addEventListener('click', e => { if (e.target.id === 'modal-mask') closeModal(); });

function openNewTaskModal() {
  const assigneeOpts = [{ v: '', l: '暂不指派' },
    ...memberNames().map(m => ({ v: 'm:' + m, l: m })),
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
      <div class="f-row" id="nt-model-row" style="display:none"><label>执行模型</label>${ds('nt-model', [{ v: '', l: '默认模型' }, ...CB_MODELS.map(m => ({ v: m, l: m }))], '')}</div>
      ${(S().repos || []).length || S().repoRoot ? `<div class="f-row"><label>代码仓库（CLI 任务在其隔离工作区执行）</label>${ds('nt-repo', repoOpts(''), '')}</div>` : ''}
    </div>
    <div class="modal-foot"><button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="createTask()">创建任务</button></div>`);
  setTimeout(() => { $('#nt-title')?.focus(); ntSyncModel(); }, 60);
}
/* 经办人换成支持选模型的 CLI Agent（codebuddy/workbuddy）时，露出执行模型下拉 */
function ntSyncModel() {
  const av = $('#nt-assignee')?.value || '';
  const a = av.startsWith('a:') ? agentById(av.slice(2)) : null;
  const row = $('#nt-model-row');
  if (row) row.style.display = a && a.mode === 'cli' && CLI_CAN_MODEL.includes(a.cliId) ? '' : 'none';
}
function createTask() {
  const title = $('#nt-title').value.trim();
  if (!title) { $('#nt-title').style.borderColor = 'var(--red)'; $('#nt-title').focus(); return; }
  const t = {
    id: 't' + S().seq, key: 'REINS-' + S().seq,
    title, type: $('#nt-type').value, pri: $('#nt-pri').value,
    desc: $('#nt-desc').value.trim(), status: 'todo', assignee: null, tags: [], pr: null,
    result: null, thread: [], attachPrompt: null, comments: [], repoRoot: $('#nt-repo')?.value || '',
    runModel: $('#nt-model')?.value || '',
    createdAt: now(), doneAt: null,
  };
  const av = $('#nt-assignee').value;
  if (av.startsWith('m:')) t.assignee = { kind: 'human', name: av.slice(2) };
  else if (av.startsWith('a:')) { const a = agentById(av.slice(2)); t.assignee = { kind: 'agent', id: a.id, name: a.name }; }
  S().tasks.push(t); S().seq++;
  th(t, '➕', '创建了任务');
  addActivity('➕', '创建了 ' + t.key + ' ' + t.title);
  const auto = $('#nt-auto').checked && t.assignee?.kind === 'agent';
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
      ${['codebuddy', 'workbuddy'].includes(a.cliId) ? `<div class="f-row"><label>执行模型（留空用 CLI 默认）</label><input type="text" id="ac-climodel" list="climodel-list" value="${esc(a.cliModel || '')}" placeholder="例如 glm-5.3-flash">
      <datalist id="climodel-list">${['hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'space-bunny', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3-pay', 'minimax-m2.7', 'kimi-k3-2', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'].map(m => `<option value="${m}">`).join('')}</datalist></div>` : ''}`
    : `
      <div class="f-2col">
        <div class="f-row"><label>服务商（OpenAI 兼容）</label>${ds('ac-provider', provOpts, a.provider, 'acProviderChanged()')}</div>
        <div class="f-row"><label>模型</label><input type="text" id="ac-model" value="${esc(a.model || '')}" placeholder="例如 glm-4.7"></div>
      </div>
      <div class="f-row"><label>Base URL</label><input type="text" id="ac-baseurl" value="${esc(a.baseURL || '')}" placeholder="选服务商后自动填入"></div>
      <div class="f-row"><label>API Key（仅保存在本机）</label><input type="password" id="ac-key" value="${esc(a.apiKey || '')}" placeholder="sk-…" autocomplete="off"></div>`;
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
    a.cliCommand = $('#ac-cmd')?.value.trim() || a.cliCommand;
    a.cliTemplate = $('#ac-tpl')?.value.trim() || a.cliTemplate;
    a.runtime = $('#ac-runtime')?.value || 'local';
    if ($('#ac-climodel')) a.cliModel = $('#ac-climodel').value.trim();
  } else if (a.mode === 'api') {
    a.provider = $('#ac-provider')?.value || a.provider;
    a.baseURL = $('#ac-baseurl')?.value.trim() || '';
    a.model = $('#ac-model')?.value.trim() || '';
    a.apiKey = $('#ac-key')?.value.trim() || '';
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
      r = det[a.cliCommand] ? { ok: true, message: a.cliCommand + ' 已安装，可执行' } : { ok: false, message: a.cliCommand + ' 未在本机 PATH 中找到' };
    } else {
      r = window.reins ? await window.reins.agentTest(a) : { ok: false, message: '浏览器模式无法测试' };
    }
    if (btn) { btn.disabled = false; btn.textContent = a.mode === 'cli' ? '试运行' : '测试连接'; }
    toast(r.ok ? '连接成功' : '连接失败', esc(r.message || ''), r.ok ? '✓' : '⚠');
  })();
}
function acSave(id) {
  const a = acCollect(id);
  if (a.mode === 'api' && a.apiKey && a.status === 'offline') a.status = 'idle';
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
        st.textContent = found[p.cmd] ? '✓ 已安装 · 接入' : '未安装 · 仍可接入';
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
      <div class="panel" id="agents-cfg-panel" style="margin-bottom:14px"><h3 class="set-h" style="margin-top:0">模型与密钥</h3><div id="agents-cfg">载入中…</div><div id="re-cfg"></div></div>
      <div id="set-panel" class="panel">载入中…</div>
    </div>`;
}
function renderAgentsCfg() {
  const box = document.getElementById('agents-cfg'); if (!box) return;
  box.innerHTML = O().agents.map(a => {
    const ok = a.mode === 'sim' || !!a.apiKey;
    return `<div class="set-row">
      <div><b>${brandOf(a)} ${esc(a.name)} ${a.mode === 'api' ? '<span class="mode-pill api">真实 API</span>' : '<span class="mode-pill sim">演示</span>'}</b>
        <div class="set-desc">${a.mode === 'api' ? esc(providerLabel(a.provider)) + ' · ' + esc(a.model || '—') + ' · ' + (a.apiKey ? '密钥已配置' : '<b style="color:#c05656">密钥未配置</b>') : '本地模拟执行，无需密钥'}</div></div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        ${a.mode === 'api' ? `<button class="btn btn-o btn-sm" onclick="openAgentConfig('${a.id}')">${ok ? '配置' : '去配置'}</button>` : ''}
      </div>
    </div>`;
  }).join('');
}
async function hydrateSettings() {
  renderAgentsCfg();
  hydrateRenderEngineCfg();
  const box = document.getElementById('set-panel'); if (!box) return;
  let s = null;
  if (window.reins) { try { s = await window.reins.getSettings(); } catch (e) { } }
  if (!s) {
    box.innerHTML = `<div class="set-banner">当前在浏览器中运行：执行引擎仅演示模式，客户端设置项在 <b>Reins 桌面客户端</b> 内生效。</div>`
      + settingsHTML({ launchAtLogin: false, keepInTray: true }, false);
    return;
  }
  box.innerHTML = settingsHTML(s, true);
}
function settingsHTML(s, live) {
  const row = (id, label, desc, on) => `<div class="set-row"><div><b>${label}</b><div class="set-desc">${desc}</div></div>
    <label class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${live ? '' : 'disabled'} onchange="setClient('${id}',this.checked)"><i></i></label></div>`;
  return `<h3 class="set-h" style="margin-top:0">客户端</h3>
    ${row('launchAtLogin', '开机自动启动', '登录系统后自动运行 Reins，以隐藏窗口启动并驻留', s.launchAtLogin)}
    ${row('keepInTray', '关闭窗口时驻留菜单栏', '保持本机节点在线，Agent 可继续接收并执行任务', s.keepInTray)}
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
        <div class="f-row"><label>访问令牌（--token）</label><input type="password" id="cn-token" value="${esc(s.cloudToken || '')}" placeholder="与服务器启动参数一致" autocomplete="off"></div>
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
    <div class="set-row"><div><b>导出数据</b><div class="set-desc">导出全部空间与 Agent 配置为 JSON 备份</div></div>
      <button class="btn btn-o btn-sm" onclick="exportData()">导出</button></div>
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
  const token = $('#cn-token').value.trim();
  if (url && !/^https?:\/\//.test(url)) { toast('地址无效', '需以 http:// 或 https:// 开头', '⚠'); return; }
  window.reins.setSettings({ cloudUrl: url, cloudToken: token }).then(r => {
    const s2 = settingsApplied(r);
    if (!s2) return;   // 写盘失败已如实提示（返工①），不再弹「已保存」
    hookCfg = { ...hookCfg, ...s2 };
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

/* —— 渲染引擎配置（漫剧图像/视频/配音；独立于 LLM Agent，存 settings.renderEngine） —— */
const CM_RENDER_PRESETS = {
  zhipu: { label: '智谱（CogView · CogVideoX）', baseURL: 'https://open.bigmodel.cn/api/paas/v4', imageModel: 'cogview-4', videoModel: 'cogvideox-3' },
  custom: { label: '自定义（兼容端点）', baseURL: '', imageModel: '', videoModel: '' },
};
async function hydrateRenderEngineCfg() {
  const box = document.getElementById('re-cfg'); if (!box) return;
  if (!window.reins) {
    box.innerHTML = `<h3 class="set-h">渲染引擎</h3><div class="set-row"><div><b>漫剧渲染引擎</b><div class="set-desc">浏览器预览模式下不可用，请在桌面客户端中配置。</div></div></div>`;
    return;
  }
  let e = null;
  try { e = await window.reins.comicRenderGet(); } catch (err) { }
  comicRenderEngine = e;
  const preset = CM_RENDER_PRESETS[e?.provider || 'zhipu'];
  const gap = cmRenderGapLabel(e);   // 完整体检（返工③）：缺模型名也算缺口，按钮与描述一并点名
  box.innerHTML = `<h3 class="set-h">渲染引擎（漫剧 · 图像 / 视频 / 配音）</h3>
    <div class="set-row">
      <div><b>${esc(preset.label)} <span class="mode-pill api">${e?.provider === 'custom' ? '自定义' : '智谱'}</span></b>
        <div class="set-desc">${esc(e?.baseURL || '未配置地址')} · 图像 ${esc(e?.imageModel || '—')} / 视频 ${esc(e?.videoModel || '—')} · ${e?.apiKey ? '密钥已配置' : '<b style="color:#c05656">密钥未配置</b>'} · 配音 ${e?.voiceModel ? esc(e.voiceModel) : '未启用（可选阶段）'}${gap && e?.baseURL && e?.apiKey ? ` · <b style="color:#c05656">${esc(gap)}</b>` : ''}</div></div>
      <button class="btn btn-o btn-sm" onclick="openRenderEngineModal()">${gap ? '去配置' : '配置'}</button>
    </div>`;
}
function openRenderEngineModal() {
  const e = comicRenderEngine || { provider: 'zhipu', baseURL: '', apiKey: '', imageModel: '', videoModel: '', voiceModel: '' };
  openModal(`<div class="modal-head"><h3>渲染引擎</h3><span>漫剧 · 图像 / 视频 / 配音</span><button class="x" onclick="closeModal()">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="f-2col">
        <div class="f-row"><label>服务商预设</label>${ds('re-provider', [
          { v: 'zhipu', l: CM_RENDER_PRESETS.zhipu.label },
          { v: 'custom', l: CM_RENDER_PRESETS.custom.label },
        ], e.provider || 'zhipu', 'reProviderChanged()')}</div>
        <div class="f-row"><label>API Key（仅保存在本机）</label><input type="password" id="re-key" value="${esc(e.apiKey || '')}" placeholder="sk-…" autocomplete="off"></div>
      </div>
      <div class="f-row"><label>Base URL（API 根路径）</label><input type="text" id="re-baseurl" value="${esc(e.baseURL || '')}" placeholder="https://open.bigmodel.cn/api/paas/v4"></div>
      <div class="f-2col">
        <div class="f-row"><label>图像模型</label><input type="text" id="re-imgmodel" value="${esc(e.imageModel || '')}" placeholder="cogview-4"></div>
        <div class="f-row"><label>视频模型</label><input type="text" id="re-vidmodel" value="${esc(e.videoModel || '')}" placeholder="cogvideox-3"></div>
      </div>
      <div class="f-row"><label>配音模型（可选 · 留空 = 跳过配音阶段）</label><input type="text" id="re-voicemodel" value="${esc(e.voiceModel || '')}" placeholder="例如 cogtts；留空不启用"></div>
      <div class="set-banner" style="margin:2px 0 0">配置变更只影响之后启动的任务，进行中的任务继续使用启动时的快照。</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-o" onclick="reTest()">测试连接</button><span style="flex:1"></span>
      <button class="btn btn-o" onclick="closeModal()">取消</button>
      <button class="btn btn-p" onclick="reSave()">保存</button>
    </div>`);
}
/* 切换预设带入默认地址与模型（与主进程 setRenderEngine 换服务商语义一致） */
function reProviderChanged() {
  const p = CM_RENDER_PRESETS[$('#re-provider')?.value]; if (!p) return;
  const bu = $('#re-baseurl'); if (bu) bu.value = p.baseURL;
  const im = $('#re-imgmodel'); if (im && p.imageModel) im.value = p.imageModel;
  const vm = $('#re-vidmodel'); if (vm && p.videoModel) vm.value = p.videoModel;
}
function reCollect() {
  return {
    provider: $('#re-provider')?.value || 'zhipu',
    baseURL: $('#re-baseurl')?.value.trim() || '',
    apiKey: $('#re-key')?.value.trim() || '',
    imageModel: $('#re-imgmodel')?.value.trim() || '',
    videoModel: $('#re-vidmodel')?.value.trim() || '',
    voiceModel: $('#re-voicemodel')?.value.trim() || '',
  };
}
async function reSave() {
  if (!window.reins) return;
  const r = await window.reins.comicRenderSet(reCollect());
  if (!r || !r.ok) { toast('保存失败', (r && r.error) || '未知错误', '⚠'); return; }
  comicRenderEngine = r.engine;
  closeModal(); hydrateRenderEngineCfg();
  toast('已保存', '渲染引擎配置已更新（新任务生效）', '⚙');
}
async function reTest() {
  if (!window.reins) { toast('浏览器模式', '请在客户端内测试', '⚠'); return; }
  toast('测试中', '正在探测渲染引擎端点（不产生消耗）…', '');
  const r = await window.reins.comicRenderTest(reCollect());
  toast(r && r.ok ? '连接成功' : '连接失败', (r && r.message) || '', r && r.ok ? '✓' : '⚠');
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'reins-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(a.href);
  toast('已导出', '备份文件已开始下载', '⇩');
}
function importData(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      let n = null;
      if (Array.isArray(data.orgs) && data.orgs.length) n = normalizeState(data);
      else if (Array.isArray(data.spaces) && data.spaces.length) n = normalizeState(toV3(data, '导入的组织'));
      if (!n) throw new Error('格式不符（需要 orgs 或 spaces 条目）');
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
  const badge = document.getElementById('bell-badge'); if (!badge) return;
  const n = unreadCount();
  badge.textContent = n > 99 ? '99+' : n;
  badge.style.display = n ? '' : 'none';
  window.reins?.traySetBadge?.(n); // 菜单栏托盘图标同步未读角标
}

/* 托盘角标绘制：图形 + 右侧纯数字（无底衬），整图为单色模板——深色菜单栏渲染为纯白，浅色自动变黑 */
function trayBadgeDataUrl(n) {
  const img = document.getElementById('tray-base-src');
  if (!img || !img.complete || !img.naturalWidth) return null;
  const x0 = document.getElementById('tray-badge-canvas').getContext('2d');
  const font = 'bold 27px -apple-system,Helvetica';
  x0.font = font;
  const tw = n > 0 ? Math.ceil(x0.measureText(String(Math.min(n, 99))).width) : 0;
  const H = 36;
  const W = 34 + (n > 0 ? 4 + tw : 0);
  const c = document.getElementById('tray-badge-canvas');
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
  // 时长文案要有宽度上界：超过一天改用「X 天 Y 小时」，避免侧栏胶囊被撑到换行
  let s;
  if (m < 1) s = '刚刚启动';
  else if (m < 60) s = `已运行 ${m} 分钟`;
  else if (m < 1440) s = `已运行 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  else s = `已运行 ${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`;
  el.textContent = s;
  el.parentElement?.setAttribute('title', '本机节点在线 · ' + s);
  const nv = document.getElementById('nv-uptime'); if (nv) nv.textContent = s; // 节点视图里的镜像同步刷新
}

/* —— 数据体检：无论数据来自本地存档、导入文件还是旧版迁移，进入渲染层前统一补齐缺失字段、
      修正坏值（如历史版本把成员对象拼成字符串留下的 "[object Object]"），保证界面永远拿到合法结构 —— */
function normalizeState(st) {
  if (!st || typeof st !== 'object') return null;
  if (!Array.isArray(st.orgs) || !st.orgs.length) return null;
  st.version = 3;
  if (!st.orgs.some(x => x.id === st.activeOrgId)) st.activeOrgId = st.orgs[0].id;
  for (const org of st.orgs) {
    org.name = typeof org.name === 'string' && org.name.trim() ? org.name : '未命名组织';
    org.badge = typeof org.badge === 'string' && org.badge ? org.badge : org.name[0];
    if (!Array.isArray(org.agents)) org.agents = seedAgents();
    for (const a of org.agents) if (a.mode === 'cli' && a.runtime !== 'cloud') a.runtime = 'local';
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
  for (const k of ['iterations', 'epics', 'prompts', 'autos', 'activity', 'chart', 'comics']) if (!Array.isArray(sp[k])) sp[k] = [];
  if (!sp.integ || typeof sp.integ !== 'object') sp.integ = {};
  sp.seq = Number.isFinite(sp.seq) ? sp.seq : 1;
  sp.deliverSeq = Number.isFinite(sp.deliverSeq) ? sp.deliverSeq : 1;
  sp.readAt = Number.isFinite(sp.readAt) ? sp.readAt : 0;
  sp.tasks = (Array.isArray(sp.tasks) ? sp.tasks : []).map(t => {
    if (!t || typeof t !== 'object') return null;
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
  boot('first-view', () => switchView('kanban'));
  if (faults.includes('first-view')) {
    $('#content').innerHTML = `<div class="panel" style="padding:26px"><h3 style="margin:0 0 8px">视图渲染失败</h3>
      <div style="font-size:13px;color:var(--ink-dim)">部分数据可能损坏。可先导出备份，再尝试「清空数据」。</div></div>`;
  }
  if (faults.length) toast('界面初始化遇到问题', '已尽量恢复，详见控制台', '⚠');
  updateNodePill(); setInterval(updateNodePill, 30000);
  boot('bell', () => renderBell());

  // 主进程执行事件 → 更新运行 UI
  window.reins?.onRunEvent(evt => handleRunEvent(evt));
  window.reins?.onComicEvent?.(evt => handleComicEvent(evt));
  window.reins?.getSettings?.().then(s => { if (s) hookCfg = { ...hookCfg, ...s }; }).catch(() => { });
  window.reins?.comicRenderGet?.().then(e => { comicRenderEngine = e; }).catch(() => { });
  hydrateComics();

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
    S().tasks.filter(t => t.status === 'doing' && t.assignee?.kind === 'agent' && !runs[t.id])
      .forEach((t, i) => {
        const a = agentById(t.assignee.id);
        if (a && a.mode === 'sim') setTimeout(() => {
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
