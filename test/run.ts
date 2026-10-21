/* 测试入口：node dist/test/run.js —— 顺序跑 test/*.test.js，零依赖（Node 16+ 兼容） */
import fs = require('fs');
import path = require('path');

(async () => {
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
  let pass = 0, fail = 0, asserts = 0;
  for (const f of files) {
    try {
      const m = require(path.join(__dirname, f));
      const n = await m.run();
      pass++;
      asserts += n || 0;
      console.log('✓ ' + f + '  (' + (n || 0) + ' 断言)');
    } catch (e) {
      fail++;
      console.error('✗ ' + f);
      console.error('   ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n   ') : e));
    }
  }
  console.log('\n' + pass + ' 个文件通过, ' + fail + ' 个失败, 共 ' + asserts + ' 断言');
  process.exit(fail ? 1 : 0);
})();
