# 白膜空间控制验收包

## 已闭环

| 能力 | 验证结果 | 证据 |
|---|---|---|
| 空间计划解析 | 通过 | `src/spatial-plan.mjs`、`tests/spatial-plan.test.mjs` |
| 人物/道具坐标与朝向 | 通过 | `lab/whitebox/jet.spatial.json`、`coords.json` |
| RGB 身份色 | 通过 | `tests/whitebox-schema.test.mjs` |
| Blender 白膜渲染 | 通过 | `lab/whitebox/out/whitebox/jet_valley_static/` |
| 取景与位移闸门 | 通过 | `src/whitebox-framing.mjs`、F1/F2/F3/D1 |
| 时间段镜头约束 | 通过 | `camera.segments`、S1 分段可见性检查 |
| DeepBlend SceneSpec | 通过 | `src/deepblend-scene.mjs` |
| 白膜驱动 H3 | 通过运动语义验收 | `lab/h3-whitebox/out/e2-jet/` |
| 分段机位白膜与 H3 | 通过视觉验收 | `lab/h3-whitebox/out/e2-jet-segmented/` |

## 验收命令

```powershell
npm test
node lab/whitebox/make-jet-segmented.mjs
node cli/compile-spatial.mjs lab/whitebox/jet-segmented.spatial.json --out $env:TEMP/jet-segmented.whitebox.json
node cli/whitebox.mjs render $env:TEMP/jet-segmented.whitebox.json --out lab/whitebox/out/whitebox/jet_valley_segmented
```

## 当前边界

H3 能保持飞机/导弹的运动方向、发射顺序和大致构图，但不承诺小目标逐像素坐标复刻。彩色代理测量器会先用白膜自身校准，颜色检出不足时只报告为不确定，不把它伪装成坐标通过。

因此，验收标准分两层：

1. 白膜层：坐标、朝向、轨迹、取景必须机器通过。
2. 成片层：主体存在、运动方向、时序和镜头连续性通过；精确落点需要额外关键帧或分段生成约束。
