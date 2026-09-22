/**
 * DSH 外挂插件的活体验证（不需要浏览器）。
 *
 * 对每个包依次：
 *   1. 默认验证仓库源码；VERIFY_INSTALLED=1 时验证已安装到 DSH profile 的包；
 *   2. import 宿主半，证明它能被 Node 加载且导出 apply/name；
 *   3. 在假 window.__ModuleLoader__ + 假 react（带 hooks）+ 假 ctx 里执行 lib/client.js，
 *      把它注册了哪些槽位抓出来，并**真跑一遍组件**看产出什么元素。
 *
 * 用法：node tests/integration/dsh-plugins.test.mjs [包名 ...]
 *
 * ## 两种模式，默认验仓库源码
 *
 * | 模式 | 验的是 | 什么时候用 |
 * |---|---|---|
 * | 默认 | 仓库 `plugins/` 里的源码 | 回归、改插件之后的验收 |
 * | `VERIFY_INSTALLED=1` | 本机 DSH profile 里**已安装**的副本 | 确认装上去的那份跟源码一致 |
 *
 * **已装模式红了不一定是测试坏了。** 期望值写的是"当前契约"，
 * 所以如果 profile 里的副本比源码旧，它就会红 —— 那是**提示你去重新安装插件**的信号，
 * 别靠放宽断言把它压绿。（实测：profile 里那份还是 9/15 的，仓库源码是 9/17 的，
 * 于是"请求路径 / 目录扫描 / 默认选中"三条红，其余 59 条绿。）
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// DSH profile 的位置每台机器不同 —— 环境变量优先，其次按当前用户推，不写死某个用户名。
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
  || path.join(os.homedir(), '.dsh', 'profiles', 'web');
/** 默认验证仓库源码；置 1 才检查当前机器已安装的 DSH 插件。 */
const FROM_WORKSPACE = process.env.VERIFY_INSTALLED !== '1';
const WORKSPACE_PLUGIN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'plugins',
);

/** 每个包各自的期望值。 */
const EXPECT = {
  'dsh-storyboard': {
    // 面板要列剧目目录（剧目根由用户选定，可能是仓库里的 projects/），
    // 而 workspaceFiles.list 只在工作区根内可用 —— 列剧目目录走 directoryPicker。
    clientServices: ['slots', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'remote.directoryPicker'],
    tabTypes: 1,
    slotKeys: ['sidebar.right.pane.tab', 'conversation.session.header.actions'],
    documentDefinitions: 0,
    /** 给一个假分镜契约，验证面板真能读出来并渲染成表。 */
    panelProbe: {
      expectPath: 'board.json',
      board: {
        meta: {
          title: '探针片', logline: '一句话故事', language: 'zh-CN', aspect: '16:9',
          style: 'realistic', total_duration_s: 12, stage: 'shots',
          approvals: { story: { at: '2026-01-01T00:00:00Z', by: 'user' }, shots: null, keyframes: null },
        },
        story: { synopsis: '略', beats: ['一', '二'] },
        characters: [{ id: 'boy', name: '小宇', appearance: '东亚男孩，圆脸', wardrobe: '红短袖', portrait: 'assets/probe_char.png' }],
        scenes: [{ id: 'field', name: '球场', environment: '黄昏草地', master: 'assets/probe_scene.png' }],
        props: [{ id: 'ball', name: '旧足球', description: '白色带黑五边形的旧足球', ref_image: 'assets/probe_ball.png' }],
        shots: [
          { id: 's01', scene: 'field', characters: ['boy'], duration_s: 5, shot_size: '全景', lighting: '逆光', camera: '前推', action: '摆球', prompt: '东亚男孩圆脸，站在黄昏球场', audio: '虫鸣', dialogue: [], edit_note: '开场', transition: { type: 'cut' }, first_frame: null, last_frame: null, clip: null },
          { id: 's02', scene: 'field', characters: ['boy'], duration_s: 4, shot_size: '中景', lighting: '逆光', camera: '固定', action: '助跑', prompt: '东亚男孩圆脸，助跑', audio: '脚步', dialogue: [], edit_note: '加速', transition: { type: 'cut' }, first_frame: null, last_frame: null, clip: null },
          { id: 's03', scene: 'field', characters: ['boy'], duration_s: 3, shot_size: '特写', lighting: '逆光', camera: '跟随', action: '射门', prompt: '东亚男孩圆脸，射门', audio: '闷响', dialogue: [], edit_note: '高潮', transition: { type: 'cut' }, first_frame: null, last_frame: null, clip: null },
        ],
      },
    },
  },
  'dsh-media-preview': {
    clientServices: ['slots', 'documentPreviews'],
    tabTypes: 0,
    slotKeys: ['sidebar.right.tab.document'],
    documentDefinitions: 1,
    /** 定义里必须覆盖我们实际产出的格式。 */
    mustCoverExtensions: ['mp4', 'mp3'],
    /** 拿一个假 mp4 跑一遍组件，必须产出 <video src="blob:...">。 */
    probe: {
      // 只要长得像"仓库外某个绝对路径"即可 —— 测的是 host 怎么解析这个 URI，
      // 不是那台机器的盘符本身，所以别把真实用户名/盘符钉在这儿。
      address: 'dsh-resource://file/absolute/Z:/elsewhere/projects/example/units/g001.mp4',
      expectTag: 'video',
      expectMime: 'video/mp4',
    },
  },
};

// ── 假 React：带 hooks，够跑一轮 useEffect + 一次重渲染 ────────────────────

function createFakeReact() {
  const states = [];
  let cursor = 0;
  let effects = [];

  const React = {
    createElement(type, props, ...children) {
      return { __el: true, type, props: props || {}, children };
    },
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
    },
    useEffect(fn) { effects.push(fn); },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v === undefined ? null : v }),
  };

  /** 渲染一遍；runEffects 为 true 时执行本轮收集到的 effect（模拟 React 提交阶段）。 */
  function render(Component, props, runEffects) {
    cursor = 0;
    effects = [];
    const out = Component(props);
    const cleanups = [];
    if (runEffects) {
      for (const fn of effects) {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
    }
    return { out, cleanups };
  }

  return { React, render };
}

/** 深度遍历元素树，找出所有指定标签。children 可能是嵌套数组，必须递归进去。 */
function findTags(node, tag, found = []) {
  if (node === null || node === undefined || node === false) return found;
  if (Array.isArray(node)) {
    for (const child of node) findTags(child, tag, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (node.__el && node.type === tag) found.push(node);
  if (node.__el) for (const child of node.children || []) findTags(child, tag, found);
  return found;
}

/** 把树里所有字符串节点收集起来，用来断言"内容真的来自数据"。 */
function collectText(node, found = []) {
  if (node === null || node === undefined || node === false) return found;
  if (typeof node === 'string' || typeof node === 'number') { found.push(String(node)); return found; }
  if (Array.isArray(node)) { for (const child of node) collectText(child, found); return found; }
  if (node.__el) { for (const child of node.children || []) collectText(child, found); }
  return found;
}

// ── 捕获 blob URL ──────────────────────────────────────────────────────────

const objectUrls = [];
globalThis.URL.createObjectURL = (blob) => {
  const url = `blob:verify/${objectUrls.length}`;
  objectUrls.push({ url, type: blob && blob.type, size: blob && blob.size });
  return url;
};
globalThis.URL.revokeObjectURL = () => {};

// ── 主流程 ────────────────────────────────────────────────────────────────

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (FROM_WORKSPACE ? ['dsh-storyboard'] : Object.keys(EXPECT));
const requireFromProfile = createRequire(
  path.join(FROM_WORKSPACE ? WORKSPACE_PLUGIN_DIR : PROFILE_DIR, 'package.json'),
);

const problems = [];
let passed = 0;
function check(label, condition, detail = '') {
  if (condition) passed++;
  else problems.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ${condition ? ' ok  ' : 'FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
}

for (const name of targets) {
  const expect = EXPECT[name] || {};
  console.log(`\n${'═'.repeat(56)}\n${name}\n${'═'.repeat(56)}`);

  // 1. 解析
  console.log('\n[1] 解析');
  let entryPath;
  let manifestPath;
  if (FROM_WORKSPACE) {
    const dir = path.join(WORKSPACE_PLUGIN_DIR, name);
    entryPath = path.join(dir, 'lib', 'index.js');
    manifestPath = path.join(dir, 'package.json');
    check(`工作区源码存在 ${name}`, fs.existsSync(manifestPath), dir);
    if (!fs.existsSync(manifestPath)) continue;
  } else {
    try {
      entryPath = requireFromProfile.resolve(name);
      check(`从 profile 目录能解析到 ${name}`, true, entryPath);
    } catch (error) {
      check(`从 profile 目录能解析到 ${name}`, false, String(error.message));
      continue;
    }
    manifestPath = requireFromProfile.resolve(`${name}/package.json`);
  }
  const pkgDir = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // 2. 宿主半
  console.log('\n[2] 宿主半');
  const host = await import(pathToFileURL(entryPath).href);
  check('导出 apply()', typeof host.apply === 'function');
  check('导出 name', typeof host.name === 'string', host.name);
  try {
    host.apply({ logger: { info() {} } });
    check('apply() 不抛错', true);
  } catch (error) {
    check('apply() 不抛错', false, String(error.message));
  }

  // 3. 客户端半
  console.log('\n[3] 客户端半');
  const declared = manifest.dsh?.client;
  check('声明了 dsh.client', Boolean(declared));
  check('platform = web', declared?.platform === 'web', String(declared?.platform));
  const exportEntry = manifest.exports?.['./client'];
  const clientRel = typeof exportEntry === 'string' ? exportEntry : exportEntry?.default;
  const clientPath = path.join(pkgDir, clientRel ?? '');
  check('exports["./client"] 文件存在', fs.existsSync(clientPath), clientRel ?? '(缺失)');

  const fake = createFakeReact();
  const registered = { tabTypes: [], documents: [], slots: [] };
  const remoteCalls = [];
  const listCalls = [];
  const fakeCtx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    sidebarRightTabs: { register(definition) { registered.tabTypes.push(definition); return () => {}; } },
    documentPreviews: { register(definition) { registered.documents.push(definition); return () => {}; } },
    slots: {
      inject(key, callback) { callback(); return () => {}; },
      register(registration, Component) { registered.slots.push({ registration, Component }); return () => {}; },
    },
    remote: {
      workspaceFiles: {
        readAll(sessionId, filePath, signal) {
          remoteCalls.push({ sessionId, path: filePath });
          const probe = expect.panelProbe;
          if (!probe) return Promise.resolve({ ok: false, error: { code: 'workspace-file/not-found', message: '探针未配置' } });
          const text = JSON.stringify(probe.board);
          return Promise.resolve({ ok: true, value: { data: Buffer.from(text, 'utf8').toString('base64'), eof: true } });
        },
        list(sessionId, dirPath, signal) {
          listCalls.push({ sessionId, path: dirPath });
          if (!expect.panelProbe) return Promise.resolve({ ok: false, error: { code: 'workspace/not-found', message: '探针未配置' } });
          return Promise.resolve({ ok: true, value: { entries: [
            { name: 'board.json', type: 'file' },
            { name: 'other.json', type: 'file' },
            { name: 'notes.txt', type: 'file' },
            { name: 'nested', type: 'directory' },
          ] } });
        },
      },
    },
  };

  const loaded = { id: null, exports: null, error: null };
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded.id = id;
        try {
          loaded.exports = factory((specifier) => {
            if (specifier === 'react') return fake.React;
            throw new Error(`请求了未预期的模块：${specifier}`);
          });
        } catch (error) { loaded.error = error; }
      },
    },
  };

  try {
    await import(pathToFileURL(clientPath).href);
    check('lib/client.js 能执行', true);
  } catch (error) {
    check('lib/client.js 能执行', false, String(error.message));
  }

  check('调用了 __ModuleLoader__.load', loaded.id === name, `id=${loaded.id}`);
  check('factory 未抛错', loaded.error === null, loaded.error ? String(loaded.error.message) : '');
  check('导出 apply()', typeof loaded.exports?.apply === 'function');
  check('inject 服务清单正确', JSON.stringify(loaded.exports?.inject) === JSON.stringify(expect.clientServices),
    JSON.stringify(loaded.exports?.inject));

  if (typeof loaded.exports?.apply === 'function') {
    try {
      loaded.exports.apply(fakeCtx);
      check('客户端 apply() 不抛错', true);
    } catch (error) {
      check('客户端 apply() 不抛错', false, String(error.message));
    }
  }

  // 4. 注册内容
  console.log('\n[4] 注册了什么');
  check(`注册了 ${expect.tabTypes ?? 0} 个 tab 类型`, registered.tabTypes.length === (expect.tabTypes ?? 0),
    `实际 ${registered.tabTypes.length}`);
  check(`注册了 ${expect.documentDefinitions ?? 0} 个文档渲染器`,
    registered.documents.length === (expect.documentDefinitions ?? 0), `实际 ${registered.documents.length}`);

  const slotKeys = registered.slots.map((s) => s.registration.name);
  for (const key of expect.slotKeys || []) {
    check(`注册了槽位 ${key}`, slotKeys.includes(key), slotKeys.join(', '));
  }

  const doc = registered.documents[0];
  if (doc) {
    check('文档渲染器 loading = bytes-complete', doc.loading === 'bytes-complete', String(doc.loading));
    const covered = expect.mustCoverExtensions || [];
    for (const ext of covered) {
      check(`渲染器覆盖 .${ext}`, doc.extensions.includes(ext));
    }
  }

  // 5. 真跑组件
  console.log('\n[5] 真渲染组件');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  for (const { registration, Component } of registered.slots) {
    // (a) 分镜面板：假 Remote + 异步 effect，验证"内容真的来自文件"
    if (expect.panelProbe) {
      if (registration.name !== 'sidebar.right.pane.tab') continue;
      const probe = expect.panelProbe;
      const props = { sessionId: 'session-probe', wrap: false, scrollportRef: () => {} };
      let tree;
      try {
        fake.render(Component, props, true);   // 第一轮：开始读分镜文件
        for (let i = 0; i < 5; i++) await tick();
        fake.render(Component, props, true);   // 第二轮：board 到手后，资产 effect 才会跑
        for (let i = 0; i < 8; i++) await tick();
        tree = fake.render(Component, props, false).out;
        check('面板组件不抛错', true);
      } catch (error) {
        check('面板组件不抛错', false, String(error.message));
        continue;
      }

      check('调用了 workspaceFiles.readAll', remoteCalls.length > 0, remoteCalls.map((c) => c.path).join(', '));
      check('请求路径正确', remoteCalls.some((call) => call.path === probe.expectPath), remoteCalls.map((call) => call.path).join(', '));
      check('请求带了 sessionId', remoteCalls[0] && remoteCalls[0].sessionId === 'session-probe', String(remoteCalls[0] && remoteCalls[0].sessionId));

      const tables = findTags(tree, 'table');
      check('渲染出了 <table>', tables.length === 1);
      const rows = findTags(tree, 'tr');
      check(`表格 ${probe.board.shots.length} 行镜头 + 1 行表头`, rows.length === probe.board.shots.length + 1, `实际 ${rows.length}`);
      const headers = rows.length ? findTags(rows[0], 'th') : [];
      // 6 列 = 镜号 / 时长 / 画面描述 / 单元 / 关键帧 / 视频片段。
      // 已移除：「景别 光影氛围 对白/旁白 音效 运镜 最终剪辑提示」（挤在 12 列里读不动，改到细节区）
      // 和「状态」（右边的缩略图就是状态，有图即已生成）。
      check('表头 6 列', headers.length === 6, `实际 ${headers.length}`);
      const headText = headers.map((h) => collectText(h).join('')).join('|');
      check('表头含「单元」「关键帧」「视频片段」且无「状态」',
        /单元/.test(headText) && /关键帧/.test(headText) && /视频片段/.test(headText) && !/状态/.test(headText), headText);

      const texts = collectText(tree);
      check('标题来自文件内容', texts.some((t) => t.indexOf(probe.board.meta.title) >= 0), probe.board.meta.title);
      check('第一镜 id 出现在表里', texts.indexOf('s01') >= 0);
      check('第一镜时长出现在表里', texts.indexOf('5s') >= 0);
      // 闸门显示**只认现行票模型**：`board.meta.approvals` 那一行（①故事…⑤出片）已按要求去掉，
      // 因为它与 `review.approvals.json` 的票据行重复，而且那是旧票模型。
      // 这里钉住两件事：旧行不再出现，现行票据的四个阶段名在。
      check('板子旧闸门行已移除', !texts.some((t) => t.indexOf('① 故事') === 0), '不应出现 ① 故事');
      check('现行票据阶段名在', ['导演方案', '资源', '关键帧', '最终成片'].every((n) => texts.some((t) => t.indexOf(n) === 0)),
        texts.filter((t) => ['导演方案', '资源', '关键帧', '最终成片'].some((n) => t.indexOf(n) === 0)).join(','));

      // 目录扫描 + 文件选择器
      check('调用了 workspaceFiles.list', listCalls.length > 0, listCalls.map((c) => c.path).join(', '));
      const selects = findTags(tree, 'select');
      // 两个下拉：**第一个是文件选择器**（工作区内的板子，走 workspaceFiles），
      // 第二个是剧目下拉（用户选定剧目根下的剧目，走 directoryPicker + 绝对路径）。
      // 这里钉住的是**文件选择器**的契约没被新功能改坏。
      check('渲染出两个下拉（文件选择器 + 剧目下拉）', selects.length === 2, `实际 ${selects.length}`);
      const options = selects.length ? findTags(selects[0], 'option') : [];
      check('文件选择器的选项来自项目根目录扫描（2 个 JSON）', options.length === 2, `实际 ${options.length}`);
      check('默认选中的是探针路径', selects.length > 0 && selects[0].props.value === probe.expectPath, selects.length ? String(selects[0].props.value) : '');
      const projectOptions = selects.length > 1 ? findTags(selects[1], 'option') : [];
      check('剧目下拉有"未选择"占位项', projectOptions.length >= 1, `实际 ${projectOptions.length}`);

      // 换一个文件后必须重新读，而且读的是新路径
      const other = 'other.json';
      const before = remoteCalls.length;
      selects[0].props.onChange({ target: { value: other } });
      fake.render(Component, props, true);
      for (let i = 0; i < 5; i++) await tick();
      const after = remoteCalls.slice(before);
      check('切换文件后重新读取', after.length > 0, `新增 ${after.length} 次读取`);
      check('读的是新选的路径', after.some((c) => c.path === other),
        after.map((c) => c.path).join(', '));

      // 资产带：角色 / 场景 / 道具三张缩略图，点开看大图
      const thumbs = findTags(tree, 'img');
      check('资产带渲染了 3 张缩略图', thumbs.length === 3, `实际 ${thumbs.length}`);
      const cards = findTags(tree, 'button').filter((b) => findTags(b, 'img').length > 0);
      check('资产卡片是可点按钮', cards.length === 3, `实际 ${cards.length}`);
      if (cards.length) {
        cards[0].props.onClick();
        const tree2 = fake.render(Component, props, false).out;
        const imgs2 = findTags(tree2, 'img');
        check('点资产后多出一张大图', imgs2.length === 4, `实际 ${imgs2.length}`);
        // 必须拿重渲染后的新元素再点：旧 onClick 闭包着旧的 focus，真 React 里会被替换掉
        const cards2 = findTags(tree2, 'button').filter((b) => findTags(b, 'img').length > 0);
        cards2[0].props.onClick();
        const tree3 = fake.render(Component, props, false).out;
        check('再点一下收起大图', findTags(tree3, 'img').length === 3, `实际 ${findTags(tree3, 'img').length}`);
      }
      continue;
    }

    // (b) 媒体渲染器：hooks + 二进制内容
    if (expect.probe) {
      const probe = expect.probe;
      const props = {
        content: { kind: 'bytes', data: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]) },
        resourceAddress: probe.address,
        wrap: false,
        scrollportRef: () => {},
      };
      let tree;
      try {
        fake.render(Component, props, true);
        tree = fake.render(Component, props, false).out;
        check(`${registration.name} 组件不抛错`, true);
      } catch (error) {
        check(`${registration.name} 组件不抛错`, false, String(error.message));
        continue;
      }
      const found = findTags(tree, probe.expectTag);
      check(`产出了 <${probe.expectTag}>`, found.length > 0);
      if (found.length) {
        check('播放器带 controls', found[0].props.controls === true);
        check('src 是 blob: URL', String(found[0].props.src || '').startsWith('blob:'), String(found[0].props.src));
      }
      const blob = objectUrls[objectUrls.length - 1];
      check(`Blob MIME = ${probe.expectMime}`, blob && blob.type === probe.expectMime, blob ? String(blob.type) : '(无)');
      continue;
    }

    // (c) 无 hooks 的纯组件
    try {
      Component({});
      check(`${registration.name} 组件不抛错`, true);
    } catch (error) {
      check(`${registration.name} 组件不抛错`, false, String(error.message));
    }
  }
}

console.log('\n' + '─'.repeat(56));
if (problems.length === 0) console.log(`全部通过（${passed} 项）`);
else {
  console.log(`通过 ${passed} 项，失败 ${problems.length} 项：`);
  for (const p of problems) console.log('  ✗ ' + p);
  process.exitCode = 1;
}
