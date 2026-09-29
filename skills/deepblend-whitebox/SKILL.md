---
name: deepblend-whitebox
description: 用 DeepBlend Studio 的 SceneSpec 工作台执行白膜空间预演、资产导入、关键帧、预览复核和渲染交付；适用于需要精确控制人物与物体坐标、轨迹、朝向或复用 Blender 模型的镜头。
metadata:
  short-description: DSH 驱动白膜场景
---

# DeepBlend 白膜执行器

DeepBlend Studio 是白膜的 Blender 执行后端。导演层先产出项目的 `spatial-plan/1`；本 Skill 把它编译成 DeepBlend `SceneSpec v1`，再由 DSH 工具提交场景版本、预览和渲染。SceneSpec 版本是可追溯的执行状态，不能直接改 `.blend` 或绕过场景补丁。

## 工具顺序

在 DSH 会话中使用下列工具：

1. `blender_capabilities`：先确认 Blender、引擎、格式和 GPU 能力。
2. `blender_project_create`：为一个白膜镜头建立项目，记录导演目标和帧率。
3. `blender_asset_ingest`：把用户提供或已获准下载的模型复制进项目；远程 URL 需要先取得操作员批准。
4. `blender_scene_patch`：唯一的场景写入口。先用 `blender_scene_get` 读取当前 revision，再用该 `baseRevision` 提交补丁。
5. `blender_scene_validate`：提交前或补丁拒绝时做结构、资产格式和场景重量检查。
6. `blender_preview_render` 或 `blender_preview_views`：只用预览检查构图、遮挡、坐标和动作，不用最终渲染试错。
7. `blender_visual_review`：结合测量结果和预览图判断语义是否正确。
8. `blender_visual_autofix`：只让它修复有确定测量依据的问题，并接受能提升分数的版本。
9. `blender_final_render`、`blender_job_status`、`blender_job_cancel`、`blender_export`：预览确认后才进入交付渲染；长任务必须可恢复。

## spatial-plan 到 SceneSpec 的映射

- `entity` → SceneSpec `entities[]`。
- 世界 `[x,y]` → `transform.location: [x,y,z]`；白膜接触地面使用 `z=0`。
- 白膜 0° 的前方约定为 `+Y`，转成 Blender 的 `rotationEuler.z`。
- `from/to/waypoints` → `animation.track.set` 的逐帧 `keyframes`。位置轨迹和人物朝向写入不同 track，不能用移动方向覆盖朝向。
- `towards:<id>` → 每个关键帧根据目标当前位置计算朝向；目标移动时重新求解。
- `behind/in_front_of/left_of/right_of` → 在编译阶段先解析成绝对坐标；若目标没有位置、关系冲突或形成循环，停止并报错。
- `camera` → SceneSpec camera 的 `transform`, `targetEntityId` 或 `targetPoint`，镜头运动也用 track 表达。
- `total_frames/fps` → `project.frameRange.set`。

## 资产规则

优先使用项目资产库和 `vendor/whitebox-assets/props/manifest.json` 中的模型。对已有本地模型，使用 `blender_asset_ingest {sourcePath}`，再用 `blender_scene_patch {op: "asset.add"}` 声明它，最后用 `entity.add` 创建 `asset-instance`。资产必须带 `sha256`、尺寸、朝向约定和许可证来源；没有这些信息不得当作正式资产。

桌椅场景至少建立：

- 一张桌子资产。
- 三把椅子资产，每把有稳定座位锚点。
- 三个人物实体和对应的座位目标。
- `Sitting_Enter` → `Sitting_Idle_Loop` / `Sitting_Talking_Loop` 的动画轨道。

人物先到座位坐标，再进入坐下动作；桌椅位置不能靠提示词或镜头猜测。

## 版本和验收

- 每次 `blender_scene_patch` 只改一个明确意图，并写 note。
- 任何写入前都重新读取当前 revision，拒绝使用过期 `baseRevision`。
- 预览必须检查：实体世界坐标、屏幕坐标、朝向、桌椅遮挡、穿插和出框。
- 测量通过不等于语义通过；人物是否真的“坐在椅子上”、是否“在桌前”仍需人工观看预览。
- 最终渲染前必须保留一个已确认的预览 revision；长渲染中断时使用原 job 恢复，不启动第二个并行任务。

## 边界

本 Skill 负责把空间计划交给 DSH 执行，不替导演猜剧情站位，也不把文字提示词当作坐标控制。DSH 不可用时，回退到仓库内 `cli/whitebox.mjs` 和 `lab/whitebox/whitebox_render.py` 的确定性白膜渲染器。
