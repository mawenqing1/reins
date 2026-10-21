/* ============================================================
   Reins — 密钥落盘加密（Electron safeStorage）
   ------------------------------------------------------------
   - 加密后端：macOS Keychain / Windows DPAPI / Linux libsecret（safeStorage 自选），
     纯 Node（单测）环境无 electron 时回退"不加密透传"
   - 密文形态：{ __encrypted: true, data: '<base64>' }，写入 reins-data.json /
     settings.json；内存中（渲染层拿到的）始终是明文字符串，界面逻辑零改动
   - 落盘前回读校验：加密→解密→与原文一致才替换明文（密钥轮换/迁移中断不会丢 Key）；
     校验失败保留明文并继续，绝不阻断使用
   - 解密失败（如换机器/钥匙串重置）：保留密文对象原地不动并标记 __keyLocked，
     后续保存原样带回密文——宁可"配了 Key 但调不通"，不做"静默清空"
   - 降级策略：safeStorage 不可用 → 明文透传；用户可在设置中 keyStorage='plain'
     显式选择不加密（界面负责警示）
   ============================================================ */

let _backend;   // undefined 未探测 / null 不可用 / safeStorage 句柄
function getBackend() {
  if (_backend !== undefined) return _backend;
  _backend = null;
  try {
    const electron = require('electron');
    const ss = electron && electron.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) _backend = ss;
  } catch (e) { }
  return _backend;
}
/* 单测注入假后端：{encryptString(s)->Buffer, decryptString(b)->s} */
function setBackend(fake) { _backend = fake || null; }
function backendInfo() {
  const ss = getBackend();
  return { available: !!ss, kind: ss ? 'safeStorage' : 'none' };
}

const isSealed = v => v && typeof v === 'object' && v.__encrypted === true && typeof v.data === 'string';

/* 单值加密：成功返回密文对象；后端缺失/策略明文/校验失败 → 原样返回明文（sealed=false） */
function sealOne(plain, policy) {
  const ss = getBackend();
  if (!ss || policy === 'plain') return { value: plain, sealed: false };
  if (typeof plain !== 'string' || !plain) return { value: plain, sealed: false };
  try {
    const data = ss.encryptString(plain).toString('base64');
    // 回读校验：确认解密成功且与原文一致，才允许密文替换明文落盘
    if (ss.decryptString(Buffer.from(data, 'base64')) === plain) {
      return { value: { __encrypted: true, data }, sealed: true };
    }
  } catch (e) { }
  return { value: plain, sealed: false };
}

/* 单值解密：明文透传；密文解出明文；解密失败保留密文对象并置 failed（调用方标记锁定） */
function openOne(sealed) {
  if (typeof sealed === 'string') return { value: sealed, sealed: false };
  if (isSealed(sealed)) {
    const ss = getBackend();
    if (!ss) return { value: sealed, sealed: true, failed: true };
    try {
      return { value: ss.decryptString(Buffer.from(sealed.data, 'base64')), sealed: true };
    } catch (e) {
      return { value: sealed, sealed: true, failed: true };
    }
  }
  return { value: sealed, sealed: false };
}

/* ---------- 状态档（reins-data.json）：agent.apiKey ----------
   兼容三种历史结构：顶层 agents（v1/v2）与 orgs[].agents（v3）；
   只按字段名定点处理，不做全树深扫（状态档含大量任务正文，深扫拖慢高频保存） */
function eachAgent(state, fn) {
  if (!state || typeof state !== 'object') return;
  if (Array.isArray(state.agents)) state.agents.forEach(fn);
  if (Array.isArray(state.orgs)) {
    for (const org of state.orgs) {
      if (org && Array.isArray(org.agents)) org.agents.forEach(fn);
    }
  }
}

function sealState(state, policy) {
  let sealed = 0, plaintext = 0;
  if (!state || typeof state !== 'object') return { state, sealed, plaintext };
  eachAgent(state, a => {
    if (!a || typeof a !== 'object') return;
    const k = a.apiKey;
    if (isSealed(k)) return;                    // 已是密文：原样保留（含锁定态密文）
    if (typeof k !== 'string' || !k) return;
    const r = sealOne(k, policy);
    if (r.sealed) { a.apiKey = r.value; sealed++; }
    else plaintext++;
  });
  return { state, sealed, plaintext };
}

function openState(state) {
  let failed = 0;
  if (!state || typeof state !== 'object') return { state, failed };
  eachAgent(state, a => {
    if (!a || typeof a !== 'object') return;
    if (!isSealed(a.apiKey)) return;
    const r = openOne(a.apiKey);
    if (r.failed) { a.__keyLocked = true; failed++; }   // 解不开：密文留在原地，标记锁定供界面警示
    else { a.apiKey = r.value; delete a.__keyLocked; }
  });
  return { state, failed };
}

/* 明文密钥盘点（启动迁移提示/keystatus 用）：不改动数据 */
function countSecrets(state) {
  const c = { plaintext: 0, sealed: 0, locked: 0 };
  eachAgent(state, a => {
    if (!a || typeof a !== 'object') return;
    if (isSealed(a.apiKey)) c.sealed++;
    else if (typeof a.apiKey === 'string' && a.apiKey) c.plaintext++;
    if (a.__keyLocked) c.locked++;
  });
  return c;
}

/* ---------- 客户端设置（settings.json）：cloudToken / jevKey / gitTokens / feishu ----------
   gitTokens（任务卡 5 引入的 GitHub/Gitee PAT）同为密钥：按成员逐个加密，
   对象结构保留、空串不动；解锁失败的成员保留密文对象原地（界面视同未配置）
   飞书接入（自建应用）的 appSecret 与群机器人加签 secret 同属密钥：作为
   settings.feishu 的成员逐个加密，解锁失败保留密文并标记 __feishuLocked */
const SETTING_SECRET_KEYS = ['cloudToken', 'jevKey'];
const GIT_TOKEN_PROVIDERS = ['github', 'gitee'];
const FEISHU_SECRET_FIELDS = ['appSecret', 'webhookSecret'];

function sealSettings(settings, policy) {
  let sealed = 0, plaintext = 0;
  if (!settings || typeof settings !== 'object') return { state: settings, sealed, plaintext };
  for (const k of SETTING_SECRET_KEYS) {
    const v = settings[k];
    if (isSealed(v)) continue;
    if (typeof v !== 'string' || !v) continue;
    const r = sealOne(v, policy);
    if (r.sealed) { settings[k] = r.value; sealed++; }
    else plaintext++;
  }
  const gt = settings.gitTokens;
  if (gt && typeof gt === 'object' && !Array.isArray(gt) && !isSealed(gt)) {
    for (const p of GIT_TOKEN_PROVIDERS) {
      const v = gt[p];
      if (isSealed(v) || typeof v !== 'string' || !v) continue;
      const r = sealOne(v, policy);
      if (r.sealed) { gt[p] = r.value; sealed++; }
      else plaintext++;
    }
  }
  const fs1 = settings.feishu;
  if (fs1 && typeof fs1 === 'object' && !Array.isArray(fs1) && !isSealed(fs1)) {
    for (const p of FEISHU_SECRET_FIELDS) {
      const v = fs1[p];
      if (isSealed(v) || typeof v !== 'string' || !v) continue;
      const r = sealOne(v, policy);
      if (r.sealed) { fs1[p] = r.value; sealed++; }
      else plaintext++;
    }
  }
  return { state: settings, sealed, plaintext };
}

function openSettings(settings) {
  let failed = 0;
  if (!settings || typeof settings !== 'object') return { state: settings, failed };
  for (const k of SETTING_SECRET_KEYS) {
    if (!isSealed(settings[k])) continue;
    const r = openOne(settings[k]);
    if (r.failed) { settings['__' + k + 'Locked'] = true; failed++; }
    else settings[k] = r.value;
  }
  const gt = settings.gitTokens;
  if (gt && typeof gt === 'object' && !Array.isArray(gt)) {
    for (const p of GIT_TOKEN_PROVIDERS) {
      if (!isSealed(gt[p])) continue;
      const r = openOne(gt[p]);
      if (r.failed) failed++;   // 密文留在原地：PR 调用按"令牌无效"报错，界面提示重配
      else gt[p] = r.value;
    }
  }
  const fs1 = settings.feishu;
  if (fs1 && typeof fs1 === 'object' && !Array.isArray(fs1) && !isSealed(fs1)) {
    for (const p of FEISHU_SECRET_FIELDS) {
      if (!isSealed(fs1[p])) continue;
      const r = openOne(fs1[p]);
      if (r.failed) { settings.__feishuLocked = true; failed++; }   // 保留密文：界面视同未配置并提示重填
      else fs1[p] = r.value;
    }
  }
  return { state: settings, failed };
}

module.exports = {
  getBackend, setBackend, backendInfo,
  sealOne, openOne, isSealed,
  sealState, openState, countSecrets,
  sealSettings, openSettings,
};
