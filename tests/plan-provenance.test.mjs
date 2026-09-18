import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPlanEmotionContract, assertPlanProvenance, assertUnitEmotionContract, makePlanProvenance, sealPlan } from '../src/plan-provenance.mjs';
import { writeDirectionReceipt, directionReceiptPath } from '../src/direction-provenance.mjs';
import { DIRECTOR_MODEL } from '../src/config.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plan-'));
const board = path.join(dir, 'board.json');
const story = path.join(dir, 'story.md');
const direction = path.join(dir, 'board.direction.json');
const planPath = path.join(dir, 'render.plan.json');
fs.writeFileSync(board, JSON.stringify({ meta: { project: 'one' } }));
fs.writeFileSync(story, 'story one');
fs.writeFileSync(direction, JSON.stringify({ version: 6, units: [] }));
assert.throws(() => makePlanProvenance({ boardPath: board, storyPath: story, directionPath: direction }), /导演来源未登记/);
writeDirectionReceipt({ directionPath: direction, boardPath: board, storyPath: story, model: DIRECTOR_MODEL, responseModel: DIRECTOR_MODEL });
const plan = { units: [{ id: 'g001' }] };
plan.provenance = makePlanProvenance({ boardPath: board, storyPath: story, directionPath: direction });
sealPlan(plan);
assert.doesNotThrow(() => assertPlanProvenance(plan, { boardPath: board, storyPath: story, planPath }));
const originalReceipt = fs.readFileSync(directionReceiptPath(direction), 'utf8');

// Resource backfill is a later stage and must not invalidate a director receipt.
fs.writeFileSync(board, JSON.stringify({
  meta: { project: 'one' },
  characters: [{ id: 'c1', portrait: null }],
  identities: [{ id: 'i1', sheet: null }],
  scenes: [{ id: 's1', master: null }],
}));
writeDirectionReceipt({ directionPath: direction, boardPath: board, storyPath: story, model: DIRECTOR_MODEL, responseModel: DIRECTOR_MODEL });
const resourcePlan = { units: [{ id: 'g001' }] };
resourcePlan.provenance = makePlanProvenance({ boardPath: board, storyPath: story, directionPath: direction });
sealPlan(resourcePlan);
const withAssets = JSON.parse(fs.readFileSync(board, 'utf8'));
withAssets.characters[0].portrait = 'assets/c1.png';
withAssets.identities[0].sheet = 'assets/i1.png';
withAssets.scenes[0].master = 'assets/s1.png';
fs.writeFileSync(board, JSON.stringify(withAssets));
assert.doesNotThrow(() => assertPlanProvenance(resourcePlan, { boardPath: board, storyPath: story, planPath }));
withAssets.meta.style = 'different';
fs.writeFileSync(board, JSON.stringify(withAssets));
assert.throws(() => assertPlanProvenance(resourcePlan, { boardPath: board, storyPath: story, planPath }), /语义内容已变化/);
fs.writeFileSync(board, JSON.stringify({ meta: { project: 'one' } }));
fs.writeFileSync(directionReceiptPath(direction), originalReceipt);
fs.writeFileSync(directionReceiptPath(direction), originalReceipt.replace('"contract": 1', '"contract": 2'));
assert.throws(() => assertPlanProvenance(plan, { boardPath: board, storyPath: story, planPath }), /来源模型/);
fs.writeFileSync(directionReceiptPath(direction), originalReceipt);
const changed = structuredClone(plan); changed.units[0].id = 'g999';
assert.throws(() => assertPlanProvenance(changed, { boardPath: board, storyPath: story, planPath }), /内容已被修改/);
fs.writeFileSync(story, 'different story');
assert.throws(() => assertPlanProvenance(plan, { boardPath: board, storyPath: story, planPath }), /剧本已变化/);
fs.writeFileSync(story, 'story one');
fs.writeFileSync(board, JSON.stringify({ meta: { project: 'another' } }));
assert.throws(() => assertPlanProvenance(plan, { boardPath: board, storyPath: story, planPath }), /当前项目/);

const legacy = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-v4-render-plan.json', import.meta.url), 'utf8'));
const g003 = legacy.units.find((unit) => unit.id === 'g003');
const g005 = legacy.units.find((unit) => unit.id === 'g005');
assert.throws(() => assertUnitEmotionContract(g003, { plan: legacy }), /未列入 provenance\.reviewed_units/);
assert.doesNotThrow(() => assertUnitEmotionContract(g005, { plan: legacy }));
assert.throws(() => assertPlanEmotionContract(legacy), /g003 未列入/);
const incomplete = structuredClone(legacy);
incomplete.units[1].shots[0].emotion_analysis = [];
assert.throws(() => assertUnitEmotionContract(incomplete.units[1], { plan: incomplete }), /缺少 orange_cat_home/);
console.log('plan provenance: 10/10 passed');
