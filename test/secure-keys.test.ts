/* services/secure-keys.js — 加解密往返 / 明文策略 / 后端降级 / 解锁失败锁定 / 状态档三种结构 / 迁移安全 */
import assert = require('assert');
import secureKeys = require('../services/secure-keys');

/* 可控假后端：ENC<原文> 可逆封装，可切换故障模式 */
function fakeBackend(mode?: any) {
  return {
    encryptString: s => Buffer.from('ENC<' + s + '>', 'utf8'),
    decryptString: b => {
      const t = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
      if (mode === 'throw') throw new Error('keychain locked');
      if (mode === 'wrong') return 'not-the-original';
      if (!t.startsWith('ENC<') || !t.endsWith('>')) throw new Error('bad ciphertext');
      return t.slice(4, -1);
    },
  };
}

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. 正常往返：seal 产出密文对象，open 还原明文 */
  secureKeys.setBackend(fakeBackend());
  {
    const r = secureKeys.sealOne('sk-abc-123');
    ok(r.sealed === true && r.value.__encrypted === true && typeof r.value.data === 'string', 'seal 产出密文对象');
    ok(JSON.stringify(r.value).indexOf('sk-abc-123') < 0, '密文序列化后不含明文');
    const o = secureKeys.openOne(r.value);
    ok(o.value === 'sk-abc-123' && o.failed !== true, 'open 还原明文');
    ok(secureKeys.isSealed(r.value) && !secureKeys.isSealed('plain'), 'isSealed 判定');
    ok(secureKeys.sealOne('', 'auto').sealed === false, '空串不加密');
    ok(secureKeys.sealOne(null, 'auto').sealed === false, '非字符串不加密');
  }

  /* 2. 用户显式选择明文（keyStorage='plain'）：可用后端也不加密 */
  ok(secureKeys.sealOne('sk-1', 'plain').sealed === false, 'plain 策略透传明文');

  /* 3. 落盘前回读校验：解密抛错 / 解出不一致 → 一律保留明文（不丢 Key） */
  secureKeys.setBackend(fakeBackend('throw'));
  ok(secureKeys.sealOne('sk-2', 'auto').sealed === false, '解密抛错保留明文');
  secureKeys.setBackend(fakeBackend('wrong'));
  ok(secureKeys.sealOne('sk-3', 'auto').sealed === false, '回读不一致保留明文');

  /* 4. 后端不可用降级：seal 明文透传；open 密文解不开 → failed 标记（调用方锁密文） */
  secureKeys.setBackend(null);
  {
    const r = secureKeys.sealOne('sk-4', 'auto');
    ok(r.sealed === false && r.value === 'sk-4', '无后端明文透传');
    const sealedObj = { __encrypted: true, data: Buffer.from('ENC<x>').toString('base64') };
    const o = secureKeys.openOne(sealedObj);
    ok(o.failed === true && o.value === sealedObj, '无后端密文原样保留并标记 failed');
    ok(secureKeys.backendInfo().available === false, 'backendInfo 报告不可用');
  }

  /* 5. 状态档（reins-data.json）：顶层 agents 与 orgs[].agents 双结构 + 已密文跳过 + 空值忽略 */
  secureKeys.setBackend(fakeBackend());
  {
    const presealed = secureKeys.sealOne('already-sealed').value;
    const state: any = {
      agents: [{ id: 'a1', apiKey: 'sk-top' }, { id: 'a2', apiKey: '' }],
      orgs: [{ agents: [{ id: 'a3', apiKey: 'sk-org' }] }, { agents: [{ id: 'a4', apiKey: presealed }] }],
    };
    const r = secureKeys.sealState(state, 'auto');
    ok(r.sealed === 2, '两个明文 Key 被加密（顶层+orgs）');
    ok(state.agents[0].apiKey.__encrypted === true && state.orgs[0].agents[0].apiKey.__encrypted === true, '落点正确');
    ok(state.agents[1].apiKey === '' && state.orgs[1].agents[0].apiKey === presealed, '空值与既有密文不动');

    const o = secureKeys.openState(state);
    ok(o.failed === 0, '全部可解');
    ok(state.agents[0].apiKey === 'sk-top' && state.orgs[0].agents[0].apiKey === 'sk-org', '解密还原两处结构');
    ok(state.orgs[1].agents[0].apiKey === 'already-sealed', '既有密文解出原文');

    const c = secureKeys.countSecrets(state);
    ok(c.plaintext === 3 && c.sealed === 0 && c.locked === 0, '解密后盘点为明文（空串不计）');
  }

  /* 6. 解锁失败（换机器/钥匙串重置）：密文原地不动 + __keyLocked 标记，绝不静默清空 */
  secureKeys.setBackend(fakeBackend('throw'));
  {
    const state: any = { agents: [{ id: 'a1', apiKey: { __encrypted: true, data: Buffer.from('ENC<sk-lost>').toString('base64') } }] };
    const o = secureKeys.openState(state);
    ok(o.failed === 1, '解锁失败计数');
    ok(state.agents[0].__keyLocked === true && state.agents[0].apiKey.__encrypted === true, '密文保留并标记锁定');
    const c = secureKeys.countSecrets(state);
    ok(c.sealed === 1 && c.locked === 1, '盘点识别锁定态');
    // 再走一次 seal（保存路径）：锁定密文不被二次加密，原样带回
    secureKeys.setBackend(fakeBackend());
    const r = secureKeys.sealState(state, 'auto');
    ok(r.sealed === 0 && state.agents[0].apiKey.__encrypted === true, '锁定密文保存时原样带回');
  }

  /* 7. 设置档（settings.json）：cloudToken / jevKey 加密往返 + 锁定标记 */
  secureKeys.setBackend(fakeBackend());
  {
    const s: any = { cloudToken: 'ck-1', jevKey: 'jk-1', other: 'x' };
    const r = secureKeys.sealSettings(s, 'auto');
    ok(r.sealed === 2 && s.cloudToken.__encrypted === true, '设置密钥加密');
    ok(s.other === 'x', '非密钥字段不动');
    const o = secureKeys.openSettings(s);
    ok(o.failed === 0 && s.cloudToken === 'ck-1' && s.jevKey === 'jk-1', '设置密钥解密往返');
  }
  secureKeys.setBackend(fakeBackend('throw'));
  {
    const s: any = { cloudToken: { __encrypted: true, data: 'xxx' } };
    secureKeys.openSettings(s);
    ok(s.__cloudTokenLocked === true && s.cloudToken.__encrypted === true, '设置密钥锁定标记');
  }

  /* 8. gitTokens（GitHub/Gitee PAT，任务卡 5 引入）：按成员逐个加密往返；
     空成员不动、锁定成员密文原样保留、明文策略透传 */
  secureKeys.setBackend(fakeBackend());
  {
    const s: any = { gitTokens: { github: 'ghp-plain-1', gitee: '' } };
    const r = secureKeys.sealSettings(s, 'auto');
    ok(r.sealed === 1 && s.gitTokens.github.__encrypted === true, 'PAT 成员加密');
    ok(s.gitTokens.gitee === '', '空成员不动');
    ok(JSON.stringify(s).indexOf('ghp-plain-1') < 0, '磁盘序列化不含 PAT 明文');
    const o = secureKeys.openSettings(s);
    ok(o.failed === 0 && s.gitTokens.github === 'ghp-plain-1', 'PAT 解密往返');
  }
  {
    const s = { gitTokens: { github: 'ghp-keep' } };
    ok(secureKeys.sealSettings(s, 'plain').sealed === 0 && s.gitTokens.github === 'ghp-keep', 'plain 策略 PAT 透传');
  }
  secureKeys.setBackend(fakeBackend('throw'));
  {
    const s: any = { gitTokens: { github: { __encrypted: true, data: Buffer.from('ENC<ghp-lost>').toString('base64') }, gitee: 'gt-new' } };
    const o = secureKeys.openSettings(s);
    ok(o.failed === 1, 'PAT 解锁失败计数');
    ok(s.gitTokens.github.__encrypted === true, '解锁失败 PAT 密文原样保留');
    secureKeys.setBackend(fakeBackend());
    const r = secureKeys.sealSettings(s, 'auto');
    ok(r.sealed === 1 && s.gitTokens.gitee.__encrypted === true && s.gitTokens.github.__encrypted === true, '保存路径：新明文加密、锁定密文原样带回');
  }

  secureKeys.setBackend(null);   // 复位，避免污染其他测试文件（run.js 同进程顺序执行）
  return n;
}

module.exports = { run };
