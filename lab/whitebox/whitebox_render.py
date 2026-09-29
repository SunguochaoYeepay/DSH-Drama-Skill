"""白膜通用渲染器：读 whitebox/1 规划 JSON，自动搭棚、摆人、挂动作、运镜、渲染。

用法：
    blender -b --python lab/whitebox/whitebox_render.py -- <plan.json> [--out <dir>] [--stills-only]
环境变量：
    WB_DIAG=1   只打印诊断（求值后位置 / 相机出墙检查），不渲染

设计约束（references/whitebox-json.md）：
- AI 只写 JSON，本脚本是唯一渲染器；动作/角色只能从资产库菜单选
- 角色 = UAL Mannequin（glTF，NLA 挂 action，clip 间 blend_in 过渡防姿态瞬移）
- 刚体道具 = 内置基本体，Catmull-Rom 轨迹插值，朝向=切线，bank 自动侧倾
- 相机 = 注视点+方位角+距离+高度+焦距 逐帧反推（fight.py 的 cam_at 模式）
- 三交付物：视频 mp4 + 静帧 png + 期望屏幕坐标 coords.json
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSETS = os.environ.get("AIH_WHITEBOX_ASSETS", os.path.join(ROOT, "vendor", "whitebox-assets"))
PROP_ASSETS = os.path.join(ASSETS, "props")
GLTF = os.path.join(ASSETS, "ual", "AnimationLibrary_Godot_Standard.gltf")

D = math.radians
KEEP = {"Mannequin", "Rig"}  # glTF 里其余（Icosphere 小球）导入即删


# ---------------- 参数 ----------------
def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        raise SystemExit("用法: blender -b --python whitebox_render.py -- <plan.json> [--out <dir>] [--stills-only]")
    plan = argv[0]
    out = None
    stills_only = "--stills-only" in argv
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
        # Blender may change its process working directory; keep relative
        # outputs anchored to the repository instead of the host directory.
        if not os.path.isabs(out):
            out = os.path.join(ROOT, out)
    doc = json.load(open(plan, "r", encoding="utf-8"))
    if out is None:
        out = os.path.join(ROOT, "lab", "whitebox", "out", "render", doc.get("scene_name", "unnamed"))
    os.makedirs(out, exist_ok=True)
    return doc, out, stills_only


# ---------------- 运动学（与 JSON 语义一致的确定性插值）----------------
def smooth(t):
    return t * t * (3.0 - 2.0 * t)


def apply_curve(t, curve):
    if curve == "static":
        return 0.0
    if curve == "linear":
        return t
    return smooth(t)  # ease 默认


def clip_pos(clip, f):
    fr = clip["frame_range"]
    p0 = clip["start_pos"]
    p1 = clip.get("end_pos", p0)
    if f <= fr[0]:
        return list(p0)
    if f >= fr[1]:
        return list(p1)
    t = apply_curve((f - fr[0]) / float(fr[1] - fr[0]), clip.get("motion_curve", "ease"))
    return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]


def asset_pos(asset, f):
    """角色在第 f 帧的脚底 [x, y]。clip 空档 = 保持上一段末位置。"""
    if asset.get("kind") == "prop":
        p = path_pos(asset["path"], f)
        return [p.x, p.y]
    clips = asset.get("clips", [])
    pos = list(clips[0]["start_pos"]) if clips else [0.0, 0.0]
    for c in clips:
        if f < c["frame_range"][0]:
            break
        pos = clip_pos(c, f)
    return pos


def heading(p_from, p_to):
    """让角色局部 +y 对准 (p_from -> p_to)（fight.py 同款）。"""
    return math.atan2(p_to[1] - p_from[1], p_to[0] - p_from[0]) - math.pi / 2


def facing_at(asset, assets_by_id, clip, f):
    fc = clip.get("facing", 0)
    if fc == "auto_move":
        return heading(clip["start_pos"], clip.get("end_pos", clip["start_pos"]))
    if isinstance(fc, str) and fc.startswith("towards:"):
        target = assets_by_id[fc[8:]]
        return heading(asset_pos(asset, f), asset_pos(target, f))
    return D(float(fc))


# ---------------- Catmull-Rom（刚体轨迹）----------------
def catmull_rom(points, t):
    """t ∈ [0,1] 均匀参数；端点重复。"""
    pts = [points[0]] + list(points) + [points[-1]]
    n = len(points) - 1
    x = min(max(t, 0.0), 1.0) * n
    i = min(int(x), n - 1)
    u = x - i
    p0, p1, p2, p3 = (Vector(pts[i]), Vector(pts[i + 1]), Vector(pts[i + 2]), Vector(pts[i + 3]))
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                  + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u)


def path_pos(path, f):
    fr = path["frame_range"]
    t = 0.0 if f <= fr[0] else (1.0 if f >= fr[1] else (f - fr[0]) / float(fr[1] - fr[0]))
    t = apply_curve(t, path.get("motion_curve", "linear"))
    return catmull_rom(path["waypoints"], t)


# ---------------- 基础构件 ----------------
def gray_mat(name, g, rough=0.8):
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if isinstance(g, (list, tuple)) and len(g) == 3:
        rgb = tuple(float(v) for v in g)
    else:
        rgb = (float(g),) * 3
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def box(name, size, loc, mat):
    """尺寸烘焙进 mesh data，不许用 object.scale（fight.py 铁律）。"""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.data.transform(Matrix.Diagonal((size[0], size[1], size[2], 1.0)))
    o.data.materials.append(mat)
    return o


def build_stage(stage, mats):
    preset = stage.get("preset", "empty")
    box("Floor", (60.0, 60.0, 0.1), (0, 0, -0.05), mats["floor"])
    if preset == "room":
        sx, sy, sz = stage["size"]
        # 三面墙（后/左/右），正面开敞 —— fight.py 同款棚。
        # 封闭房间会让跟拍机位没地方站（f=1 相机出墙的教训）。
        box("WallBack", (sx + 1.0, 0.12, sz), (0, sy / 2, sz / 2), mats["wall"])
        box("WallLeft", (0.12, sy + 1.0, sz), (-sx / 2, 0, sz / 2), mats["wall"])
        box("WallRight", (0.12, sy + 1.0, sz), (sx / 2, 0, sz / 2), mats["wall"])
    elif preset == "valley":
        for side, ang in (("L", D(38)), ("R", -D(38))):
            o = box("Slope" + side, (26.0, 60.0, 0.4), (0, 0, 0), mats["wall"])
            o.rotation_euler = (0, ang, 0)
            o.location = (-7.5 if side == "L" else 7.5, 0, 2.2)
    elif preset == "platform":
        # 地铁站台：站台面在 -y 侧（顶面 z=0，人站这里），轨道沟在 +y 侧（下沉 1.1m），
        # 列车沿 x 方向行驶。加立柱/灯带/边缘线只为让"这是地铁站"可辨识 —— 白膜要剪影不要细节。
        sx = stage.get("size", [30, 12, 5])[0]
        box("Platform", (sx, 6.0, 1.2), (0, -3.0, -0.6), mats["floor"])
        # 顶棚只盖轨道侧：站台上方留开敞，既避免"露天白天空"，也不挡主光
        box("Canopy", (sx, 9.3, 0.3), (0, 4.65, 4.35), mats["ceil"])
        box("TrackBed", (sx, 4.4, 0.3), (0, 2.2, -1.25), mats["dark"])
        # 轨道贴着站台边缘（y≈1.4）：真实地铁就是停靠到站台边，远轨会把车"贴到后墙上"看不出是车
        for i, y in enumerate((1.15, 1.65)):
            box("Rail%d" % i, (sx, 0.12, 0.14), (0, y, -1.02), mats["dark"])
        box("EdgeLine", (sx, 0.16, 0.03), (0, -0.09, 0.015), mats["dark"])
        box("WallBack", (sx, 0.3, 8.0), (0, 9.0, 2.9), mats["wall"])
        # 立柱贴后墙放：站台上的柱子会正好挡在竖屏竖拍的主体前面（构图教训）
        for i, x in enumerate((-10.0, -4.0, 2.0, 8.0)):
            box("Pillar%d" % i, (0.55, 0.55, 7.0), (x, 8.5, 3.5), mats["wall"])
        for i, x in enumerate((-7.0, 0.0, 7.0)):
            box("Lamp%d" % i, (11.0, 0.2, 0.12), (x, -1.8, 4.1), mats["lamp"])
        # 顶棚横梁：没有结构的顶棚在大画幅里就是一片灰，加梁才有"车站顶"的层次
        for i, y in enumerate((1.0, 3.4, 5.8, 8.2)):
            box("Beam%d" % i, (sx, 0.35, 0.25), (0, y, 4.05), mats["dark"])


def load_prop_catalog():
    path = os.path.join(PROP_ASSETS, "manifest.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    return {a.get("asset_id"): a for a in doc.get("assets", []) if a.get("asset_id")}


def build_prop(asset, mat, prop_catalog=None):
    """内置基本体：只保证剪影和比例。统一让局部 +y 为前进方向。"""
    prop_catalog = prop_catalog or {}
    entry = prop_catalog.get(asset.get("model_asset_id")) or prop_catalog.get(asset.get("asset_type"))
    if entry and entry.get("model"):
        model_path = os.path.join(PROP_ASSETS, entry["model"])
        if not os.path.exists(model_path):
            raise RuntimeError("道具模型文件不存在: " + model_path)
        if os.path.splitext(model_path)[1].lower() not in (".glb", ".gltf"):
            raise RuntimeError("白膜渲染暂只支持 .glb/.gltf 道具模型: " + model_path)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=model_path)
        imported = [o for o in bpy.data.objects if o not in before]
        root = bpy.data.objects.new("P_" + asset["asset_id"], None)
        bpy.context.scene.collection.objects.link(root)
        for obj in imported:
            if obj.type == "MESH":
                obj.data.materials.clear()
                obj.data.materials.append(mat)
            obj.parent = root
        return root
    t = asset["asset_type"]
    parts = []
    if t == "jet":
        bpy.ops.mesh.primitive_cone_add(radius1=0.32, radius2=0.02, depth=3.2, location=(0, 0, 0))
        fus = bpy.context.active_object
        fus.data.transform(Matrix.Rotation(D(90), 4, "X"))  # 锥尖指向 +y
        parts = [fus, box("wing", (2.6, 0.7, 0.06), (0, -0.2, 0), mat),
                 box("tail", (0.9, 0.4, 0.05), (0, -1.3, 0.25), mat),
                 box("fin", (0.05, 0.5, 0.5), (0, -1.3, 0.25), mat)]
        parts.insert(0, fus)
        fus.data.materials.append(mat)
    elif t == "missile":
        bpy.ops.mesh.primitive_cone_add(radius1=0.09, radius2=0.01, depth=1.4, location=(0, 0, 0))
        body = bpy.context.active_object
        body.data.transform(Matrix.Rotation(D(90), 4, "X"))
        body.data.materials.append(mat)
        parts = [body, box("fins", (0.4, 0.25, 0.03), (0, -0.55, 0), mat)]
    elif t == "car":
        parts = [box("body", (1.8, 4.2, 0.6), (0, 0, 0.5), mat),
                 box("cabin", (1.6, 2.0, 0.5), (0, -0.2, 1.05), mat)]
    elif t == "train":
        # 一节地铁车厢：局部 +y 为前进方向；车底按轨道沟下沉（waypoint 的 z=0 = 站台面）
        dm = gray_mat("M_P_%s_dark" % asset["asset_id"], 0.16)
        parts = [box("body", (2.8, 9.0, 3.6), (0, 0, 0.7), mat),
                 box("windows", (2.9, 7.4, 0.85), (0, 0, 1.55), dm),
                 box("nose", (2.4, 1.4, 3.0), (0, 4.8, 0.4), mat),
                 box("skirt", (2.9, 8.6, 0.35), (0, 0, -0.85), dm)]
        # 车门的竖缝：只靠窗带读不出"地铁车厢"，加门线后一眼就是列车（仍是剪影级细节）
        for i, y in enumerate((-2.4, 0.0, 2.4)):
            parts.append(box("door%d" % i, (2.88, 0.18, 2.3), (0, y, 0.55), dm))
        # 车头灯（最亮的两个小块）：侧视时也能立刻认出"这是列车车头"
        lit = gray_mat("M_P_%s_lamp" % asset["asset_id"], 1.0)
        for i, x in enumerate((-0.85, 0.85)):
            parts.append(box("headlight%d" % i, (0.5, 0.3, 0.35), (x, 5.45, -0.2), lit))
    elif t == "table":
        # 简单方桌：用于空间调度验证，不承担最终美术细节。
        parts = [box("top", (2.8, 1.6, 0.16), (0, 0, 1.05), mat)]
        for x in (-1.2, 1.2):
            for y in (-0.6, 0.6):
                parts.append(box("leg", (0.16, 0.16, 1.05), (x, y, 0.525), mat))
    elif t == "chair":
        # 可复用白膜座椅：局部 +y 是坐下后人物面向的方向，椅背在 -y。
        parts = [box("seat", (0.7, 0.7, 0.14), (0, 0, 0.55), mat),
                 # Low back keeps the seated actor visible in a spatial preview.
                 box("back", (0.7, 0.14, 0.10), (0, -0.28, 0.61), mat)]
        for x in (-0.25, 0.25):
            for y in (-0.25, 0.25):
                parts.append(box("leg", (0.1, 0.1, 0.55), (x, y, 0.275), mat))
    else:  # crate
        parts = [box("crate", (0.7, 0.7, 0.7), (0, 0, 0.35), mat)]
    root = bpy.data.objects.new("P_" + asset["asset_id"], None)
    bpy.context.scene.collection.objects.link(root)
    for i, p in enumerate(parts):
        p.name = "P_%s_%d" % (asset["asset_id"], i)
        p.parent = root
    return root


# ---------------- 角色（UAL Mannequin + NLA）----------------
def import_character(asset, role):
    before_obj = set(bpy.data.objects)
    before_act = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=GLTF)
    new_obj = [o for o in bpy.data.objects if o not in before_obj]
    new_act = {a.name.split(".")[0]: a for a in bpy.data.actions if a not in before_act}

    arm = next(o for o in new_obj if o.type == "ARMATURE")
    # 删除和分拣同一趟完成：remove 之后引用整体失效，连 .name 都不能读
    alive = []
    for o in new_obj:
        if o.type == "MESH" and o.name.split(".")[0] not in KEEP:
            bpy.data.objects.remove(o, do_unlink=True)
        else:
            alive.append(o)
    arm.name = "C_" + asset["asset_id"]
    s = role.get("scale", 1.0)
    arm.scale = (s, s, s)

    # 角色默认按档位灰度；color 可用 RGB 三元组给多人稳定的身份色
    mat = gray_mat("M_" + asset["asset_id"], asset.get("color", role.get("gray", 0.7)))
    for o in alive:
        if o.type == "MESH":
            o.data.materials.clear()
            o.data.materials.append(mat)

    if not arm.animation_data:
        arm.animation_data_create()
    arm.animation_data.action = None

    # 每个 clip 一条 NLA 轨：strip 拉伸到帧区间，blend_in 过渡
    for i, clip in enumerate(asset["clips"]):
        act = new_act.get(clip["animation"])
        if act is None:
            raise RuntimeError("动作不在库里: " + clip["animation"])
        track = arm.animation_data.nla_tracks.new()
        track.name = "T_%s_%d" % (asset["asset_id"], i)
        f0, f1 = clip["frame_range"]
        strip = track.strips.new(act.name, f0, act)
        strip.name = "S_%d" % i
        strip.frame_start = f0
        strip.frame_end = f1
        a0, a1 = act.frame_range
        # 相位错开：同一个动作挂在不同角色上，若都从第 0 帧开始，一群人会整齐划一地待机（一眼假）
        off = float(clip.get("phase_offset", 0.0)) % 1.0
        strip.action_frame_start = a0 + (a1 - a0) * off
        strip.action_frame_end = a1
        strip.extrapolation = "HOLD"          # 空档保持末姿态，绝不回 T-pose
        strip.blend_type = "REPLACE"
        # 第一段不许 blend_in：否则第 1 帧影响力=0，画面以 T-pose 开场
        blend = 0 if i == 0 else min(clip.get("blend_frames", 4), max(0, f1 - f0 - 1))
        strip.blend_in = blend
        track.mute = False
    return arm


def keyframe_root_motion(arm, asset, assets_by_id, total):
    """Keep stage transforms independent from imported animation channels."""
    root = bpy.data.objects.new("Stage_" + asset["asset_id"], None)
    bpy.context.scene.collection.objects.link(root)
    arm.parent = root
    root.rotation_mode = "XYZ"
    for f in range(1, total + 1):
        clip = asset["clips"][0]
        for candidate in asset["clips"]:
            if candidate["frame_range"][0] <= f:
                clip = candidate
        p = asset_pos(asset, f)
        root.location = (p[0], p[1], 0.0)
        root.rotation_euler = (0, 0, facing_at(asset, assets_by_id, clip, f))
        root.keyframe_insert("location", frame=f)
        root.keyframe_insert("rotation_euler", frame=f)
    return root


# ---------------- 相机 ----------------
def cam_target_at(doc, assets_by_id, f):
    cam = doc["camera"]
    ctype = cam["type"]
    if ctype in ("pan-follow", "orbit"):
        p = asset_pos(assets_by_id[cam["track"]], f)
        return Vector((p[0], p[1], 1.2))
    if cam.get("track") and cam["track"] in assets_by_id:
        p = asset_pos(assets_by_id[cam["track"]], f)
        return Vector((p[0], p[1], 1.2))
    # 固定注视点：不跟踪任何资产时，看 look_at 指定的世界坐标（默认原点）
    la = cam.get("look_at")
    if isinstance(la, list) and len(la) >= 2:
        return Vector((la[0], la[1], la[2] if len(la) > 2 else 1.2))
    return Vector((0.0, 0.0, 1.0))


def cam_keys_at(cam, f):
    keys = cam["keys"]
    if f <= keys[0]["frame"]:
        return keys[0]
    if f >= keys[-1]["frame"]:
        return keys[-1]
    for i in range(len(keys) - 1):
        k0, k1 = keys[i], keys[i + 1]
        if k0["frame"] <= f <= k1["frame"]:
            u = (f - k0["frame"]) / float(k1["frame"] - k0["frame"])
            return {k: (k0[k] + (k1[k] - k0[k]) * u if k != "frame" else f) for k in k0}
    return keys[-1]


def cam_at(doc, assets_by_id, f):
    cam = doc["camera"]
    k = cam_keys_at(cam, f)
    tgt = cam_target_at(doc, assets_by_id, f)
    az = D(k["angle"])
    loc = Vector((tgt.x + k["dist"] * math.cos(az), tgt.y + k["dist"] * math.sin(az), k["height"]))
    shake = cam.get("shake")
    if shake and shake["frame_range"][0] <= f <= shake["frame_range"][1]:
        f0 = shake["frame_range"][0]
        decay = math.exp(-(f - f0) / 6.0)
        amp = shake["amp"] * decay
        loc += Vector((amp * math.sin(f * 2.7), amp * math.sin(f * 3.9 + 1.1), amp * 0.6 * math.sin(f * 3.1 + 0.4)))
    return loc, tgt, k["fov"]


def fov_to_lens(fov_deg, sensor=36.0):
    """水平视场角 → 焦距 mm（sensor_fit=HORIZONTAL）。"""
    return sensor / (2.0 * math.tan(D(fov_deg) / 2.0))


def build_camera(doc, assets_by_id, total):
    loc, tgt0, fov = cam_at(doc, assets_by_id, 1)
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.active_object
    cam.name = "Cam_Main"
    cam.data.sensor_fit = "HORIZONTAL"

    tgt = bpy.data.objects.new("CamTarget", None)
    bpy.context.scene.collection.objects.link(tgt)
    tgt.location = tgt0
    con = cam.constraints.new(type="TRACK_TO")
    con.target = tgt
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"
    bpy.context.scene.camera = cam

    for f in range(1, total + 1):
        loc, look, fov = cam_at(doc, assets_by_id, f)
        cam.location = loc
        cam.keyframe_insert("location", frame=f)
        tgt.location = look
        tgt.keyframe_insert("location", frame=f)
        cam.data.lens = fov_to_lens(fov)
        cam.data.keyframe_insert("lens", frame=f)
    return cam


# ---------------- 灯光 / 渲染 ----------------
def lights():
    # 光照刻意压暗：过曝会把灰度层次冲平，白膜就退化成"一坨白"，看不出前后与剪影
    bpy.ops.object.light_add(type="SUN", location=(3.0, -2.4, 5.0))
    s = bpy.context.active_object
    s.data.energy = 2.0
    s.rotation_euler = (D(54), 0, D(34))
    bpy.ops.object.light_add(type="AREA", location=(-2.0, 2.4, 3.0))
    a = bpy.context.active_object
    a.data.energy = 34.0
    a.data.size = 4.0
    a.rotation_euler = (D(66), 0, D(-28))
    sc = bpy.context.scene
    sc.world = bpy.data.worlds.new("W_Clay")
    bg = sc.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.72, 0.72, 0.72, 1.0)
    bg.inputs[1].default_value = 0.32


def setup_render(doc, out):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.fps = doc.get("fps", 24)
    # 观感（不改几何语义）：默认 AgX 视图变换会把灰阶压成灰蒙蒙一片，白膜要的是干净的分层
    try:
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
    except Exception:
        pass
    ee = getattr(sc, "eevee", None)
    if ee is not None:
        for attr, val in (("taa_render_samples", 64), ("use_shadows", True), ("use_raytracing", True)):
            try:
                setattr(ee, attr, val)
            except Exception:
                pass
    sc.frame_start = 1
    sc.frame_end = doc["total_frames"]
    # 默认 480x864（直接喂 H3）。审片要看清时可用 WB_WIDTH/WB_HEIGHT 渲大图，
    # 白膜视频本身仍按默认分辨率出（改分辨率会改变控制信号的像素分布，别混用）。
    sc.render.resolution_x = int(os.environ.get("WB_WIDTH", 480))
    sc.render.resolution_y = int(os.environ.get("WB_HEIGHT", 864))
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    return sc


def render_frames(sc, doc, out):
    """渲 PNG 序列到 frames/，mp4 由外部 ffmpeg 封装
    （本机 Blender 5.2 编译版没有 FFMPEG 输出格式，fight.py 也是这条路）。"""
    frames_dir = os.path.join(out, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = os.path.join(frames_dir, "f_")
    bpy.ops.render.render(animation=True)
    return frames_dir


def render_stills(sc, doc, out):
    sc.render.image_settings.file_format = "PNG"
    for f in doc.get("outputs", {}).get("stills", []):
        sc.frame_set(f)
        sc.render.filepath = os.path.join(out, "still_f%04d.png" % f)
        bpy.ops.render.render(write_still=True)


def write_screen_coords(sc, doc, out, cam, tracked):
    """每个被跟踪角色/道具每帧的期望屏幕坐标（NDC），审核基准用。"""
    table = {}
    for f in range(1, doc["total_frames"] + 1):
        sc.frame_set(f)
        row = {}
        for aid, obj, zhead in tracked:
            root_w = obj.matrix_world.translation
            forward = obj.matrix_world.to_quaternion() @ Vector((0, 1, 0))
            row[aid] = {
                "world_position": [round(v, 6) for v in root_w],
                "world_forward": [round(v, 6) for v in forward],
            }
            head_w = root_w + Vector((0, 0, zhead))
            for label, w in (("root", root_w), ("head", head_w)):
                ndc = world_to_camera_view(sc, cam, w)
                vis = ndc.z > 0 and 0.0 <= ndc.x <= 1.0 and 0.0 <= ndc.y <= 1.0
                row.setdefault(aid, {})[label] = [round(ndc.x, 4), round(ndc.y, 4)]
                row[aid][label + "_visible"] = bool(vis)
        table[f] = row
    with open(os.path.join(out, "coords.json"), "w", encoding="utf-8") as fh:
        json.dump({"fps": sc.render.fps, "frames": table}, fh, ensure_ascii=False)


def diag(doc, assets_by_id, cam):
    sc = bpy.context.scene
    print("=== WB_DIAG ===")
    bounds = None
    if doc["stage"].get("preset") == "room":
        bounds = (doc["stage"]["size"][0] / 2, doc["stage"]["size"][1] / 2)
    for f in (1, doc["total_frames"] // 2, doc["total_frames"]):
        sc.frame_set(f)
        loc, tgt, fov = cam_at(doc, assets_by_id, f)
        warn = ""
        # 三面墙棚：左右墙与后墙外才会渲出灰板；正面（-y）开敞
        if bounds and (abs(loc.x) > bounds[0] or loc.y > bounds[1]):
            warn = "  ⚠ 相机出墙"
        print("f=%d cam=(%.2f,%.2f,%.2f) tgt=(%.2f,%.2f,%.2f) fov=%.1f%s"
              % (f, loc.x, loc.y, loc.z, tgt.x, tgt.y, tgt.z, fov, warn))
        for aid, a in assets_by_id.items():
            print("  %s pos=%s" % (aid, ["%.2f" % v for v in asset_pos(a, f)]))


# ---------------- 主流程 ----------------
def main():
    doc, out, stills_only = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = setup_render(doc, out)  # 先定 fps，glTF 导入按场景 fps 换算帧

    # 灰度梯度就是白膜的"构图可读性"：地面最亮、顶棚次之、后墙偏暗，主体再暗一档 → 剪影清楚
    mats = {"floor": gray_mat("M_Floor", 0.88), "wall": gray_mat("M_Wall", 0.24),
            "ceil": gray_mat("M_Ceil", 0.76), "dark": gray_mat("M_Dark", 0.16),
            "lamp": gray_mat("M_Lamp", 1.0)}
    build_stage(doc["stage"], mats)
    lights()

    menu = json.load(open(os.path.join(ASSETS, "manifest.json"), "r", encoding="utf-8"))
    roles = menu.get("roles", {})

    assets_by_id = {a["asset_id"]: a for a in doc["assets"]}
    prop_catalog = load_prop_catalog()
    tracked = []
    for a in doc["assets"]:
        if a["kind"] == "character":
            arm = import_character(a, roles.get(a["asset_type"], {}))
            root = keyframe_root_motion(arm, a, assets_by_id, doc["total_frames"])
            zhead = 1.7 * roles.get(a["asset_type"], {}).get("scale", 1.0)
            tracked.append((a["asset_id"], root, zhead))
        else:
            root = build_prop(a, gray_mat("M_P_" + a["asset_id"], a.get("color", 0.5)), prop_catalog)
            path = a["path"]
            for f in range(path["frame_range"][0], path["frame_range"][1] + 1):
                p = path_pos(path, f)
                p_next = path_pos(path, min(f + 1, path["frame_range"][1]))
                root.location = p
                tangent = p_next - p
                if tangent.length > 1e-6:
                    q = Vector((0, 1, 0)).rotation_difference(tangent.normalized())
                    root.rotation_mode = "QUATERNION"
                    root.rotation_quaternion = q
                    if path.get("bank", False):
                        p_prev = path_pos(path, max(f - 1, path["frame_range"][0]))
                        yaw_rate = math.atan2(tangent.x, tangent.y) - math.atan2((p - p_prev).x, (p - p_prev).y + 1e-9)
                        roll = max(-D(45), min(D(45), yaw_rate * 18.0))
                        root.rotation_quaternion = q @ Matrix.Rotation(roll, 4, "Y").to_quaternion()
                else:
                    # Static props still need an authored facing (chairs, doors,
                    # seats); a zero-length path must not erase it.
                    root.rotation_mode = "XYZ"
                    root.rotation_euler = (0, 0, D(float(a.get("facing", 0))))
                root.keyframe_insert("location", frame=f)
                if root.rotation_mode == "QUATERNION":
                    root.keyframe_insert("rotation_quaternion", frame=f)
                else:
                    root.keyframe_insert("rotation_euler", frame=f)
            tracked.append((a["asset_id"], root, 0.5))

    cam = build_camera(doc, assets_by_id, doc["total_frames"])

    if os.environ.get("WB_DIAG") == "1":
        diag(doc, assets_by_id, cam)
        return
    if not stills_only:
        render_frames(sc, doc, out)
    render_stills(sc, doc, out)
    if doc.get("outputs", {}).get("screen_coords", False):
        write_screen_coords(sc, doc, out, cam, tracked)
    print("WB_RENDER_OK -> " + out)


main()
