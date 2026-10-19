/* ============================================================
   Reins — 流水线阶段依赖编排（纯函数，主进程执行 / 渲染层展示共用同一语义）
   ------------------------------------------------------------
   数据模型（阶段对象在既有 roleKey/name/goal/state/result 基础上扩展）：
     id: 's1'..'sN'        稳定阶段标识（按数组序分配，规划输出即冻结）
     dependsOn: ['s1', …]  直接依赖的阶段 id 集合（该阶段只依赖这些产出，而非"前面全部"）
   行为约定：
     - 完全没有阶段声明 dependsOn → 逐阶段单波次执行，与既有串行接力行为完全一致（向后兼容）
     - 声明了依赖 → Kahn 分层，同层无依赖阶段可并行（Promise.allSettled 由执行方驱动）
     - 任一并行阶段失败不阻塞同层其他阶段，但阻塞其全部下游依赖阶段（由 waves 结构天然保证）
     - 依赖成环（PM 规划失误）→ 环上节点按原顺序追加为末波并标记 hasCycle：
       宁可顺序推进也不死锁，环信息上抛供界面警示
   ============================================================ */

/* 依赖声明归一化：补 id、清洗 dependsOn（容错数字序号 [1] 与 's1' 两种写法、
   去未知 id / 自引用 / 重复），返回新数组（不改动入参）。
   depsExplicit 标记「原始数据显式给出过 dependsOn 字段」——区分"旧数据没这概念"
   与"规划明确声明空依赖（并行根）"，串行回退判定靠它 */
function normalizeDeps(stages) {
  const list = (Array.isArray(stages) ? stages : []).filter(s => s && typeof s === 'object');
  const ids = list.map((s, i) => (typeof s.id === 'string' && s.id ? s.id : 's' + (i + 1)));
  return list.map((s, i) => {
    const own = ids[i];
    const raw = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    const deps = [];
    for (let d of raw) {
      if (Number.isFinite(Number(d)) && String(d).trim() !== '' && !/^[a-z]/i.test(String(d).trim())) d = 's' + Number(d);
      d = String(d).trim();
      // 未知依赖 / 自引用 / 重复一律剔除：PM 输出的 dependsOn 不可信，清洗后才能进执行图
      if (ids.includes(d) && d !== own && !deps.includes(d)) deps.push(d);
    }
    return Object.assign({}, s, { id: own, dependsOn: deps, depsExplicit: Array.isArray(s.dependsOn) });
  });
}

/* 并行波次规划（Kahn 分层）。返回：
   waves   二维数组，每波是可同时启动的阶段下标（原数组下标）
   order   拓扑序的全部下标（波次展平）
   hasCycle 是否存在环（环上节点被强制排入末波） */
function planWaves(stages) {
  const list = normalizeDeps(stages);
  const n = list.length;
  if (!n) return { waves: [], order: [], hasCycle: false };

  /* 向后兼容：没有任何阶段显式声明过 dependsOn → 保持串行接力（每个阶段单独一波，
     按原顺序），既有流水线行为不变；甘特图也按此退化为单列。
     混合场景（部分阶段声明了依赖）：未声明的阶段视为并行根节点 */
  if (!list.some(s => s.depsExplicit)) {
    const seq = list.map((s, i) => i);
    return { waves: seq.map(i => [i]), order: seq, hasCycle: false };
  }

  const idxById = {};
  list.forEach((s, i) => { idxById[s.id] = i; });
  const indeg = new Array(n).fill(0);
  const children = list.map(() => []);
  for (let i = 0; i < n; i++) {
    for (const d of list[i].dependsOn) {
      const j = idxById[d];
      if (j !== undefined) { indeg[i]++; children[j].push(i); }
    }
  }
  const waves = [];
  const order = [];
  let frontier = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) frontier.push(i);
  const seen = new Array(n).fill(false);
  while (frontier.length) {
    for (const i of frontier) { seen[i] = true; order.push(i); }
    waves.push(frontier.slice());
    const next = [];
    for (const i of frontier) for (const c of children[i]) if (--indeg[c] === 0 && !seen[c]) next.push(c);
    frontier = next;
  }
  // 环上剩余节点：按原顺序追加为末波（顺序推进优于死锁），并如实上报 hasCycle
  const rest = [];
  for (let i = 0; i < n; i++) if (!seen[i]) rest.push(i);
  if (rest.length) { waves.push(rest); order.push(...rest); }
  return { waves, order, hasCycle: rest.length > 0 };
}

/* 下游上下文合并：取 stageId 直接依赖阶段的产出，按完成时间升序拼接
   （无完成时间的依赖排在最前，保持数组序），供下游阶段作为输入。
   单段产出超长截断（默认 4000 字符，与既有流水线上下文截断一致） */
function mergeUpstream(stages, stageId, opts) {
  const maxChars = opts && Number.isFinite(opts.maxChars) ? opts.maxChars : 4000;
  const list = normalizeDeps(stages);
  const me = list.find(s => s.id === String(stageId));
  if (!me) return { text: '', sources: [] };
  const deps = me.dependsOn
    .map(id => list.find(s => s.id === id))
    .filter(s => s && s.result != null && String(s.result) !== '')
    .slice()
    .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
  const parts = deps.map(s => '—— ' + s.name + '（' + s.id + '）——\n' + String(s.result).slice(0, maxChars));
  return { text: parts.join('\n\n'), sources: deps.map(s => s.id) };
}

module.exports = { normalizeDeps, planWaves, mergeUpstream };
