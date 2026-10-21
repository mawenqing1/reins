/* ============================================================
   Reins — 大文本外置（state 瘦身）
   ------------------------------------------------------------
   问题：任务状态档 reins-data.json 是「每次保存全量序列化」，而流水线任务的
   各阶段完整产出（pipeline.stages[].result）和交付正文（task.result）会一直
   留在内存态里。实测一个跑过多轮的流水线任务，单任务的 pipeline 就占 68K，
   五张任务卡撑到 200K+；任务一多就是几 MB 的整档读写，每次 save 都要序列化一遍。

   方案：把超过阈值的正文写到 deliverables 目录（下称「正文库」），state 里只留
   一个 { __text: true, ref, bytes, preview } 引用对象。引用是**惰性可读**的：
   - 界面预览用 preview（截断前 400 字），不读盘也能显示摘要
   - 需要全文时（预览/下载/喂给下游阶段）由异步壳读取，读到之前用 preview 兜底
   - 引用本身可 JSON 序列化，旧档（纯字符串）与新档（引用对象）共存，无需迁移标记

   安全性：ref 只允许「相对路径 + 受控字符」，读取时做规范化与前缀校验，
   杜绝 state 被手工改坏后越权读取任意文件。
   ============================================================ */

/* 超过这个字节数才外置：小文本留在 state 里读起来更简单，也避免海量小文件 */
const THRESHOLD = 8192;
const PREVIEW_CHARS = 400;
const REF_PREFIX = 'text/';

const isRef = (v: any): boolean => !!(v && typeof v === 'object' && v.__text === true && typeof v.ref === 'string');

/* 引用值：ref 形如 text/<taskKey>/<slot>.md。
   清洗要保证产出必然能过 safeRef，同时保留可读性（任务号 REINS-42 要原样出现）。
   分两级：先把非法字符转下划线、连续点收成一个（杜绝 '..' 片段），
   再只保留 [字母数字 - _]——点在这一级被彻底剔除，'a..b' 之类不可能残留穿越片段 */
function makeRef(taskKey: string, slot: string): string {
  const clean = s => {
    const mapped = String(s || '').replace(/[^\w.-]+/g, '_').replace(/\.{2,}/g, '.');
    const safe = mapped.replace(/[^A-Za-z0-9_-]/g, '').replace(/^[-_]+|[-_]+$/g, '').slice(0, 80);
    return safe || 'x';
  };
  return REF_PREFIX + clean(taskKey) + '/' + clean(slot) + '.md';
}

/* 纯函数：判断一个字符串该不该外置；不外置返回原值，外置返回引用对象。
   store 是宿主注入的写盘函数 write(ref, text) → 绝对路径（失败时抛错，调用方保留原值） */
function toRef(text: any, taskKey: string, slot: string, store: (ref: any, text: any) => any): any {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= THRESHOLD || !store) return text;
  const ref = makeRef(taskKey, slot);
  try { store(ref, s); } catch (e) { return text; }   // 写失败不外置：数据不能丢
  return { __text: true, ref, bytes, preview: s.slice(0, PREVIEW_CHARS) };
}

/* 预览：引用取 preview，普通字符串原样（截断到 n 字）；保证界面永远拿到字符串 */
function previewOf(v: any, n?: any): string {
  const limit = Number.isFinite(Number(n)) ? Number(n) : PREVIEW_CHARS;
  if (isRef(v)) return String(v.preview || '');
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

/* 摘要长度：引用看 bytes，字符串看字符数（用于「已外置 N KB」这类提示） */
function bytesOf(v: any): number {
  if (isRef(v)) return Number(v.bytes) || 0;
  return Buffer.byteLength(typeof v === 'string' ? v : '', 'utf8');
}

/* ref 合法性校验：只认 text/ 前缀 + 相对路径，拒绝绝对路径与 .. 穿越。
   返回规范化后的相对路径或 null */
function safeRef(ref: any): string | null {
  const s = String(ref || '').trim();
  if (!s || s.length > 200) return null;
  if (!s.startsWith(REF_PREFIX)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\')) return null;
  if (s.split(/[\\/]/).some(seg => seg === '..' || seg === '.')) return null;
  if (!/^[\w./-]+$/.test(s)) return null;
  return s;
}

/* 把 ref 解析成正文库内的绝对路径；越界返回 null（调用方拒绝读取） */
function resolveRef(root: string, ref: any): string | null {
  const s = safeRef(ref);
  if (!s) return null;
  const path = require('path');
  const base = path.resolve(root);
  const abs = path.resolve(base, s);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/* 引用降级（归档正文清理）：返回带 purged 标记的新引用对象；非引用或已清理返回 null。
   purged 引用只保留 preview 摘要，正文文件由宿主删除；体检对 purged 不再要求文件存在 */
function purgeRef(v: any): any {
  if (!isRef(v) || v.purged === true) return null;
  return { __text: true, ref: v.ref, bytes: Number(v.bytes) || 0, preview: String(v.preview || ''), purged: true };
}

export = { THRESHOLD, PREVIEW_CHARS, REF_PREFIX, isRef, makeRef, toRef, previewOf, bytesOf, safeRef, resolveRef, purgeRef };
