#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readReviews, requireAllClips, writeReviewNote } from '../src/human-gates.mjs';
import { assertPlanProvenance } from '../src/plan-provenance.mjs';
import { installCliErrorHandler } from '../src/cli-errors.mjs';

installCliErrorHandler();

const argv = process.argv.slice(2);
const planArg = argv.find((x) => /\.json$/i.test(x) && !x.startsWith('--'));
const value = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
if (!planArg) {
  console.error('用法：node cli/assemble-units.mjs <render.plan.json> [--out final.mp4]');
  process.exit(2);
}
const planPath = path.resolve(planArg);
const projectDir = path.dirname(planPath);
const boardPath = path.resolve(value('board', path.join(projectDir, 'board.json')));
const storyPath = path.resolve(value('story', path.join(projectDir, 'story.md')));
const output = path.resolve(value('out', path.join(projectDir, 'out', 'final.mp4')));
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
assertPlanProvenance(plan, { boardPath, storyPath, planPath });
// 情绪与表演契约在单段视频生成前校验。进入合成阶段后，真正的输入是
// 已经逐段人工确认且由哈希票据绑定的视频；纯剪辑不应反过来要求旧导演稿
// 补写不会改变现有视频的字段。
requireAllClips(projectDir, plan);

const reviews = readReviews(projectDir);
const tmp = path.join(projectDir, '.tmp', 'assemble');
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(path.dirname(output), { recursive: true });
const normalized = [];

function run(args, label) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${label} 失败：${String(result.stderr || '').slice(-1200)}`);
}

for (const [index, unit] of plan.units.entries()) {
  const ticket = reviews.approvals.clips[unit.id];
  const input = ticket?.artifacts?.[0];
  if (!input || !fs.existsSync(input)) throw new Error(`${unit.id}: 人工确认票没有可用视频`);
  const out = path.join(tmp, `${String(index + 1).padStart(3, '0')}_${unit.id}.mp4`);
  // H3 的真实口播速度不可由导演估算精确预测。含台词单元保留完整生成片，
  // 否则按 content_duration_s 裁切会把一句话的尾字物理截断。
  const hasDialogue = (unit.shots || []).some((shot) => (shot.lines || []).length > 0);
  const trimArgs = hasDialogue ? [] : ['-t', Number(unit.content_duration_s).toFixed(3)];
  run(['-y', '-v', 'error', '-i', input, ...trimArgs,
    '-vf', 'scale=480:864:flags=lanczos,fps=24,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', out], unit.id);
  console.log(`  ${unit.id}: ${hasDialogue ? '含台词，保留完整生成时长' : `无台词，裁到 ${unit.content_duration_s.toFixed(2)}s`}`);
  normalized.push(out);
}

const listFile = path.join(tmp, 'concat.txt');
fs.writeFileSync(listFile, normalized.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n') + '\n', 'utf8');
run(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', output], '合成');

const note = writeReviewNote(projectDir, 'final', [
  '# 最终成片人工审阅', '', `成片：${output}`, '',
  '机器检查通过只表示可以送审。请完整观看台词、节奏、接缝、人物一致性和声音。', '',
  `确认命令：node cli/review-gate.mjs approve --project "${projectDir}" --stage final --artifacts "${output}"`,
]);
console.log(`✓ 合成完成：${output}`);
console.log(`等待最终人工审阅：${note}`);
