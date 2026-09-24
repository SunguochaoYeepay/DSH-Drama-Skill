import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startServer } from '../web/server.mjs';
import { lockedFilesIn, sendDirToTrash } from '../src/archive.mjs';

/**
 * 看板的媒体流**必须把文件句柄还回去**。
 *
 * 起因（2026-09-24 实测）：用户删不掉一个剧目。查下来是 —— 那个片段 mp4 被看板进程
 * （web/server.mjs）独占占着，Windows 于是拒绝移动/删目录。根因是媒体路由用了
 * `fs.createReadStream(file).pipe(res)`：客户端中途断开时 `pipe` **只 unpipe、不 destroy 源流**，
 * 句柄就一直开着，直到服务重启。
 *
 * 这里的判据是**跨进程独占打开**（`FileShare.None`），不是同进程的 rename/rm ——
 * libuv 的句柄带 `FILE_SHARE_DELETE`，同进程怎么试都看不出问题（我一开始就是这么被骗的）。
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-medialock-'));
const DIR = path.join(ROOT, 'alpha');
const UNITS = path.join(DIR, 'units');
fs.mkdirSync(UNITS, { recursive: true });
fs.writeFileSync(path.join(DIR, 'board.json'), JSON.stringify({
  meta: { title: '锁测试', aspect: '9:16', style: 'realistic' },
  shots: [], characters: [], identities: [], scenes: [], props: [],
}));
const CLIP = path.join(UNITS, 'clip.mp4');
fs.writeFileSync(CLIP, Buffer.alloc(24 * 1024 * 1024, 7));   // 够大：客户端能中途断开

test.after(async () => {
  // 被杀掉的持有者可能还没退干净；等锁消失再清理，别让 after 挂在 EPERM 上
  await waitFor(() => !exclusivelyLocked(CLIP), 3000);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
});

/** 跨进程独占打开：被占着 → 有锁。 */
function exclusivelyLocked(file) {
  const files = lockedFilesIn(path.dirname(file));
  return files.includes(file);
}

const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

test('客户端中途断开：看板必须释放那个片段（否则剧目删不掉）', async () => {
  const { server, port } = await startServer({ roots: [ROOT], port: 0, webDist: null });
  try {
    assert.equal(exclusivelyLocked(CLIP), false, '请求前不该被占');

    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/media/alpha/units/clip.mp4', headers: { Range: 'bytes=0-' } }, (res) => {
        assert.equal(res.statusCode, 206, 'Range 请求要回 206（否则下面断开的根本不是这条流）');
        res.once('data', () => { req.destroy(); setTimeout(resolve, 600); });
      });
      req.on('error', () => resolve());
    });

    const released = await waitFor(() => !exclusivelyLocked(CLIP));
    assert.ok(released, '客户端断开后文件仍被看板占着 —— pipe 不 destroy 源流就是这个后果');
  } finally {
    server.close();
  }
});

test('删除被占用时必须说清楚：谁的哪个文件占着', async () => {
  // 用一个真进程把文件独占住（Node 自己做不到 FileShare.None）
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$fs=[IO.File]::Open('${CLIP.replace(/'/g, "''")}','Open','ReadWrite','None'); Start-Sleep -Seconds 20; $fs.Close()`],
  { stdio: 'ignore', windowsHide: true });
  try {
    const locked = await waitFor(() => exclusivelyLocked(CLIP));
    assert.ok(locked, '没能造出"被别的进程占着"的局面，这个用例就没意义了');

    assert.deepEqual(lockedFilesIn(UNITS), [CLIP], 'lockedFilesIn 要能点出是哪个文件');

    const r = sendDirToTrash(UNITS);
    assert.equal(r.ok, false);
    assert.match(r.reason, /删除未生效/);
    assert.ok(r.reason.includes(CLIP), `报错里要有那个文件名，实际：${r.reason}`);
    assert.match(r.reason, /占着|占用/);
  } finally {
    holder.kill();
    await waitFor(() => !exclusivelyLocked(CLIP), 3000);
  }
});
