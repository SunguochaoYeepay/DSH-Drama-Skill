/** Extract identity and prop bindings from storyboard prompts. */
export function markersIn(text) {
  const out = [];
  const re = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
  let match;
  while ((match = re.exec(text)) !== null) out.push(match[1]);
  return out;
}

export function propMarkersIn(text) {
  const out = [];
  const re = /\[\[\s*([a-z][a-z0-9_]*)\s*\]\]/g;
  let match;
  while ((match = re.exec(text)) !== null) out.push(match[1]);
  return out;
}

export function ensureMarkers(board) {
  const injected = [];
  for (const shot of board.shots || []) {
    const existing = markersIn(shot.prompt);
    const missing = [];
    for (const id of shot.cast || []) {
      if (existing.includes(id)) continue;
      const identity = (board.identities || []).find((item) => item.id === id);
      if (!identity) continue;
      const character = (board.characters || []).find((item) => item.id === identity.character);
      const label = character ? `（${character.name}）` : '';
      missing.push(`{{${id}}}${label}`);
    }
    if (missing.length) {
      shot.prompt = `${missing.join('、')}，${shot.prompt}`;
      injected.push(`${shot.id}: 补入身份标记 → ${missing.join('、')}`);
    }
  }
  return injected;
}
