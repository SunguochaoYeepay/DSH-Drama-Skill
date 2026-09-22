# 关键帧人工审阅

机器检查只能判定是否可送审。请逐张查看人物身份、体型比例、构图、动作起点和场景连续性。

- g001.png: E:\AI-Tool\DeepSeek\story2video\projects\not_awake\keyframes_render\g001.png
- g002.png: E:\AI-Tool\DeepSeek\story2video\projects\not_awake\keyframes_render\g002.png
- g003.png: E:\AI-Tool\DeepSeek\story2video\projects\not_awake\keyframes_render\g003.png

## 送模型的提示词与 `keyframe_start` 的差异（抽卡师删减留档）

- **g003**：送模型 452 字，自检通过
  - 抽卡师删掉 10 处：
    - [景别硬边界块 152 字] 构图要求：【景别｜中景】画面下边界严格切在人物的…
    - [噪声子句] 尚未碰到那只还在响的闹钟。
    - [噪声子句] 她尚未把闹钟抓起来
    - [噪声子句] 也尚未把它压到枕头底下。
    - [与【光】重复] 光线：她的上半身处在半暗部，晨光在枕头与被子上形成亮调的边缘， 这一小片
    - [元标签段] 【抽卡师｜执行层执行编译】
    - [元标签段] 【景别】中景
    - [元标签段] 【机位/构图】固定，轻微手持晃动；按导演分镜的景别与构图执行，不自行改变
    - [元标签段] 【空间关系】画面中的人物、承托物、道具与空间关系必须与导演首帧状态一致；
    - [否定子句] 【人物造型师当前镜头排除】当前镜头不应出现鞋子、拖鞋或站立姿态；

生成记录：E:\AI-Tool\DeepSeek\story2video\projects\not_awake\reviews\keyframes.generation.json
确认命令：node cli/review-gate.mjs approve --project "E:\AI-Tool\DeepSeek\story2video\projects\not_awake" --stage keyframes --plan "E:\AI-Tool\DeepSeek\story2video\projects\not_awake\render.plan.json"
