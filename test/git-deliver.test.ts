/* web/assets/app.js —— Git 交付闭环接线（推送空分支缺陷的界面侧防护）
   缺陷背景：Agent 在 worktree 里改的是工作区文件，分支提交并未前进；旧界面直接 push
   会报「成功」而远程拿不到任何改动。渲染层脚本无法 require：按行提取纯函数真身求值，
   接线正确性用源码断言兜底。 */
import assert = require('assert');
import fs = require('fs');
import path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'assets', 'app.ts'), 'utf8');
const grab = name => {
  const m = SRC.match(new RegExp('^const ' + name + ' = .+$', 'm'));
  if (!m) throw new Error('web/assets/app.js 缺少助手 ' + name);
  return m[0];
};

/* 把 gitResultEpisode 抽出来跑：它只依赖 gitLog/th/toast/esc，注入桩函数即可 */
function loadGitResultEpisode() {
  const m = SRC.match(/^function gitResultEpisode\(t, r, doneText\) \{[\s\S]*?\n\}/m);
  if (!m) throw new Error('web/assets/app.js 缺少 gitResultEpisode（交付结果分流可能被误删）');
  const src = m[0];
  const sandbox = { logs: [], timeline: [], toasts: [] };
  const fn = new Function('gitLog', 'th', 'toast', 'esc', src + '\nreturn gitResultEpisode;')(
    html => sandbox.logs.push(html),
    (t, ic, text) => sandbox.timeline.push(text),
    (title, sub) => sandbox.toasts.push([title, sub]),
    s => String(s == null ? '' : s)
  );
  return { fn, sandbox };
}

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. 结果分流：成功写时间线；未提交/无新提交/认证/网络四类失败给不同指引 */
  {
    const { fn, sandbox } = loadGitResultEpisode();
    const t = { id: 't1', key: 'REINS-1' };
    ok(fn(t, { ok: true, message: '已推送 reins/REINS-1 → origin' }, '已推送分支') === true, '成功返回 true');
    ok(sandbox.timeline.length === 1 && /已推送分支/.test(sandbox.timeline[0]), '成功写一条时间线');

    sandbox.logs.length = 0;
    ok(fn(t, { ok: false, kind: 'uncommitted', message: '还有 2 个文件未提交' }) === false, '未提交返回 false');
    ok(sandbox.logs.some(l => /自动提交后推送/.test(l)), '未提交给出「一键提交」指引');
    ok(sandbox.toasts.some(x => x[0] === '推送失败'), '未提交弹失败提示（不再静默）');

    sandbox.logs.length = 0; sandbox.toasts.length = 0;
    ok(fn(t, { ok: false, kind: 'no-commits', message: '没有新提交' }) === false, '无新提交返回 false');
    ok(sandbox.logs.some(l => /确认 Agent 是否真的改了文件/.test(l)), '无新提交指引去核查 Agent 产出');
    ok(sandbox.toasts.some(x => x[0] === '无新提交'), '无新提交用独立标题（与普通失败区分）');

    sandbox.logs.length = 0;
    fn(t, { ok: false, kind: 'auth', message: '403' });
    ok(sandbox.logs.some(l => /令牌|SSH/.test(l)), '认证失败指引到令牌配置');

    sandbox.logs.length = 0;
    fn(t, { ok: false, kind: 'network', message: 'timeout' });
    ok(sandbox.logs.some(l => /网络|代理/.test(l)), '网络失败指引到网络排查');

    sandbox.logs.length = 0;
    fn(t, { ok: false, message: '未知错误' });
    ok(sandbox.logs.length === 1, '未知失败只报错误本身、不硬塞指引');
  }

  /* 2. 推送默认带 commit（防止界面再次退化成"裸 push 空分支"） */
  {
    const m = SRC.match(/async function gitPushTask\(id, opts\) \{[\s\S]*?\n\}/m);
    ok(!!m, 'gitPushTask 存在');
    const body = m ? m[0] : '';
    ok(/commit: o\.commit !== false/.test(body), '推送默认自动提交（commit 缺省为 true）');
    ok(/message: t\.key \+ ' ' \+ String\(t\.title/.test(body), '提交信息带任务号与标题');
    ok(/window\.reins\.gitPush\(\{[\s\S]*?cwd: t\.worktree/.test(body), '推送仍指向隔离工作区');
  }

  /* 3. 一键交付：提交 → 推送 → 识别远程 → 建 PR，任一步失败都不继续 */
  {
    const m = SRC.match(/async function gitDeliverTask\(id\) \{[\s\S]*?\n\}/m);
    ok(!!m, 'gitDeliverTask 存在');
    const body = m ? m[0] : '';
    ok(/await gitPushTask\(id, \{ commit: true \}\)/.test(body), '一键交付先提交并推送');
    ok(/if \(!pushed\) return/.test(body), '推送失败即中止，不再硬开 PR');
    ok(/window\.reins\.gitRemote\(/.test(body) && /window\.reins\.gitCreatePR\(/.test(body), '串起远程识别与 PR 创建');
    ok(/head: 'reins\/' \+ t\.key/.test(body), 'PR 源分支为任务分支');
    ok(/if \(!t\.result\)/.test(body), '无交付内容时前置拦截');
  }

  /* 4. 交付面板入口：一键按钮在前，单独推送仍可用；PR 弹窗抽成 prModal 复用 */
  {
    const m = SRC.match(/function gitRemoteBlock\(t\) \{[\s\S]*?\n\}/m);
    ok(!!m, 'gitRemoteBlock 存在');
    const body = m ? m[0] : '';
    ok(/gitDeliverTask\('/.test(body), '面板提供「提交并创建 PR」');
    ok(/gitPushTask\('/.test(body), '面板保留单独推送入口');
    ok(/commit: o\.commit !== false|提交/.test(body), '面板文案说明会先提交');
    ok(/function prModal\(/.test(SRC), 'PR 弹窗抽成 prModal 供两处复用');
    ok(/prModal\(t, info\)/.test(SRC), 'gitPRTask 走 prModal');
  }

  /* 5. 主进程侧：commit 能力与推送体检确实暴露给渲染层 */
  {
    const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'main.ts'), 'utf8');
    ok(/ipcMain\.handle\('reins:git:push'/.test(MAIN), 'git:push IPC 存在');
    ok(/gitRemote\.pushBranch\(p && p\.cwd, p\)/.test(MAIN), 'IPC 原样透传 commit/message 等参数');
    const GR = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'git-remote.ts'), 'utf8');
    ok(/function commitWorktree\(/.test(GR), 'git-remote 具备提交能力');
    ok(/kind: 'uncommitted'/.test(GR) && /kind: 'no-commits'/.test(GR), '推送体检覆盖未提交与无新提交');
    ok(/isIgnoredPath/.test(GR), '提交时排除 node_modules 等注入路径');
  }

  return n;
}

module.exports = { run };
