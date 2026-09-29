/**
 * Shared, side-effect-free project state model for CLI and Web consumers.
 * It describes observable readiness; it never signs a review ticket.
 */
export const PROJECT_STAGES = ['story', 'board', 'direction', 'assets', 'keyframes', 'clips', 'final'];

export function deriveProjectState({ board = null, direction = null, plan = null, tickets = null, assets = [], units = [], finalArtifact = null } = {}) {
  const approvals = tickets?.approvals || {};
  const signed = (stage) => Boolean(approvals[stage] && typeof approvals[stage] === 'object');
  const clipsApproved = units.length > 0 && units.every((unit) => Boolean(approvals.clips?.[unit.id]));
  const assetReady = assets.filter((x) => x.tab === 1).length > 0;
  const keyframesReady = units.length > 0 && units.every((x) => x.keyframe);
  const clipsReady = units.length > 0 && units.every((x) => x.clip);
  const stages = {
    story: { status: signed('story') ? 'approved' : board?.story ? 'ready' : 'missing' },
    board: { status: signed('board') ? 'approved' : board ? 'ready' : 'missing' },
    direction: { status: signed('direction') ? 'approved' : direction ? 'ready' : 'missing' },
    assets: { status: signed('assets') ? 'approved' : assetReady ? 'ready' : 'missing' },
    keyframes: { status: signed('keyframes') ? 'approved' : keyframesReady ? 'ready' : 'missing' },
    clips: { status: clipsApproved ? 'approved' : clipsReady ? 'ready' : 'missing' },
    final: { status: signed('final') ? 'approved' : finalArtifact ? 'ready' : 'missing' },
  };
  const currentStage = PROJECT_STAGES.find((stage) => stages[stage].status !== 'approved') || 'done';
  return { currentStage, stages, unitCount: units.length, hasPlan: Boolean(plan) };
}
