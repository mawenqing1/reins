/* Reins — ComfyUI 桥接：本地视频生成服务（HTTP API，默认 127.0.0.1:8188）
   工作流模板用 ComfyUI「Save (API Format)」导出的 JSON；提交后轮询 /history 直到产出。 */
const fs = require('fs');
const path = require('path');

/* ComfyUI 在本机回环地址上。宿主机器常开系统代理（Clash 等），Electron 主进程的 fetch 走 Chromium 网络栈会继承
   系统代理，代理通常拒绝转发 127.0.0.1 目标（表现为 net::ERR_CONNECTION_REFUSED / fetch failed，而 curl 正常）。
   因此优先用 net.request + proxy:'direct://' 强制直连；纯 Node 环境（无 electron）回退原生 fetch。 */
let _net = null;
try { _net = require('electron').net; } catch (e) { }
const pfetch = (...a) => (global.fetch)(...a);

const POLL_MS = 3000;
const jobs = new Map();   // jobId -> { promptId, cancelled, timer }

const base = cfg => String(cfg?.comfyUrl || 'http://127.0.0.1:8188').trim().replace(/\/+$/, '');

/* net.request 直连版：返回 {status, ok, text()}；失败抛 Error */
function netCall(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = _net.request({ url, method: opts.method || 'GET', proxy: 'direct://' });
    const timer = setTimeout(() => { try { req.abort(); } catch (e) { } reject(new Error('超时')); }, opts.timeout || 8000);
    req.on('response', resp => {
      let data = '';
      resp.on('data', c => data += c.toString());
      resp.on('end', () => {
        clearTimeout(timer);
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { }
        resolve({ status: resp.statusCode, ok: resp.statusCode >= 200 && resp.statusCode < 300, text: async () => data, data: parsed });
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (opts.body != null) {
      for (const [k, v] of Object.entries(opts.headers || {})) req.setHeader(k, v);
      req.write(opts.body);
    }
    req.end();
  });
}

async function call(cfg, api, opts = {}) {
  const url = base(cfg) + api;
  if (_net) return netCall(url, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const resp = await pfetch(url, { ...opts, signal: ctrl.signal });
    const text = await resp.text();
    let data = null; try { data = JSON.parse(text); } catch (e) { }
    return { status: resp.status, ok: resp.ok, data, text };
  } finally { clearTimeout(timer); }
}

/* 探活：GET /system_stats */
async function status(cfg) {
  try {
    const r = await call(cfg, '/system_stats');
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const dev = (r.data?.devices || [])[0] || {};
    return {
      ok: true, url: base(cfg),
      version: r.data?.system?.comfyui_version || r.data?.system?.version || '未知版本',
      device: dev.name || '未知设备',
      vram: dev.vram_total ? Math.round(dev.vram_total / 1024 / 1024 / 1024 * 10) / 10 + ' GB' : '',
    };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? '超时（8s）' : e.message }; }
}

/* 解析 API 格式工作流：找出全部文本编码节点（class_type 含 CLIPTextEncode），启发式猜正/负向 */
function inspectFile(p) {
  let wf = null;
  try { wf = JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { return { ok: false, error: '无法解析 JSON：' + e.message }; }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return { ok: false, error: '不是 API 格式的工作流（应为节点 ID → 节点对象的映射，请用 Save (API Format) 导出）' };
  const negRe = /低质|低质量|模糊|bad ?quality|blurry|watermark|deform|worst ?quality|jpeg|artifacts?|负面|negative/i;
  const nodes = Object.entries(wf)
    .filter(([, n]) => n && typeof n === 'object' && /CLIPTextEncode/i.test(String(n.class_type)))
    .map(([id, n]) => {
      const text = String(n.inputs?.text ?? '');
      return { id, text, guess: negRe.test(text) ? 'neg' : 'pos' };
    });
  const saves = Object.values(wf).filter(n => n && /VideoCombine|SaveImage|SaveAnimatedWEBP/i.test(String(n.class_type))).length;
  if (!nodes.length) return { ok: false, error: '工作流里没找到文本编码节点（CLIPTextEncode）' };
  const pos = nodes.find(n => n.guess === 'pos')?.id || nodes[0].id;
  const neg = nodes.find(n => n.guess === 'neg' && n.id !== pos)?.id || '';
  return { ok: true, nodes, saveNodes: saves, pos, neg };
}

/* 提交生成任务：注入 prompt → POST /prompt → 轮询 /history，阶段变化通过 emit 推给渲染层 */
async function submit({ jobId, prompt, negative }, cfg, emit) {
  const wfPath = cfg?.comfyWorkflow;
  if (!wfPath || !fs.existsSync(wfPath)) { emit({ jobId, type: 'error', error: '工作流模板未配置或文件不存在，请到「集成」页配置' }); return; }
  let wf;
  try { wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8')); }
  catch (e) { emit({ jobId, type: 'error', error: '工作流模板解析失败：' + e.message }); return; }

  const posId = cfg.comfyPosNode, negId = cfg.comfyNegNode;
  if (!wf[posId] || !wf[posId].inputs) { emit({ jobId, type: 'error', error: '正向文本节点 #' + posId + ' 不在模板里，请重新选择' }); return; }
  wf[posId].inputs.text = prompt;
  if (negId && wf[negId] && wf[negId].inputs) wf[negId].inputs.text = negative || String(wf[negId].inputs.text ?? '');
  // 真随机种子：API 格式不执行界面的 control_after_generate=randomize，不换种子同提示词必出同片
  for (const n of Object.values(wf)) {
    if (n && typeof n === 'object' && /^KSampler/.test(String(n.class_type)) && n.inputs && 'seed' in n.inputs) {
      n.inputs.seed = Math.floor(Math.random() * 1e15);
    }
  }

  let promptId = null;
  try {
    const r = await call(cfg, '/prompt', {
      method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: 'reins' }),
    });
    if (!r.ok) {
      const detail = r.data?.error?.message || r.data?.error || r.text?.slice(0, 300) || ('HTTP ' + r.status);
      const ne = r.data?.node_errors;
      const first = ne && Object.entries(ne)[0];
      emit({ jobId, type: 'error', error: 'ComfyUI 拒绝：' + detail + (first ? `（节点 #${first[0]}：${first[1].errors?.[0]?.message || ''}）` : '') });
      return;
    }
    promptId = r.data?.prompt_id;
  } catch (e) {
    emit({ jobId, type: 'error', error: '连不上 ComfyUI（' + base(cfg) + '）：' + (e.name === 'AbortError' ? '超时' : e.message) });
    return;
  }

  const job = { promptId, cancelled: false, timer: null, cfg };
  jobs.set(jobId, job);
  emit({ jobId, type: 'queued', promptId });

  const fail = async error => { stop(); jobs.delete(jobId); emit({ jobId, type: 'error', error }); };
  const stop = () => { if (job.timer) { clearTimeout(job.timer); job.timer = null; } };
  const tick = async () => {
    try {
      const r = await call(cfg, '/history/' + promptId, { timeout: 10000 });
      if (!r.ok) return;                       // 偶发失败不致命，下轮再看
      const h = r.data?.[promptId];
      if (!h) {                                // 还在队列里/执行中
        if (!job.cancelled) emit({ jobId, type: 'running' });
        return;
      }
      if (h.status?.status_str === 'error') {
        return fail('ComfyUI 执行出错：' + (h.status?.messages?.map(m => String(m[1])).join(' ') || '未知原因').slice(0, 300));
      }
      if (!h.status?.completed) {
        if (!job.cancelled) emit({ jobId, type: 'running' });
        return;
      }
      // 完成：从各节点 outputs 里收集产物（video 合并节点在 gifs/images 键下）
      const outputs = [];
      for (const out of Object.values(h.outputs || {}))
        for (const arr of Object.values(out || {}))
          if (Array.isArray(arr)) for (const f of arr) if (f && f.filename)
            outputs.push({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output',
              url: `${base(cfg)}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${encodeURIComponent(f.type || 'output')}`,
              src: `comfy://media/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${encodeURIComponent(f.type || 'output')}` });
      const video = outputs.find(o => /\.(mp4|webm|gif|webp|mov)$/i.test(o.filename)) || outputs[0] || null;
      stop(); jobs.delete(jobId);
      emit({ jobId, type: 'done', video, outputs });
    } catch (e) {
      stop(); jobs.delete(jobId);
      emit({ jobId, type: 'error', error: '轮询 ComfyUI 失败：' + e.message });
    }
  };
  const loop = async () => { await tick(); const j = jobs.get(jobId); if (j && j.timer !== null) { j.timer = setTimeout(loop, POLL_MS); } };
  // 完成前保持 timer 句柄；cancel 后停止
  job.timer = setTimeout(loop, 600);
  jobs.set(jobId, job);
}

/* 取消：从队列移除；若正在执行则中断 */
async function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  if (job.timer) { clearTimeout(job.timer); job.timer = null; }
  jobs.delete(jobId);
  const cfg = job.cfg || {};
  try { await call(cfg, '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [job.promptId] }) }); } catch (e) { }
  try { await call(cfg, '/interrupt', { method: 'POST' }); } catch (e) { }
  return true;
}

module.exports = { status, inspectFile, submit, cancel, registerProxy, pickDialog: { filters: [{ name: 'ComfyUI 工作流（API 格式）', extensions: ['json'] }] } };

/* ---------- comfy:// 媒体代理 ----------
   Chromium 的 <video> 直接消费 ComfyUI(aiohttp) /view 响应会报 MEDIA_ELEMENT_ERROR: Format error
   （字节与响应头均正常、同内容经其它 HTTP 服务可播——仅 aiohttp 的组合触发）。规避：注册 comfy://
   协议，主进程用 net.request(direct) 拉流并按 Web Response 回给渲染层，头重写为最简集合。 */
function registerProxy(electron, readCfg) {
  const { protocol, net, app } = electron;
  try {
    protocol.registerSchemesAsPrivileged([{ scheme: 'comfy', privileges: { stream: true, supportFetchAPI: true, bypassCSP: false } }]);
  } catch (e) { }  // 重复调用（热重载场景）会抛错，忽略
  const whenReady = app.whenReady();
  whenReady.then(() => {
    protocol.handle('comfy', req => {
      const u = new URL(req.url);
      const target = base(readCfg()) + '/view?' + u.searchParams.toString();
      return new Promise(resolve => {
        const opts = { url: target, method: 'GET', proxy: 'direct://' };
        const range = req.headers.get('range');
        const preq = net.request(opts);
        if (range) preq.setHeader('Range', range);
        preq.on('response', resp => {
          const headers = { 'Content-Type': resp.headers['content-type'] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
          if (resp.headers['content-length']) headers['Content-Length'] = resp.headers['content-length'];
          if (resp.headers['content-range']) headers['Content-Range'] = resp.headers['content-range'];
          const { Readable } = require('stream');
          const web = Readable.toWeb(resp);
          resolve(new Response(web, { status: resp.statusCode, headers }));
        });
        preq.on('error', () => resolve(new Response('', { status: 502 })));
        preq.end();
      });
    });
  });
}
