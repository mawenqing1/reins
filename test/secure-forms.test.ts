/* web/assets/app.js 设置档密钥表单防护 —— 密文对象视同未配置 / 留空保存保留密文（防 [object Object] 毁档）
   渲染层脚本无法直接 require：按行提取源码里的纯函数助手真身求值，接线正确性用源码断言兜底 */
import assert = require('assert');
import fs = require('fs');
import path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'assets', 'app.ts'), 'utf8');
const grab = name => {
  const m = SRC.match(new RegExp('^const ' + name + ' = .+$', 'm'));
  if (!m) throw new Error('web/assets/app.js 缺少助手 ' + name + '（防护可能被误删）');
  return m[0];
};
const { secretOf, secretLocked, secretPick } = new Function(
  grab('secretOf') + '\n' + grab('secretLocked') + '\n' + grab('secretPick') + '\nreturn { secretOf, secretLocked, secretPick };'
)();

async function run() {
  let n = 0;
  const ok = (c, m) => { n++; assert.ok(c, m); };

  /* 1. secretOf：字符串透传，密文对象/空值一律视同未配置（keyOf 同语义） */
  ok(secretOf('sk-live') === 'sk-live', '明文字符串透传');
  ok(secretOf({ __encrypted: true, data: 'ZW5j' }) === '', '密文对象视同未配置');
  ok(secretOf(undefined) === '' && secretOf(null) === '' && secretOf('') === '', '空值归一为空串');

  /* 2. secretLocked：仅密文对象为真（表单锁定警示用） */
  ok(secretLocked({ __encrypted: true, data: 'x' }) === true, '密文对象判锁定');
  ok(secretLocked('tok') === false && secretLocked(undefined) === false && secretLocked(null) === false, '字符串/空值不判锁定');

  /* 3. secretPick：重填覆盖；留空 + 密文 → 原样带回（同一引用，不抹副本）；留空 + 明文 → 清空生效 */
  ok(secretPick(' ghp_new ', { __encrypted: true }) === 'ghp_new', '重填覆盖且去空白');
  const sealed = { __encrypted: true, data: 'ZW5j' };
  ok(secretPick('', sealed) === sealed, '留空保留密文副本（同引用带回）');
  ok(secretPick(undefined, sealed) === sealed, '表单元素缺失（?.value=undefined）同样保留密文');
  ok(secretPick('   ', sealed) === sealed, '纯空白输入视同留空');
  ok(secretPick('', 'old-plain') === '', '留空 + 明文现值 → 显式清空仍生效');
  ok(secretPick('', undefined) === '', '无现值时留空即空');

  /* 4. gitTokensSave 语义（整键替换下改一边不抹另一边的密文） */
  {
    const prev = { github: { __encrypted: true, data: 'Z2h' }, gitee: 'gt-old' };
    const tokens = { github: secretPick('', prev.github), gitee: secretPick('gt-new', prev.gitee) };
    ok(tokens.github === prev.github, '改 Gitee 时 GitHub 密文原样带回');
    ok(tokens.gitee === 'gt-new', 'Gitee 重填生效');
  }
  /* 5. cloudSave / jevSave 语义 */
  {
    const cloudSealed = { __encrypted: true, data: 'Y2x' };
    ok(secretPick('', cloudSealed) === cloudSealed, '云端令牌留空保留密文');
    ok(secretPick('', 'jev-plain') === '', 'Jev 明文令牌留空即清空');
  }

  /* 6. 表单接线源码断言：回显与保存必须走助手，防后续改动回退到裸 esc(对象) / 裸 trim */
  ok(SRC.includes('esc(secretOf(s.gitTokens?.github))') && SRC.includes('esc(secretOf(s.gitTokens?.gitee))'), 'PAT 双输入框回显走 secretOf');
  ok(!SRC.includes('esc(s.gitTokens?.gitee || \'\')'), 'Gitee 回显不再裸取对象（[object Object] 缺陷源）');
  ok(SRC.includes('esc(secretOf(s.cloudToken))') && !SRC.includes('esc(s.cloudToken || \'\')'), '云端令牌回显走 secretOf');
  ok(SRC.includes('esc(secretOf(cfg.jevKey))') && !SRC.includes('esc(cfg.jevKey || \'\')'), 'Jev Key 回显走 secretOf');
  ok(SRC.includes('secretPick($(\'#gt-github\')?.value, prev.github)') && SRC.includes('secretPick($(\'#gt-gitee\')?.value, prev.gitee)'), 'PAT 保存按成员带回密文');
  ok(SRC.includes('secretPick($(\'#cn-token\').value, hookCfg.cloudToken)'), '云端令牌保存留空带回密文');
  ok(SRC.includes('secretPick(key, hookCfg.jevKey)'), 'Jev 保存留空带回密文');
  ok(SRC.includes('secretOf(hookCfg.jevKey) && (hookCfg.triageEngine'), '自动分诊 Jev 链路真值判定走 secretOf（密文对象不发 Bearer）');

  return n;
}

module.exports = { run };
