"""双人餐桌白膜（blockout）—— 序列版。

照 mixar/Mickmumpitz 的 blockout 规范：只用 primitives、尺度真实、
地面与后墙必须留（否则生成出来的东西浮空）、材质一律留灰。

用法：
    blender -b --python whitebox.py
环境变量：
    WB_FRAMES  帧数，默认 120（5 秒 @24fps）
    WB_TAG     输出前缀，默认 beauty
"""
import math
import os

import bpy

BASE = r"D:\DeepSeek\ai-images-harness\lab\whitebox\out\frames"
TAG = os.environ.get("WB_TAG", "beauty")
FRAMES = int(os.environ.get("WB_FRAMES", "120"))
W, H = 480, 864  # 竖屏，与剧目一致
FPS = 24

# 相机起点/终点：缓慢推近，落幅比首帧近约 15%
CAM_A = (-2.05, -3.35, 1.88)
CAM_B = (-1.72, -2.82, 1.72)
CAM_TARGET = (0.05, 0.02, 0.90)


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def gray(name, rgb, rough=0.75):
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def box(name, size, loc, mat):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    o.data.materials.append(mat)
    return o


def cyl(name, r, h, loc, mat, rot=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc)
    o = bpy.context.active_object
    o.name = name
    if rot:
        o.rotation_euler = rot
    o.data.materials.append(mat)
    return o


def ball(name, r, loc, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    return o


def build():
    m_floor = gray("M_Floor", (0.52, 0.52, 0.52))
    m_wall = gray("M_Wall", (0.64, 0.64, 0.64))
    m_wood = gray("M_Furniture", (0.38, 0.38, 0.40))
    m_body = gray("M_Body", (0.74, 0.74, 0.74))

    box("Floor", (9.0, 9.0, 0.1), (0, 0, -0.05), m_floor)
    box("WallBack", (9.0, 0.1, 3.2), (0, 3.2, 1.6), m_wall)
    box("WallLeft", (0.1, 7.0, 3.2), (-4.6, 0, 1.6), m_wall)

    # 餐桌：桌面 1.4 x 0.9，高 0.75
    box("TableTop", (1.4, 0.9, 0.06), (0, 0, 0.75), m_wood)
    for dx in (-0.62, 0.62):
        for dy in (-0.36, 0.36):
            cyl(f"Leg_{dx}_{dy}", 0.035, 0.72, (dx, dy, 0.36), m_wood)

    # 两人沿 y 一前一后落座 —— 竖屏天然适合纵深排列
    # face_dir 指向桌子；椅背在人的**背后**（背离桌子），手臂朝桌子伸
    seats = [(0.06, -0.80, 1.0), (-0.06, 0.86, -1.0)]
    actors = []
    for i, (px, py, face) in enumerate(seats):
        box(f"ChairSeat_{i}", (0.46, 0.46, 0.05), (px, py, 0.45), m_wood)
        box(f"ChairBack_{i}", (0.46, 0.05, 0.5), (px, py - face * 0.22, 0.70), m_wood)
        for sx in (-0.19, 0.19):
            for sy in (-0.19, 0.19):
                cyl(f"ChairLeg_{i}_{sx}_{sy}", 0.02, 0.45, (px + sx, py + sy, 0.225), m_wood)
        torso = cyl(f"Torso_{i}", 0.165, 0.50, (px, py, 0.73), m_body)
        head = ball(f"Head_{i}", 0.112, (px, py, 1.07), m_body)
        for sx in (-0.17, 0.17):
            cyl(
                f"Arm_{i}_{sx}",
                0.045,
                0.34,
                (px + sx, py + face * 0.30, 0.82),
                m_body,
                rot=(math.radians(78 if face > 0 else -78), 0, 0),
            )
        actors.append((torso, head, px, py))

    cyl("Cup_A", 0.04, 0.10, (-0.22, -0.28, 0.83), m_wood)
    cyl("Cup_B", 0.04, 0.10, (0.24, 0.26, 0.83), m_wood)
    cyl("Plate", 0.13, 0.02, (0.0, 0.0, 0.79), m_wood)
    return actors


def lights():
    bpy.ops.object.light_add(type="SUN", location=(2.5, -2.0, 4.0))
    s = bpy.context.active_object
    s.data.energy = 3.2
    s.rotation_euler = (math.radians(52), 0, math.radians(28))

    bpy.ops.object.light_add(type="AREA", location=(-1.6, 1.6, 2.8))
    a = bpy.context.active_object
    a.data.energy = 70.0
    a.data.size = 3.5
    a.rotation_euler = (math.radians(68), 0, math.radians(-25))

    sc = bpy.context.scene
    sc.world = bpy.data.worlds.new("W_Clay")
    bg = sc.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.86, 0.86, 0.86, 1.0)
    bg.inputs[1].default_value = 0.55


def camera():
    """斜侧 45°：能同时读到两人的侧面与桌面纵深。"""
    bpy.ops.object.camera_add(location=CAM_A)
    cam = bpy.context.active_object
    cam.name = "Cam_Main"
    cam.data.lens = 35.0

    target = bpy.data.objects.new("CamTarget", None)
    bpy.context.scene.collection.objects.link(target)
    target.location = CAM_TARGET
    t = cam.constraints.new(type="TRACK_TO")
    t.target = target
    t.track_axis = "TRACK_NEGATIVE_Z"
    t.up_axis = "UP_Y"
    bpy.context.scene.camera = cam
    return cam


def animate(cam, actors):
    """白膜要给出"表演"的骨架：相机推近 + 两人有活气。"""
    last = FRAMES

    # 相机：线性推近
    for f, loc in ((1, CAM_A), (last, CAM_B)):
        cam.location = loc
        cam.keyframe_insert("location", frame=f)

    # 两人：躯干轻微前倾 + 头部微转（读得出"在说话/在听"）
    lean = [(0.0, 5.0), (4.0, 0.0)]  # (前倾角°, 头部偏转°)
    for i, (torso, head, px, py) in enumerate(actors):
        a0, h0 = lean[i]
        for f, k in ((1, 0.0), (last // 2, 1.0), (last, 0.35)):
            torso.rotation_euler = (math.radians(a0 * k), 0, 0)
            torso.keyframe_insert("rotation_euler", frame=f)
            head.rotation_euler = (0, 0, math.radians(h0 * k))
            head.keyframe_insert("rotation_euler", frame=f)

    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = last


def render():
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"  # 5.x 的 EEVEE Next 就叫这个名，headless 可用
    try:
        sc.eevee.taa_render_samples = 16
    except Exception:
        pass
    sc.render.fps = FPS
    sc.render.resolution_x = W
    sc.render.resolution_y = H
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.filepath = os.path.join(BASE, TAG + "_")
    bpy.ops.render.render(animation=True)


clear()
actors = build()
lights()
cam = camera()
animate(cam, actors)
render()
print(f"WHITEBOX_OK frames={FRAMES} -> {BASE}")
