/* services/acp.js normUsageTokens + services/runner.js CLI 预置事件流标记
   CLI 型 Agent 此前 done 一律 usage:null，token 花费统计不到；本套件锁住归一口径与预置开关 */
import assert = require('assert');
import runner = require('../services/runner');
import acp = require('../services/acp');

async function run() {
  let n = 0;
  const norm = (acp as any).normUsageTokens;
  const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

  /* claude 家族 stream-json result 帧：input 不含 cache（读写单列），归并进输入侧 */
  eq(norm({ input_tokens: 4, cache_read_input_tokens: 15100, cache_creation_input_tokens: 12, output_tokens: 900 }),
    { prompt_tokens: 15116, completion_tokens: 900, total_tokens: 16016 }, 'claude 形状：cache 并入输入侧');
  /* ZCode ACP session/prompt 响应（camelCase 实测样本）：totalTokens = input + output + cacheRead */
  eq(norm({ totalTokens: 263079, inputTokens: 247972, outputTokens: 3, thoughtTokens: 0, cachedReadTokens: 15104, cachedWriteTokens: 0 }),
    { prompt_tokens: 263076, completion_tokens: 3, total_tokens: 263079 }, 'zcode acp 形状');
  /* OpenAI 兼容形状直通（不重算 total） */
  eq(norm({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 'openai 形状');
  /* total 缺失时按 in+out 兜底 */
  eq(norm({ input_tokens: 10, output_tokens: 5 }), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 'total 缺省兜底');
  /* 全零 / 缺字段 / 非对象：如实 null，不记 0 行 */
  eq(norm({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }), null, '全零不记');
  eq(norm(undefined), null, 'undefined');
  eq(norm('x'), null, '非对象');

  /* 事件流预置：这些引擎实测兼容 stream-json（过程日志与 usage 都来自 result 帧） */
  for (const id of ['claude-code', 'codebuddy', 'qoder', 'qoder-cn']) {
    const p = (runner as any).CLI_PRESETS.find((x: any) => x.id === id);
    eq(!!(p && p.streamJson === true), true, 'streamJson 开启：' + id);
  }
  /* 纯文本引擎不强行开流（输出格式未验证，避免破坏现有执行） */
  for (const id of ['workbuddy', 'codex']) {
    const p = (runner as any).CLI_PRESETS.find((x: any) => x.id === id);
    eq(p && p.streamJson !== true, true, 'streamJson 不强开：' + id);
  }

  /* 端到端：runTask 以 stream-json 假 CLI 走完整链路（spawn→逐帧→done），result 帧 usage/credits 必须落进 done */
  {
    const script = "console.log(JSON.stringify({type:'system',subtype:'init'}));"
      + "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'干着呢'}]}}));"
      + "console.log(JSON.stringify({type:'result',is_error:false,result:'ok',total_credits:1.18,usage:{input_tokens:7,cache_read_input_tokens:100,cache_creation_input_tokens:2,output_tokens:3}}))";
    const agent: any = { id: 'a-e2e', name: '假 qoder', provider: 'cli', mode: 'cli', cliId: 'qoder-cn', cliTemplate: 'node -e ' + JSON.stringify(script) + ' {prompt}' };
    const task: any = { id: 't-e2e', key: 'REINS-9001', title: 'cli usage 端到端', desc: '' };
    const evs: any[] = [];
    await new Promise<void>(res => {
      (runner as any).runTask(task, agent, null, (e: any) => { evs.push(e); if (e.type === 'done' || e.type === 'error') res(); }, {});
      setTimeout(res, 20000);
    });
    const done = evs.find(e => e.type === 'done');
    eq(done && done.usage && done.usage.total_tokens, 112, '端到端 done.usage.total_tokens=112');
    eq(done && done.usage && done.usage.prompt_tokens, 109, '端到端 done.usage.prompt_tokens=109（cache 归并输入侧）');
    eq(done && done.usage && done.usage.completion_tokens, 3, '端到端 done.usage.completion_tokens=3');
    eq(done && done.credits, 1.18, '端到端 done.credits=1.18（qoder 家族积分）');
  }

  return n;
}

module.exports = { run };
