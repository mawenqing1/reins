/* services/update.js — 检查更新：语义化版本比较 + GitHub Releases 查询（fetch 注入，离线可测） */
import assert = require('assert');
import updateService = require('../services/update');
const { parseSemver, isNewer, checkLatest, UPDATE_REPO } = updateService;

function mockResp(status, body) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body
  };
}

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };
  const eq = (a, b, m) => { n++; assert.strictEqual(a, b, m); };

  /* ---------- 1. parseSemver：容错与边界 ---------- */
  {
    eq(parseSemver('1.2.3').major, 1, 'parse major');
    eq(parseSemver('v1.2.3').patch, 3, 'v 前缀容错');
    ok(!!parseSemver('1.2.3-rc.1').pre, '预发布段解析');
    eq(parseSemver('1.2.3-rc.1').pre[0], 'rc', '预发布标识符拆分');
    eq(parseSemver('abc'), null, '非法输入 → null');
    eq(parseSemver(''), null, '空输入 → null');
    eq(parseSemver('1.2'), null, '两段版本号不认');
  }

  /* ---------- 2. isNewer：基本比较 ---------- */
  {
    ok(isNewer('1.0.0', '1.0.1'), 'patch 更高 → 新');
    ok(isNewer('1.0.0', 'v1.1.0'), 'minor 更高 + v 前缀 → 新');
    ok(isNewer('1.9.9', '2.0.0'), 'major 更高 → 新');
    ok(!isNewer('1.1.0', '1.1.0'), '相同版本 → 不新');
    ok(!isNewer('1.2.0', '1.1.0'), '更低 → 不新');
    ok(!isNewer('1.2.0', 'v1.2.0'), '相同（一侧带 v）→ 不新');
  }

  /* ---------- 3. isNewer：预发布语义 ---------- */
  {
    ok(isNewer('1.0.0-rc.1', '1.0.0'), '正式版 > 预发布');
    ok(!isNewer('1.0.0', '1.0.0-rc.1'), '预发布不构成「更新」');
    ok(isNewer('1.0.0-rc.1', '1.0.0-rc.2'), 'rc.2 > rc.1');
    ok(isNewer('1.0.0-alpha', '1.0.0-beta'), '字母序 alpha < beta');
    ok(isNewer('1.0.0-rc.1', '1.0.1-rc.1'), '先比三元组，patch 优先于预发布');
  }

  /* ---------- 4. isNewer：坏输入宁可漏报（不打扰用户） ---------- */
  {
    ok(!isNewer('1.0.0', 'latest'), '非语义化 tag → 不新');
    ok(!isNewer('junk', '1.2.3'), '当前版本解析失败 → 不新');
  }

  /* ---------- 5. checkLatest：有新版本 / 已是最新 ---------- */
  {
    let r = await checkLatest({
      currentVersion: '1.0.0', fetchImpl: async () => mockResp(200, { tag_name: 'v1.1.0', html_url: 'https://github.com/x/releases/tag/v1.1.0' })
    });
    ok(r.ok && r.newer, '有新版本');
    eq(r.latest, 'v1.1.0', 'latest 回传');
    eq(r.htmlUrl, 'https://github.com/x/releases/tag/v1.1.0', 'html_url 优先取响应');

    r = await checkLatest({ currentVersion: '1.1.0', fetchImpl: async () => mockResp(200, { tag_name: 'v1.1.0' }) });
    ok(r.ok && !r.newer, '同版本不提示');
  }

  /* ---------- 6. checkLatest：404 = 仓库尚无 Release（源码用户常态，ok 而非失败） ---------- */
  {
    const r = await checkLatest({ currentVersion: '1.0.0', fetchImpl: async () => mockResp(404, {}) });
    ok(r.ok && r.latest === null && !r.newer, '404 → 无发布版本');
    ok(/releases$/.test(r.htmlUrl), '404 时引导 Releases 列表页');
  }

  /* ---------- 7. checkLatest：网络失败如实报错 / 响应缺字段 ---------- */
  {
    let r = await checkLatest({ currentVersion: '1.0.0', retries: 0, fetchImpl: async () => { throw new Error('boom'); } });
    ok(!r.ok, '网络失败 → ok:false');
    ok(/boom/.test(r.message), '错误原因回传');

    r = await checkLatest({ currentVersion: '1.0.0', fetchImpl: async () => mockResp(200, { name: 'x' }) });
    ok(!r.ok, '缺 tag_name → 失败');
  }

  /* ---------- 8. 请求落点：GitHub API 固定格式 + UA 头 ---------- */
  {
    let seen = null;
    await checkLatest({ currentVersion: '1.0.0', fetchImpl: async (url, init) => { seen = { url, init }; return mockResp(200, { tag_name: 'v1.1.0' }); } });
    eq(seen.url, 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', '请求 URL 落点');
    eq(seen.init.headers['User-Agent'], 'reins-update-check', 'UA 头');
  }

  return n;
}

module.exports = { run };
