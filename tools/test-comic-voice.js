/* 配音引擎（独立 /audio/speech 通道）单测：
   请求形状（URL/鉴权/voice 参数/500 字截断）、音色表（配置优先/内置回落/custom 无表）、
   提示词注入（bible 音色表、剧本 who 字段）、precheck 配音分支、manager 三件套与旧配置迁移 */
'use strict';
const assert = require('assert');
const comic = require('../services/comic.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}
process.on('exit', () => { console.log(`\n结果：${passed} 通过 · ${failed} 失败`); process.exit(failed ? 1 : 0); });

async function main() {
  const tmp = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'reins-voice-'));

  console.log('\n[1] genVoice 请求形状（独立 baseURL / 免鉴权 / voice 参数 / 文本截断）');
  {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const dest = require('path').join(tmp, 'a.mp3');
    await comic._internal.genVoice({ baseURL: 'http://127.0.0.1:8884/v1/', apiKey: '', model: 'kokoro', voice: 'zf_001' },
      '台'.repeat(600), dest, { fetchImpl: f, voiceId: 'zm_009' });
    const c = calls[0];
    ok(c.url === 'http://127.0.0.1:8884/v1/audio/speech', 'URL = 配音引擎 baseURL + /audio/speech（尾斜杠归一）');
    ok(!c.init.headers.Authorization, '本地免鉴权：无 Key 不带 Authorization');
    const body = JSON.parse(c.init.body);
    ok(body.voice === 'zm_009', 'voice 参数：镜头角色音色（voiceId）优先于默认音色');
    ok(body.input.length === 500, '台词截断至 500 字');
    ok(body.response_format === undefined, '不强制 response_format（载荷格式由服务端定，本地为 WAV）');
    ok(require('fs').readFileSync(dest).length === 3, '音频字节落盘');
    // 有 Key 时带鉴权
    const calls2 = [];
    await comic._internal.genVoice({ baseURL: 'https://x/v1', apiKey: 'sk-1', model: 'cogtts', voice: '' },
      '你好', require('path').join(tmp, 'b.mp3'), { fetchImpl: async (u, i) => { calls2.push({ u, i }); return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer }; } });
    ok(calls2[0].i.headers.Authorization === 'Bearer sk-1', '有 Key 带 Bearer');
    ok(JSON.parse(calls2[0].i.body).voice === undefined, '无音色时 body 不带 voice 字段');
    // 未配置直接点名
    let threw = '';
    try { await comic._internal.genVoice({ baseURL: '', model: '', apiKey: '' }, 'x', require('path').join(tmp, 'c.mp3'), { fetchImpl: f }); }
    catch (e) { threw = e.message; }
    ok(/未配置配音引擎/.test(threw), '未配置配音引擎 → 点名错误');
  }

  console.log('\n[2] 音色表：配置 voices 优先 / kokoro 内置回落 / custom 无表');
  {
    const t1 = comic._internal.parseVoiceTable({ preset: 'kokoro' });
    ok(Array.isArray(t1) && t1.length >= 8 && t1.every(x => x[0] && x[1]), 'kokoro 预设无自定义 → 内置中文音色表');
    const t2 = comic._internal.parseVoiceTable({ preset: 'kokoro', voices: 'zf_001=女主,zm_009=男主' });
    ok(t2.length === 2 && t2[0][0] === 'zf_001' && t2[1][1] === '男主', '配置 voices（id=描述）覆盖内置表');
    ok(comic._internal.parseVoiceTable({ preset: 'custom' }) === null, 'custom 未填 voices → 无表（不注入提示词）');
  }

  console.log('\n[3] 提示词：bible 音色表注入 / 剧本 who 字段');
  {
    const c = { title: '测试', theme: '', style: '', episodes: [], shotsPer: 8 };
    const p0 = comic._internal.biblePrompt(c, null);
    ok(!/【配音音色】/.test(p0.sys), '无音色表：设定提示词不注入音色段');
    const p1 = comic._internal.biblePrompt(c, [['zf_001', '女主播'], ['zm_009', '低沉男主']]);
    ok(/【配音音色】/.test(p1.sys) && p1.sys.includes('zf_001') && p1.sys.includes('zm_009'), '有音色表：注入 id 供角色挑选');
    const sp = comic._internal.scriptPrompt(c, { n: 1 });
    ok(/"who"/.test(sp.sys) && /旁白/.test(sp.sys), '剧本 schema 含 who 字段（旁白约定）');
    const shot = comic.normalizeShot({ desc: 'd', who: '林野', dialogue: '走', camera: '近景', duration: 5 }, 0);
    ok(shot.who === '林野', 'normalizeShot 保留 who');
  }

  console.log('\n[4] precheck：配音分支（显式单跑才强校验）');
  {
    const eng = { writer: { baseURL: 'https://x', apiKey: 'k' }, render: { provider: 'comfy', baseURL: 'http://127.0.0.1:8188' } };
    const job = { comic: { id: 'c1', episodes: [] }, scope: {} };
    ok(comic._internal.precheck(job, eng).ok === true, '全流程未配置配音 → 放行（可选阶段自动跳过）');
    const r2 = comic._internal.precheck({ comic: { id: 'c1', episodes: [] }, scope: { stage: 'voice' } }, eng);
    ok(r2.ok === false && /配音引擎未配置/.test(r2.error), '单跑配音未配置 → 点名「设置 → 配音引擎」');
    const r3 = comic._internal.precheck({ comic: { id: 'c1', episodes: [] }, scope: { stage: 'voice' } },
      { ...eng, voice: { baseURL: 'http://127.0.0.1:8884/v1', model: 'kokoro' } });
    ok(r3.ok === true, '配音引擎就绪 → 单跑配音放行');
  }

  console.log('\n[5] manager：voiceEngine 三件套 + 旧 render.voiceModel 迁移');
  {
    const os = require('os'); const path = require('path'); const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reins-cm-voice-'));
    const settingsFile = path.join(dir, 'settings.json');
    const mgr = require('../services/comic-manager').create({
      readSettings: () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { return {}; } },
      writeSettings: s => fs.writeFileSync(settingsFile, JSON.stringify(s)),
      audioDir: path.join(dir, 'audio'),
    });
    ok(mgr.getVoiceEngine() === null, '从未配置 → null（配音跳过，不落预置默认）');
    const r1 = await mgr.setVoiceEngine({ preset: 'kokoro' });
    ok(r1.ok && r1.engine.preset === 'kokoro' && r1.engine.baseURL === 'http://127.0.0.1:8884/v1' && r1.engine.model === 'kokoro', '切 kokoro 预设：带默认地址/模型/音色');
    const g = mgr.getVoiceEngine();
    ok(g && g.baseURL.includes('8884') && g.voice, '落盘回读一致');
    const r2 = await mgr.setVoiceEngine({ preset: 'custom' });
    ok(r2.ok && r2.engine.preset === 'custom' && r2.engine.baseURL === '' && r2.engine.model === '', '切 custom：清空预设默认（避免误指向本地端口）');
    // 迁移：旧 voiceModel 挂在 zhipu 渲染引擎上
    await mgr.setRenderEngine({ provider: 'zhipu', apiKey: 'sk-z', voiceModel: 'cogtts' });
    await mgr.setVoiceEngine({ preset: 'custom', baseURL: '', model: '' });   // 清空配音
    const eng1 = mgr.resolveEngines({ writer: { baseURL: 'https://x', apiKey: 'k' } });
    ok(eng1.voice && eng1.voice.model === 'cogtts' && eng1.voice.baseURL.includes('bigmodel'), '迁移：云端渲染引擎的 voiceModel 自动沿用为配音引擎');
    await mgr.setRenderEngine({ provider: 'comfy' });
    await mgr.setRenderEngine({ provider: 'zhipu', voiceModel: '' });   // comfy 不迁移 + 清掉 zhipu 旧字段
    const eng2 = mgr.resolveEngines({ writer: { baseURL: 'https://x', apiKey: 'k' } });
    ok(!eng2.voice || (!eng2.voice.baseURL && !eng2.voice.model), 'comfy 渲染无 /audio/speech → 不迁移（保持未配置）');
    // 真实探活（本机 ~/reins-tts 在线时通过；离线时报连接失败也算通过形状）
    const t = await mgr.testVoiceEngine({ preset: 'kokoro' });
    ok(t && (t.ok === true || /连接失败|HTTP/.test(t.message)), `探活返回可读结果：${t && t.message}`);
  }
}
main().catch(e => { console.error('测试异常:', e); process.exitCode = 1; });
