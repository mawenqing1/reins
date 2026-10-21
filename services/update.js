/* ============================================================
   Reins — 检查更新：查询 GitHub Releases 最新版本
   ------------------------------------------------------------
   - 语义化版本比较（容错 v 前缀 / 预发布号；预发布 < 正式版）
   - 查询走共享重试层 http.js；fetch 可注入，纯 Node 可单测
   - 只做「告知 + 引导下载」：应用未签名，macOS 自更新不可行，
     electron-updater 静默升级留待签名基建就绪后接入
   ============================================================ */

const { fetchWithRetry } = require('./http');

const UPDATE_REPO = 'mawenqing1/reins';

/* 'v1.2.3-rc.1' → { major, minor, patch, pre:[...] }；解析失败返回 null */
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? m[4].split('.').map(s => (/^\d+$/.test(s) ? Number(s) : s)) : null
  };
}

/* 预发布比较：数字段按数值、字母段按字典序（语义化规范 §11 的简化实现） */
function preCmp(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;    // 无预发布（正式版）更大
  if (b === null) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = typeof x === 'number', yn = typeof y === 'number';
    if (xn && yn) { if (x !== y) return x < y ? -1 : 1; }
    else if (xn) return -1;    // 数字标识符 < 字母标识符
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function semCmp(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return preCmp(a.pre, b.pre);
}

/* tag 是否比当前版本新（任一侧解析失败一律视为「不新」，宁可漏报不误报打扰） */
function isNewer(cur, tag) {
  const a = parseSemver(cur), b = parseSemver(tag);
  if (!a || !b) return false;
  return semCmp(a, b) < 0;
}

/* 查询 GitHub Releases 最新版。
   返回 { ok, newer, latest, htmlUrl, message }：
   - ok:false —— 网络失败 / 响应异常（message 说明原因，调用方如实展示）
   - ok:true 且 latest:null —— 仓库还没有 Release（源码用户常态） */
async function checkLatest(opts) {
  const o = opts || {};
  const repo = o.repo || UPDATE_REPO;
  const url = 'https://api.github.com/repos/' + repo + '/releases/latest';
  let resp;
  try {
    resp = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'reins-update-check', 'Accept': 'application/vnd.github+json' }
    }, { fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs || 10000, retries: Number.isFinite(o.retries) ? o.retries : 1 });
  } catch (e) {
    return { ok: false, newer: false, latest: null, htmlUrl: null, message: (e && e.message) || String(e) };
  }
  if (resp.status === 404) return { ok: true, newer: false, latest: null, htmlUrl: 'https://github.com/' + repo + '/releases', message: '仓库尚未发布任何版本' };
  if (!resp.ok) return { ok: false, newer: false, latest: null, htmlUrl: null, message: 'HTTP ' + resp.status + '（GitHub API）' };
  let j = null;
  try { j = await resp.json(); } catch (e) { }
  if (!j || typeof j.tag_name !== 'string' || !j.tag_name) {
    return { ok: false, newer: false, latest: null, htmlUrl: null, message: 'Release 响应缺少 tag_name' };
  }
  return {
    ok: true,
    newer: isNewer(o.currentVersion || '', j.tag_name),
    latest: j.tag_name,
    htmlUrl: (typeof j.html_url === 'string' && j.html_url) || ('https://github.com/' + repo + '/releases/tag/' + j.tag_name),
    message: ''
  };
}

module.exports = { UPDATE_REPO, parseSemver, isNewer, checkLatest };
