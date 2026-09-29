# director-stage/1 导演台场景契约

`director-stage/1` 是导演和 AI 编辑的场景层，不替代 `spatial-plan/1` 或 `whitebox/1`。
它把角色、道具、机位和镜头快照放在一份稳定的场景状态里，再由
`src/director-stage.mjs` 确定性编译到现有白膜流水线。

## 坐标约定

- `x/z` 是地面平面，`y` 向上，单位为米。
- 角色 `position` 是脚底位置。
- `facing` 是角度，沿用现有白膜动作约定。
- 编译时转换为白膜的 `[x, y]` 地面坐标和 `z` 高度，不在渲染器里猜方向。

## 对象

对象类型只有三种：`character`、`prop`、`camera`。

角色必须有稳定的 `id`、`name`、`build`、`color`、`position`、`facing`。
`motions` 描述从哪一点到哪一点、使用哪个动作和运动曲线；没有 `motions` 时生成原地动作。
颜色用于多人白膜身份辨识，标签可由上层导演代理维护。

道具优先引用资产库中的 `asset_type`，轨迹仍由现有 `path` 语义处理。
机位保存位置、目标、FOV 和可选关键帧，镜头只保存对机位和对象状态的引用。

## 镜头快照

`shots[].object_states` 可以覆盖单个镜头内的角色位置、朝向、动作和运动段，
不会修改全局场景。使用 CLI 的 `--shot <id>` 编译指定镜头。

## 编译

```text
director-stage/1
  -> compileDirectorStage()
  -> spatial-plan/1
  -> compileSpatialPlan()
  -> whitebox/1
  -> Blender 白膜关键帧 / 视频
```

命令行：

```text
node cli/compile-director-stage.mjs scene.director.json --out scene.spatial.json
node cli/compile-director-stage.mjs scene.director.json --shot shot_01 --out shot_01.whitebox.json
```

该层只负责确定性状态转换，不负责推断剧本、生成模型或执行 Blender。
