/* services/git-remote.js — 远程地址解析 / 推送错误分类 / PR 请求构造 / createPR 全分支（注入 fetch，离线） */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseRemoteUrl, remoteInfo, classifyPushError, buildPRRequest, createPR, pushBranch, testToken } = require('../services/git-remote');

const res = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => null },
  text: async () => body || '',
  json: async () => { try { return JSON.parse(body); } catch (e) { return null; } },
});

/* 离线 git 夹具：work 仓库 + 本地 bare 远程（真实 git push，不出网） */
function mkRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-git-test-'));
  const work = path.join(base, 'work');
  const bare = path.join(base, 'bare.git');
  for (const d of [work, bare]) fs.mkdirSync(d);
  const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  g(work, 'init', '-q'); g(bare, 'init', '-q', '--bare');
  g(work, 'config', 'user.email', 't@reins.test'); g(work, 'config', 'user.name', 'reins-test');
  fs.writeFileSync(path.join(work, 'a.txt'), 'hello');
  g(work, 'add', '.'); g(work, 'commit', '-qm', 'init');
  g(work, 'branch', '-M', 'reins/K1');
  g(work, 'remote', 'add', 'origin', bare);
  return { base, work, bare, clean: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. 远程地址解析：https / git@ / ssh:// / .git 后缀 / 平台识别 / 非法输入 */
  ok(parseRemoteUrl('https://github.com/foo/bar').provider === 'github', 'https github');
  ok(parseRemoteUrl('https://github.com/foo/bar.git').slug === 'foo/bar', 'https .git 后缀剥离');
  ok(parseRemoteUrl('git@gitee.com:foo/bar.git').provider === 'gitee', 'ssh 简写 gitee');
  ok(parseRemoteUrl('ssh://git@github.com/foo/bar').slug === 'foo/bar', 'ssh 完整写法');
  ok(parseRemoteUrl('ssh://gitee.com/foo/bar').provider === 'gitee' && parseRemoteUrl('ssh://gitee.com/foo/bar.git').slug === 'foo/bar', '裸 ssh://（无用户名@）可解析');
  ok(parseRemoteUrl('https://gitlab.com/foo/bar').provider === 'other', '其他托管 other');
  ok(!parseRemoteUrl('not a url') && !parseRemoteUrl('') && !parseRemoteUrl('https://github.com/foo'), '非法输入 null');
  ok(!parseRemoteUrl('https://github.com/foo/bar/baz'), '子组仓库（3 段）不支持返回 null');

  /* 2. 推送错误分类：给出可操作的 hint */
  ok(classifyPushError('fatal: Authentication failed for ...').kind === 'auth', '认证失败');
  ok(classifyPushError('fatal: Could not resolve host github.com').kind === 'network', '网络不通');
  ok(classifyPushError('! [rejected] (non-fast-forward)').kind === 'rejected', '非快进');
  ok(classifyPushError('whatever else').kind === 'unknown', '未知兜底');

  /* 3. PR 请求构造（纯函数） */
  {
    const info = { origin: { provider: 'github', slug: 'foo/bar' }, defaultBranch: 'main' };
    const r = buildPRRequest(info, { head: 'reins/K1', title: 'T', body: 'B', token: 'tk' });
    ok(r.ok && r.create.url === 'https://api.github.com/repos/foo/bar/pulls', 'GitHub PR 端点');
    const body = JSON.parse(r.create.init.body);
    ok(body.head === 'reins/K1' && body.base === 'main' && body.title === 'T', 'PR body 字段');
    ok(r.create.init.headers.Authorization === 'Bearer tk', 'Bearer 令牌');
    const g = buildPRRequest({ origin: { provider: 'gitee', slug: 'a/b' }, defaultBranch: 'master' }, { head: 'h', token: 'gt' });
    ok(JSON.parse(g.create.init.body).access_token === 'gt', 'Gitee 令牌走 body');
    ok(!buildPRRequest({ origin: { provider: 'other', slug: 'a/b' } }, { head: 'h' }).ok, '非 GitHub/Gitee 拒绝');
    ok(!buildPRRequest(info, { title: 'T' }).ok, '缺 head 拒绝');
  }

  /* 4. 真实 git 仓库上的 remoteInfo / pushBranch / createPR（git 不可用则整段跳过） */
  const gitOk = spawnSync('git', ['--version']).status === 0;
  if (gitOk) {
    const fix = mkRepos();
    try {
      const info = remoteInfo(fix.work);
      ok(info.ok && info.branch === 'reins/K1', 'remoteInfo 识别当前分支');
      ok(info.origin === null && info.supported === false, '本地路径远程解析不出托管（origin=null）');
      ok(info.defaultBranch === 'main', '无 origin/HEAD 回退 main');

      /* 有未提交改动时：默认拒绝（说明会丢失改动），commit:true 才提交并推送。
         这是原缺陷的核心防护——Agent 改的是工作区文件，直接 push 推的是不含改动的旧提交 */
      fs.writeFileSync(path.join(fix.work, 'a.txt'), 'hello\nagent change');
      fs.writeFileSync(path.join(fix.work, 'b.txt'), 'new file');
      const dirty = pushBranch(fix.work, { branch: 'reins/K1' });
      ok(!dirty.ok && dirty.kind === 'uncommitted', '有未提交改动时拒绝直接推送');
      ok(dirty.dirty.total === 2 && dirty.dirty.untracked === 1, '未提交盘点含未跟踪文件');
      ok(/a\.txt/.test(dirty.dirty.files.join(',')), '盘点列出具体文件');

      const p = pushBranch(fix.work, { branch: 'reins/K1', commit: true, message: 'REINS-K1 交付' });
      ok(p.ok && /reins\/K1/.test(p.message), '提交后离线推送到本地 bare 成功');
      ok(!!p.commit, '返回提交信息');
      const ls = spawnSync('git', ['-C', fix.bare, 'branch', '--list'], { encoding: 'utf8' });
      ok(/reins\/K1/.test(ls.stdout), '远程确实收到分支');
      /* 关键：远程分支里要有 Agent 的改动（这正是原缺陷丢失的内容） */
      const shown = spawnSync('git', ['--git-dir', fix.bare, 'show', 'reins/K1:a.txt'], { encoding: 'utf8' });
      ok(/agent change/.test(shown.stdout), '远程分支包含 Agent 修改的内容');
      const tree = spawnSync('git', ['--git-dir', fix.bare, 'ls-tree', 'reins/K1', '--name-only'], { encoding: 'utf8' });
      ok(/b\.txt/.test(tree.stdout), '远程分支包含 Agent 新建的文件');

      /* 再推一次：已经没有新提交，不应再报成功 */
      const again = pushBranch(fix.work, { branch: 'reins/K1' });
      ok(!again.ok && again.kind === 'no-commits', '重复推送无新提交时如实告知');
      ok(!pushBranch(fix.work, {}).ok, '缺分支名报错');

      // 远程指到不存在路径 → 可操作错误（不出网）
      spawnSync('git', ['-C', fix.work, 'remote', 'set-url', 'origin', path.join(fix.base, 'nosuch.git')]);
      const bad = pushBranch(fix.work, { branch: 'reins/K1' });
      ok(!bad.ok && bad.message.length > 0, '推送失败返回可读错误');

      // createPR：github 远程 + 注入 fetch，覆盖 成功/已存在找回/令牌错误/未配置令牌
      spawnSync('git', ['-C', fix.work, 'remote', 'set-url', 'origin', 'https://github.com/foo/bar.git']);
      let calls = 0;
      const okImpl = async () => { calls++; return res(201, JSON.stringify({ number: 7, html_url: 'https://github.com/foo/bar/pull/7' })); };
      const r1 = await createPR({ cwd: fix.work, head: 'reins/K1', title: 'T', body: 'B', token: 'tk', fetchImpl: okImpl });
      ok(r1.ok && r1.url.includes('/pull/7') && r1.exists === false, 'PR 创建成功返回链接');

      let seq = 0;
      const existsImpl = async () => { seq++; return seq === 1 ? res(422, 'Validation Failed: A pull request already exists') : res(200, JSON.stringify([{ number: 3, html_url: 'https://github.com/foo/bar/pull/3' }])); };
      const r2 = await createPR({ cwd: fix.work, head: 'reins/K1', title: 'T', token: 'tk', fetchImpl: existsImpl });
      ok(r2.ok && r2.exists === true && r2.url.includes('/pull/3'), '重复开 PR 找回既有链接');

      const r3 = await createPR({ cwd: fix.work, head: 'reins/K1', token: 'tk', fetchImpl: async () => res(401, 'Bad credentials') });
      ok(!r3.ok && /令牌/.test(r3.message), '401 给出令牌排查提示');

      const r4 = await createPR({ cwd: fix.work, head: 'reins/K1', tokens: {} });
      ok(!r4.ok && /令牌/.test(r4.message), '未配置令牌引导去设置页');

      const r5 = await createPR({ cwd: path.join(fix.base, 'empty-no-git'), head: 'x' });
      ok(!r5.ok, '非 git 目录报错');

      // Gitee：重复开 PR 回退查找必须带同一令牌（私有仓库读取需鉴权，否则 401 找不回链接）
      spawnSync('git', ['-C', fix.work, 'remote', 'set-url', 'origin', 'https://gitee.com/foo/bar.git']);
      const gUrls = [];
      const gSeq = { n: 0 };
      const giteeImpl = async (url) => {
        gUrls.push(url);
        gSeq.n++;
        return gSeq.n === 1
          ? res(400, JSON.stringify({ message: 'PR already exists' }))
          : res(200, JSON.stringify([{ number: 9, html_url: 'https://gitee.com/foo/bar/pulls/9' }]));
      };
      const r6 = await createPR({ cwd: fix.work, head: 'reins/K1', title: 'T', token: 'gt2', fetchImpl: giteeImpl });
      ok(r6.ok && r6.exists === true && r6.url.includes('/pulls/9'), 'Gitee 重复开 PR 找回既有链接');
      ok(/access_token=gt2/.test(gUrls[1] || ''), 'Gitee 查找已有 PR 携带同一 access_token');

      // detached HEAD：remoteInfo 标记并清空分支；按 'HEAD' 推送给出可操作指引而非裸 git 报错
      spawnSync('git', ['-C', fix.work, 'checkout', '-q', '--detach']);
      const dInfo = remoteInfo(fix.work);
      ok(dInfo.ok && dInfo.detached === true && dInfo.branch === '', 'detached HEAD 被识别（branch 置空）');
      const dp = pushBranch(fix.work, { branch: 'HEAD' });
      ok(!dp.ok && dp.kind === 'detached' && /detached HEAD/.test(dp.message), 'detached HEAD 推送给出明确指引');
      spawnSync('git', ['-C', fix.work, 'checkout', '-q', 'reins/K1']);
    } finally { fix.clean(); }
  }

  /* ---------- PAT 探活：/user 只读测试（fetch 注入，离线可测） ---------- */
  {
    const mkResp = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body, text: async () => '' });
    ok((await testToken('gitlab', 'x')).ok === false, '未知平台拒绝');
    ok((await testToken('github', '')).ok === false && /请先填写/.test((await testToken('github', '')).message), '空令牌提示');

    let r = await testToken('github', 'ghp_ok', { fetchImpl: async () => mkResp(200, { login: 'someone' }) });
    ok(r.ok && /someone/.test(r.message), 'GitHub 有效令牌回显账号名');
    r = await testToken('github', 'ghp_bad', { fetchImpl: async () => mkResp(401, {}) });
    ok(!r.ok && /401/.test(r.message), 'GitHub 401 判无效');
    r = await testToken('github', 'ghp_x', { fetchImpl: async () => { throw new Error('offline'); }, retries: 0 });
    ok(!r.ok && /offline/.test(r.message), '网络失败如实报错');

    /* 鉴权口径：GitHub 走 Authorization 头；Gitee 走 access_token 查询参数（与建 PR 一致） */
    let seen = null;
    await testToken('github', 'ghp_ok', { fetchImpl: async (url, init) => { seen = { url, init }; return mkResp(200, { login: 'u' }); } });
    ok(seen.url === 'https://api.github.com/user' && seen.init.headers.Authorization === 'Bearer ghp_ok', 'GitHub Authorization 头');
    await testToken('gitee', 'gee_ok', { fetchImpl: async (url) => { seen = { url }; return mkResp(200, { login: 'gu' }); } });
    ok(/gitee\.com\/api\/v5\/user\?access_token=gee_ok/.test(seen.url), 'Gitee access_token 查询参数');
    r = await testToken('gitee', 'gee_bad', { fetchImpl: async () => mkResp(403, {}) });
    ok(!r.ok && /403/.test(r.message), 'Gitee 403 判无效');
  }

  await new Promise(r => setTimeout(r, 1));
  return n;
}

module.exports = { run };
