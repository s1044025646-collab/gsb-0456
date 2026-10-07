import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { Store } from '../src/db.js';
import { DitherService } from '../src/service.js';
import { AppError } from '../src/errors.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'fs-dither-test-'));
}

test('导入幂等、模式产生独立报告、预算只截断展示', () => {
  const store = new Store(join(dir(), 'd.db'));
  after(() => store.close());
  const svc = new DitherService(store);

  const m = [
    [0, 255, 100],
    [200, 30, 170],
  ];
  const a = svc.importMatrix(m);
  const b = svc.importMatrix(m.map((r) => [...r]));
  assert.equal(a.id, b.id);
  assert.equal(b.duplicated, true);

  const lr1 = svc.runReport(a.id, 'lr', 'discard');
  const lr2 = svc.runReport(a.id, 'lr', 'discard');
  const sp = svc.runReport(a.id, 'serpentine', 'discard');
  assert.equal(lr1.id, lr2.id);
  assert.notEqual(lr1.id, sp.id);

  const full = svc.getReport(lr1.id);
  assert.equal(full.pixels.length, 6);
  assert.equal(full.officialComputationComplete, true);
  assert.equal(full.truncation.truncated, false);

  const cut = svc.getReport(lr1.id, '3');
  assert.equal(cut.pixels.length, 3);
  assert.equal(cut.truncation.truncated, true);
  assert.match(cut.truncation.explanation, /截断/);
  // 预算不影响正式输出与汇总
  assert.deepEqual(cut.output, full.output);
  assert.deepEqual(cut.summary, full.summary);

  const px = svc.getPixel(lr1.id, '0', '1');
  assert.equal(px.original, 255);
  assert.equal(typeof px.workingValue, 'number');
  assert.throws(() => svc.getPixel(lr1.id, '9', '9'), AppError);
  assert.throws(() => svc.getReport('rp_nope'), AppError);
});

test('从冻结原图重算与已保存报告一致（模拟重启：重新打开数据库）', () => {
  const d = dir();
  const path = join(d, 'd.db');
  const m = [[1, 200, 99, 250], [150, 30, 180, 60]];
  let reportId: string;
  {
    const store = new Store(path);
    const svc = new DitherService(store);
    const ds = svc.importMatrix(m);
    reportId = svc.runReport(ds.id, 'serpentine', 'discard').id;
    store.close();
  }
  {
    const store = new Store(path);
    const svc = new DitherService(store);
    const v = svc.verifyReport(reportId);
    assert.equal(v.outputMatches, true);
    assert.equal(v.summaryConservationVerified, true);
    const view = svc.getReport(reportId);
    assert.equal(view.mode, 'serpentine');
    store.close();
  }
});

test('导出 PGM 为 P5 且仅含 0/255', () => {
  const store = new Store(join(dir(), 'd.db'));
  after(() => store.close());
  const svc = new DitherService(store);
  const ds = svc.importMatrix([[0, 128], [255, 64]]);
  const rp = svc.runReport(ds.id, 'lr', 'discard');
  const file = svc.exportMatrix(rp.id, 'output');
  assert.match(file.body.subarray(0, 2).toString('ascii'), /P5/);
  const headerEnd = file.body.indexOf(Buffer.from('255\n'), 0) + 4;
  for (const byte of file.body.subarray(headerEnd)) {
    assert.ok(byte === 0 || byte === 255);
  }
});
