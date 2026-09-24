/**
 * 试验箱：从 scene.json 的声明拼出「直写提示词」与「参考图清单」。
 *
 * 两臂的唯一差别：
 *   prompt-only    —— 只有文字 + 身份图 + 场景主图（= 我们管线现在的做法）
 *   prompt+control —— 多传一张「空间示意图」当参考图，并加一句"按示意图安排位置"
 *
 * 这一层本身就是正式方案里「从契约生成标准句」的原型。
 */

const DEPTH_WORD = { near: '最前（离镜头最近）', mid: '中间', far: '最远' };
const DEPTH_RANK = { near: 3, mid: 2, far: 1 };

/** 画面位置的说法：u 是画面横向归一化坐标（0=最左，1=最右） */
function positionWords(u) {
  if (u < 0.2) return '画面最左侧';
  if (u < 0.34) return '画面左侧';
  if (u < 0.45) return '画面中间偏左';
  if (u <= 0.55) return '画面正中央';
  if (u <= 0.66) return '画面中间偏右';
  if (u <= 0.8) return '画面右侧';
  return '画面最右侧';
}

function subjectLine(scene, shot, subj) {
  const ident = scene.identities.find((x) => x.id === subj.id);
  const name = ident ? ident.name : subj.id;
  const look = ident && ident.sheet ? '' : `（${(ident && ident.appearance) || '外观由文字描述决定'}）`;
  const u = subj.u.toFixed(2);
  const depth = DEPTH_WORD[subj.depth] || subj.depth;
  return `${name}${look}${subj.note}；在画面的横向位置约 x=${u}（${positionWords(subj.u)}），前后层次是${depth}`;
}

/** 前后关系句：按 depth 从近到远排出来，写成明确的一句话 */
function occlusionLine(scene, shot) {
  const order = [...shot.subjects].sort((a, b) => DEPTH_RANK[b.depth] - DEPTH_RANK[a.depth]);
  const names = order.map((s) => {
    const ident = scene.identities.find((x) => x.id === s.id);
    return ident ? ident.name : s.id;
  });
  return `前后遮挡关系必须是：${names.join(' 挡住 ')}`;
}

export function shotTargets(scene, shot) {
  return {
    shot: shot.id,
    subjects: shot.subjects.map((s) => ({
      id: s.id,
      u: s.u,
      v: s.v,
      depth: s.depth,
      facing: s.facing || '',
    })),
  };
}

export function refsFor(scene, shot, { arm, blockoutPath, markPath, sceneRefPath } = {}) {
  const refs = [];
  for (const s of shot.subjects) {
    const ident = scene.identities.find((x) => x.id === s.id);
    if (ident && ident.sheet) refs.push(ident.sheet);
  }
  // 场景参考图可以被镜头覆盖：换机位时该给模型看那个方向的空场景照（@pano:<yaw>）
  const master = sceneRefPath || scene.scene.master;
  if (master) refs.push(master);
  if (arm === 'prompt+control' && blockoutPath) refs.push(blockoutPath);
  if (arm === 'prompt+mark' && markPath) refs.push(markPath);
  return refs;
}

export function buildPrompt(scene, shot, { arm } = {}) {
  const parts = [];

  parts.push(`场景：${scene.scene.environment}`);
  parts.push(`镜头：${shot.camera_text}，${shot.shot_size}`);

  // 主体与位置：一句一人，避免模型把三个人的位置混在一起
  for (const s of shot.subjects) parts.push(`人物：${subjectLine(scene, shot, s)}`);
  if (shot.subjects.length >= 2) parts.push(occlusionLine(scene, shot));

  if (shot.prompt_extra) parts.push(shot.prompt_extra);

  // 位置是这几镜的唯一考核项 —— 放在最后，且用最直白的说法
  if (shot.landmark && shot.subjects.length === 1) {
    const first = shot.subjects[0];
    parts.push(`位置要求（这一条最重要，必须做到）：${shot.landmark}`);
    parts.push(
      `她在画面里的横向位置必须落在 x=${Number(first.u).toFixed(2)} 附近（${positionWords(first.u)}），` +
        `不许换到屋子里别的地方去，也不许改成别的姿势或别的家具旁边`
    );
  } else if (shot.subjects.length > 1) {
    // 多人：逐人给数，且不许互换；不能只强调第一个人
    const list = shot.subjects
      .map((s) => {
        const ident = scene.identities.find((x) => x.id === s.id);
        const nm = ident ? ident.name : s.id;
        return `${nm} 在 x=${Number(s.u).toFixed(2)}（${positionWords(s.u)}）、${
          DEPTH_WORD[s.depth] || s.depth
        }`;
      })
      .join('；');
    parts.push(`位置要求（这一条最重要，必须做到）：${shot.landmark}`);
    parts.push(`每个人的画面横向位置必须同时满足：${list}`);
    parts.push(
      `不许把任何两个人的左右位置互换，不许把谁挪到别的地标去；` +
        `镜头里的人数必须正好是 ${shot.subjects.length} 个人，一个不多一个不少`
    );
  }

  if (arm === 'prompt+presence') {
    // 与 pilot-02 的发现对应：模型在"远景/坐姿/被遮挡"的位置会**干脆不画人**。
    // 原句「画面里只有她一个人」强调的是"只有"，不是"必须有"。这里改成正面强制。
    parts.push(
      '画面里必须有这个人：她的身体清晰可辨（至少上半身完整），' +
        '站在或坐在明确的位置上，衣着发型与角色参考图一致'
    );
    parts.push(
      '绝对不允许出现没有人的空场景，也不允许用模糊色块、影子、背影替代她本人；' +
        '「这个人必须出现在画面里」是本镜最高优先级的硬性要求，优先于构图与其他细节'
    );
  }

  if (arm === 'prompt+control') {
    parts.push(
      '另外附了一张空间示意图：它只规定每个人的画面位置、大小与前后遮挡，' +
        '不规定长相、材质与灯光；请按示意图安排构图，人物外观一律取自其他参考图'
    );
  }

  if (arm === 'prompt+mark') {
    parts.push(
      '另外附了一张同一间屋子的实景照片，照片上用浅灰色人形标出了她应该出现的位置与大小；' +
        '那个灰色人形只是位置标记，她的长相、衣着、发型一律取自角色参考图，绝不要把她画成一个灰色的人'
    );
  }

  parts.push([scene.scene.lighting, '写实电影感，浅景深'].filter(Boolean).join('，'));
  parts.push('画面中不出现任何字幕、水印、logo 或可读文字');
  return parts.join('。') + '。';
}

export function loadScene(text) {
  const scene = JSON.parse(text);
  if (!scene.shots || !scene.shots.length) throw new Error('scene.json 里没有 shots');
  return scene;
}
