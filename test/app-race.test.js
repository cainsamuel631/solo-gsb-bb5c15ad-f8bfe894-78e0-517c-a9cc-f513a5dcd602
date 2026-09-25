'use strict';

// 主上传区串稿防护测试：用最小 DOM stub 在 vm 中加载 public/app.js，
// 模拟「请求尚未返回时切换文件 / 重新操作」，断言旧请求的成功、失败与
// 收尾（按钮启用等）都不会回填界面或误启按钮；并覆盖选中非 PDF 时
// 清除已选文件、禁用校验与拼版入口的行为。测试不启动服务、不监听端口。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- 最小 DOM stub ----------

function makeClassList() {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    toggle: (c, force) => {
      const want = force === undefined ? !set.has(c) : Boolean(force);
      if (want) set.add(c); else set.delete(c);
      return want;
    },
    contains: (c) => set.has(c),
  };
}

const createdElements = [];

function makeEl(tagName) {
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    classList: makeClassList(),
    _listeners: {},
    _clickCount: 0,
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    files: [],
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    appendChild(child) { this.children.push(child); return child; },
    append(...cs) { this.children.push(...cs); },
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelectorAll(selector) { return queryWithin(this, selector); },
    querySelector() { return null; },
    click() { this._clickCount += 1; },
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); if (v === '') el.children = []; },
  });
  createdElements.push(el);
  return el;
}

function collectDescendants(el, out) {
  for (const child of el.children) {
    if (child && typeof child === 'object') {
      out.push(child);
      collectDescendants(child, out);
    }
  }
  return out;
}

function queryWithin(root, selector) {
  const all = collectDescendants(root, []);
  if (selector === 'tr.paper-row') {
    return all.filter((e) => e.tagName === 'TR' && e.className.split(/\s+/).includes('paper-row'));
  }
  if (selector === 'input') {
    return all.filter((e) => e.tagName === 'INPUT');
  }
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return all.filter((e) => e.className.split(/\s+/).includes(cls));
  }
  return [];
}

const filterChips = ['all', 'error', 'warning', 'info'].map((level) => {
  const el = makeEl('button');
  el.dataset.level = level;
  return el;
});
const chipCounts = ['all', 'error', 'warning', 'info'].map((level) => {
  const el = makeEl('span');
  el.dataset.count = level;
  return el;
});
const diffChips = ['added', 'resolved', 'persistent'].map((group) => {
  const el = makeEl('button');
  el.dataset.group = group;
  return el;
});

const elementsById = new Map();
const documentStub = {
  activeElement: null,
  body: makeEl('body'),
  getElementById(id) {
    if (!elementsById.has(id)) elementsById.set(id, makeEl('div'));
    return elementsById.get(id);
  },
  createElement: (tag) => makeEl(tag),
  createElementNS: (ns, tag) => makeEl(tag),
  createDocumentFragment: () => makeEl('fragment'),
  querySelectorAll(selector) {
    if (selector === '.filter-chip') return filterChips;
    if (selector === '.chip-count') return chipCounts;
    if (selector === '.diff-filter-chip') return diffChips;
    return [];
  },
};

const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// fetch stub：记录每次调用，返回由测试手动 resolve 的 promise
const fetchCalls = [];
function fetchStub(url, opts) {
  const call = { url, opts };
  call.promise = new Promise((resolve, reject) => {
    call.resolve = resolve;
    call.reject = reject;
  });
  fetchCalls.push(call);
  return call.promise;
}

const createdBlobs = [];
class BlobStub {
  constructor(parts, opts) {
    this.parts = parts;
    this.opts = opts;
    createdBlobs.push(this);
  }
}

class FormDataStub {
  constructor() { this.entries = []; }
  append(k, v) { this.entries.push([k, v]); }
}

let blobUrlSeq = 0;
const URLStub = {
  createObjectURL: () => `blob:mock-${(blobUrlSeq += 1)}`,
  revokeObjectURL: () => {},
};

const sandbox = {
  document: documentStub,
  localStorage: localStorageStub,
  fetch: fetchStub,
  URL: URLStub,
  FormData: FormDataStub,
  Blob: BlobStub,
  setTimeout,
  clearTimeout,
  console,
};

const appCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInNewContext(appCode, sandbox, { filename: 'public/app.js' });

// ---------- 测试辅助 ----------

const $ = (id) => documentStub.getElementById(id);
const tick = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};
function fire(el, type) {
  const fns = (el._listeners && el._listeners[type]) || [];
  return Promise.all(fns.map((fn) => fn()));
}
function pickFile(file) {
  const input = $('file-input');
  input.files = file ? [file] : [];
  return fire(input, 'change');
}
const callsFor = (url) => fetchCalls.filter((c) => c.url === url);
const anchorCount = () => createdElements.filter((e) => e.tagName === 'A').length;
const lastAnchor = () => createdElements.filter((e) => e.tagName === 'A').pop();

const pdfFile = (name) => ({ name, type: 'application/pdf', size: 2048 });

function makeReport(pageCount) {
  return {
    pageCount,
    referenceSize: { widthMm: 210, heightMm: 297 },
    summary: { passed: true, error: 0, warning: 0, info: 0, pagesWithIssues: 0 },
    issues: [],
    pages: [],
  };
}

function makePlan(sourceCount) {
  const sheets = [];
  for (let i = 0; i < Math.ceil(sourceCount / 4); i += 1) {
    sheets.push({
      sheet: i + 1,
      front: { left: { blank: false, page: sourceCount }, right: { blank: false, page: 1 } },
      back: { left: { blank: false, page: 2 }, right: { blank: false, page: 3 } },
    });
  }
  return {
    sheets,
    sourceCount,
    paddedCount: sourceCount,
    totalCount: sourceCount,
    blanks: 0,
    panel: { width: 595, height: 842, orientation: 'portrait' },
    sheet: { width: 1190, height: 842 },
    marks: { enabled: false, marginMm: 0 },
    creep: { enabled: false, paperThicknessMm: 0 },
  };
}

function makeQuote(name) {
  return {
    feasible: true,
    layout: {
      sheet: { widthMm: 420, heightMm: 297 },
      panel: { widthMm: 210, heightMm: 297 },
      sheetCount: 2,
      runCount: 1,
      signatureMode: false,
      signatureCount: null,
    },
    options: [{
      index: 0,
      name,
      fits: true,
      paper: { widthMm: 420, heightMm: 297, pricePerSheet: 0.8, setupFee: 50 },
      placement: { rotated: false, paperWidthUsedMm: 420, paperHeightUsedMm: 297 },
      utilizationPercent: 100,
      sheetCount: 2,
      runCount: 1,
      paperCost: 1.6,
      setupCost: 50,
      totalCost: 51.6,
    }],
    selected: { index: 0, name, utilizationPercent: 100, totalCost: 51.6 },
  };
}

const jsonResponse = (data) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => data,
  blob: async () => ({}),
});

const imposeResponse = (plan) => ({
  ok: true,
  status: 200,
  headers: {
    get: (k) => (k === 'X-Imposition-Plan' ? encodeURIComponent(JSON.stringify(plan)) : null),
  },
  json: async () => ({}),
  blob: async () => ({}),
});

const reprintResponse = () => ({
  ok: true,
  status: 200,
  headers: {
    get: (k) => (k === 'X-Reprint-Plan' ? encodeURIComponent(JSON.stringify({})) : null),
  },
  json: async () => ({}),
  blob: async () => ({}),
});

(async () => {
  // 裁切模块读取「所需印张数」输入框（HTML 中默认 1），stub 中显式置 1
  $('cutting-required').value = '1';

  // ---------- 场景 1：校验在飞时切换文件，旧校验不得回填、不得误启按钮 ----------
  await pickFile(pdfFile('A.pdf'));
  assert.strictEqual($('preflight-btn').disabled, false);
  assert.strictEqual($('impose-btn').disabled, false);

  fire($('preflight-btn'), 'click'); // A 的校验（挂起）
  assert.strictEqual(callsFor('/api/preflight').length, 1);
  assert.strictEqual($('preflight-btn').disabled, true);
  assert.strictEqual($('impose-btn').disabled, true);

  await pickFile(pdfFile('B.pdf')); // 校验未返回即切换文件
  assert.strictEqual($('preflight-btn').disabled, false, '切换文件后按钮按新稿件状态启用');
  assert.strictEqual($('impose-btn').disabled, false);

  fire($('preflight-btn'), 'click'); // B 的校验（挂起），按钮再次禁用
  assert.strictEqual(callsFor('/api/preflight').length, 2);
  assert.strictEqual($('preflight-btn').disabled, true);
  assert.strictEqual($('impose-btn').disabled, true);

  callsFor('/api/preflight')[0].resolve(jsonResponse(makeReport(4))); // A 的旧响应返回
  await tick();
  assert.strictEqual($('report').hidden, true, '旧稿报告不得重新出现');
  assert.strictEqual($('preflight-btn').disabled, true, '旧请求的收尾不得误启校验按钮');
  assert.strictEqual($('impose-btn').disabled, true, '旧请求的收尾不得误启拼版按钮');
  assert.ok(!$('status').textContent.includes('校验完成'), '旧请求不得覆盖当前状态');

  callsFor('/api/preflight')[1].resolve(jsonResponse(makeReport(8))); // B 的响应返回
  await tick();
  assert.strictEqual($('report').hidden, false, '当前稿件的报告正常渲染');
  assert.strictEqual($('preflight-btn').disabled, false);
  assert.strictEqual($('impose-btn').disabled, false);
  assert.ok($('status').textContent.includes('校验完成'));

  // 报告下载：文件名与内容都必须属于当前稿件 B
  await fire($('report-download-btn'), 'click');
  assert.strictEqual(lastAnchor().download, 'B-印前校验报告.json');
  assert.strictEqual(JSON.parse(createdBlobs[createdBlobs.length - 1].parts[0]).pageCount, 8);

  // ---------- 场景 2：拼版在飞时切换文件，旧拼版不得回填、不得触发报价/裁切 ----------
  await pickFile(pdfFile('C.pdf'));
  fire($('impose-btn'), 'click'); // C 的拼版（挂起）
  assert.strictEqual(callsFor('/api/impose').length, 1);
  assert.strictEqual($('impose-btn').disabled, true);

  await pickFile(pdfFile('D.pdf')); // 拼版未返回即切换文件
  assert.strictEqual($('impose-btn').disabled, false);

  fire($('preflight-btn'), 'click'); // D 的校验（挂起），使拼版按钮处于禁用态
  assert.strictEqual($('impose-btn').disabled, true);

  callsFor('/api/impose')[0].resolve(imposeResponse(makePlan(4))); // C 的旧拼版响应返回
  await tick();
  assert.strictEqual($('summary').hidden, true, '旧稿拼版摘要不得重新出现');
  assert.strictEqual($('preview').hidden, true, '旧稿拼版预览不得重新出现');
  assert.strictEqual($('reprint-box').hidden, true, '旧稿补印入口不得重新出现');
  assert.strictEqual($('impose-btn').disabled, true, '旧拼版的收尾不得误启按钮');
  assert.strictEqual(callsFor('/api/quote').length, 0, '旧拼版不得触发报价请求');
  assert.strictEqual(callsFor('/api/cutting').length, 0, '旧拼版不得触发裁切请求');

  const anchorsBefore = anchorCount();
  await fire($('download-btn'), 'click'); // 无有效结果时下载不生效
  assert.strictEqual(anchorCount(), anchorsBefore, '旧拼版不得留下可下载的结果');

  callsFor('/api/preflight')[2].resolve(jsonResponse(makeReport(2))); // D 的校验返回
  await tick();
  assert.strictEqual($('impose-btn').disabled, false);

  fire($('impose-btn'), 'click'); // D 的拼版
  callsFor('/api/impose')[1].resolve(imposeResponse(makePlan(8)));
  await tick();
  assert.strictEqual($('summary').hidden, false, '当前稿件的拼版摘要正常渲染');
  assert.strictEqual($('preview').hidden, false, '当前稿件的拼版预览正常渲染');
  assert.strictEqual($('reprint-box').hidden, false);
  assert.strictEqual(callsFor('/api/quote').length, 1, '当前拼版触发一次报价');
  assert.strictEqual(callsFor('/api/cutting').length, 1, '当前拼版触发一次裁切');

  await fire($('download-btn'), 'click'); // 下载名对应当前稿件 D
  assert.strictEqual(lastAnchor().download, 'D-拼版.pdf');

  // ---------- 场景 3：旧拼版触发的报价/裁切在切换文件后不得回填 ----------
  await pickFile(pdfFile('E.pdf')); // D 的报价/裁切仍在飞
  assert.strictEqual($('quote-box').hidden, true);
  assert.strictEqual($('cutting-box').hidden, true);

  callsFor('/api/quote')[0].resolve(jsonResponse(makeQuote('OLD'))); // D 的旧报价返回
  await tick();
  assert.strictEqual($('quote-box').hidden, true, '旧稿报价不得回填');
  assert.strictEqual($('quote-result').hidden, true);
  assert.strictEqual($('quote-status').textContent, '', '旧稿报价不得覆盖状态');

  callsFor('/api/cutting')[0].resolve(jsonResponse({ feasible: true })); // D 的旧裁切返回
  await tick();
  assert.strictEqual($('cutting-box').hidden, true, '旧稿裁切不得回填');
  assert.strictEqual($('cutting-result').hidden, true);
  assert.strictEqual($('cutting-status').textContent, '', '旧稿裁切不得覆盖状态');

  // ---------- 场景 4：选中非 PDF 时清除已选文件并禁用校验、拼版入口 ----------
  await pickFile(pdfFile('F.pdf'));
  assert.strictEqual($('preflight-btn').disabled, false);
  assert.strictEqual($('impose-btn').disabled, false);

  await pickFile({ name: 'notes.txt', type: 'text/plain', size: 100 });
  assert.strictEqual($('preflight-btn').disabled, true, '非 PDF 禁用校验入口');
  assert.strictEqual($('impose-btn').disabled, true, '非 PDF 禁用拼版入口');
  assert.strictEqual($('file-name').textContent, '', '非 PDF 清除已选文件名');
  assert.ok($('status').textContent.includes('请选择 PDF 文件'));

  const preflightCount = callsFor('/api/preflight').length;
  const imposeCount = callsFor('/api/impose').length;
  fire($('preflight-btn'), 'click'); // 入口已禁用，即使触发也不发请求
  fire($('impose-btn'), 'click');
  await tick();
  assert.strictEqual(callsFor('/api/preflight').length, preflightCount, '无选中文件时不发校验请求');
  assert.strictEqual(callsFor('/api/impose').length, imposeCount, '无选中文件时不发拼版请求');

  await pickFile(pdfFile('G.pdf')); // 重新选择 PDF 后恢复
  assert.strictEqual($('preflight-btn').disabled, false);
  assert.strictEqual($('impose-btn').disabled, false);

  // ---------- 场景 5：同一稿件的旧报价不得覆盖更新的报价 ----------
  fire($('impose-btn'), 'click'); // G 的拼版
  callsFor('/api/impose')[2].resolve(imposeResponse(makePlan(4)));
  await tick();
  assert.strictEqual(callsFor('/api/quote').length, 2); // D 一次 + G 自动一次

  fire($('quote-refresh-btn'), 'click'); // 逻辑层模拟再次报价（真实界面按钮此时禁用）
  assert.strictEqual(callsFor('/api/quote').length, 3);

  callsFor('/api/quote')[2].resolve(jsonResponse(makeQuote('NEW'))); // 新报价先返回
  await tick();
  assert.strictEqual($('quote-result').hidden, false);
  assert.ok($('quote-status').textContent.includes('NEW'));

  callsFor('/api/quote')[1].resolve(jsonResponse(makeQuote('OLD'))); // 旧报价后返回
  await tick();
  assert.ok($('quote-status').textContent.includes('NEW'), '旧报价不得覆盖新报价');
  assert.strictEqual($('quote-refresh-btn').disabled, false);

  // ---------- 场景 6：旧请求的失败提示也不得回填 ----------
  await pickFile(pdfFile('H.pdf'));
  fire($('preflight-btn'), 'click'); // H 的校验（挂起）
  await pickFile(pdfFile('I.pdf'));
  callsFor('/api/preflight')[3].resolve({
    ok: false,
    status: 422,
    headers: { get: () => null },
    json: async () => ({ error: '无法校验该 PDF：已加密' }),
    blob: async () => ({}),
  });
  await tick();
  assert.ok(!$('status').textContent.includes('已加密'), '旧请求的失败提示不得回填');
  assert.strictEqual($('report').hidden, true);

  // ---------- 场景 7：补印在飞时切换文件，旧补印不得回填 ----------
  fire($('impose-btn'), 'click'); // I 的拼版
  callsFor('/api/impose')[3].resolve(imposeResponse(makePlan(8)));
  await tick();
  assert.strictEqual($('reprint-box').hidden, false);

  $('reprint-pages').value = '2';
  fire($('reprint-btn'), 'click'); // I 的补印（挂起）
  assert.strictEqual(callsFor('/api/reprint').length, 1);
  assert.strictEqual($('reprint-btn').disabled, true);

  await pickFile(pdfFile('J.pdf')); // 补印未返回即切换文件
  assert.strictEqual($('reprint-box').hidden, true);
  assert.strictEqual($('reprint-btn').disabled, false, '切换文件后补印按钮由清理逻辑重置');

  callsFor('/api/reprint')[0].resolve(reprintResponse()); // I 的旧补印响应返回
  await tick();
  assert.strictEqual($('reprint-result').hidden, true, '旧稿补印结果不得回填');
  assert.strictEqual($('reprint-download-btn').disabled, true, '旧稿补印不得启用下载');

  console.log('app-race tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
