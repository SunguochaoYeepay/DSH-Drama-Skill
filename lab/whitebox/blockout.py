"""双人餐桌白膜（blockout）—— beauty + depth 双通道。

照 mixar/Mickmumpitz 的 blockout 规范：只用 primitives、尺度真实、
地面与后墙必须留（否则生成出来的东西浮空）、材质一律留灰。
"""
import bpy
import math

BASE = r"D:\DeepSeek\ai-images-harness\lab\whitebox\out"
BEAUTY = BASE + r"\beauty.png"
W, H = 480, 864  # 竖屏，与剧目一致


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
    seats = [(0.06, -0.80, 1.0), (-0.06, 0.86, -1.0)]
    for i, (px, py, facing) in enumerate(seats):
        chair = box(f"ChairSeat_{i}", (0.46, 0.46, 0.05), (px, py, 0.45), m_wood)
        box(f"ChairBack_{i}", (0.46, 0.05, 0.5), (px, py + facing * 0.21, 0.70), m_wood)
        for sx in (-0.19, 0.19):
            for sy in (-0.19, 0.19):
                cyl(f"ChairLeg_{i}_{sx}_{sy}", 0.02, 0.45, (px + sx, py + sy, 0.225), m_wood)
        # 人物代理：躯干 + 头。轮廓对就行，不做细节
        torso = cyl(f"Torso_{i}", 0.165, 0.50, (px, py, 0.73), m_body)
        torso["seat_y"] = py
        ball(f"Head_{i}", 0.112, (px, py, 1.07), m_body)
        # 前臂搁桌：两截细圆柱，读得出"坐在桌前"
        for sx in (-0.17, 0.17):
            arm = cyl(
                f"Arm_{i}_{sx}",
                0.045,
                0.34,
                (px + sx, py + facing * 0.30, 0.82),
                m_body,
                rot=(math.radians(78 if facing > 0 else -78), 0, 0),
            )

    cyl("Cup_A", 0.04, 0.10, (-0.22, -0.28, 0.83), m_wood)
    cyl("Cup_B", 0.04, 0.10, (0.24, 0.26, 0.83), m_wood)
    cyl("Plate", 0.13, 0.02, (0.0, 0.0, 0.79), m_wood)


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
    bpy.ops.object.camera_add(location=(-1.85, -3.05, 1.80))
    cam = bpy.context.active_object
    cam.name = "Cam_Main"
    cam.data.lens = 35.0

    target = bpy.data.objects.new("CamTarget", None)
    bpy.context.scene.collection.objects.link(target)
    target.location = (0.05, 0.02, 0.90)
    t = cam.constraints.new(type="TRACK_TO")
    t.target = target
    t.track_axis = "TRACK_NEGATIVE_Z"
    t.up_axis = "UP_Y"
    bpy.context.scene.camera = cam


def compositor_depth():
    """Z pass → 归一到 [0,1]（近亮远暗）→ 单独写 PNG。"""
    sc = bpy.context.scene
    sc.view_layers[0].use_pass_z = True
    # Blender 5.x：compositor 是独立数据块，经 scene.compositing_node_group 挂载
    nt = bpy.data.node_groups.new("WB_Comp", "CompositorNodeTree")
    sc.compositing_node_group = nt
    sc.use_nodes = True
    nt.nodes.clear()

    rl = nt.nodes.new("CompositorNodeRLayers")
    rl.location = (-400, 0)

    # Blender 5.x：最终输出是节点组的 Output，不再是 Composite 节点
    comp = nt.nodes.new("NodeGroupOutput")
    comp.location = (220, 120)

    norm = nt.nodes.new("CompositorNodeNormalize")
    norm.location = (-140, -160)

    inv = nt.nodes.new("CompositorNodeInvert")
    inv.location = (20, -160)
    inv.inputs["Fac"].default_value = 1.0

    out = nt.nodes.new("CompositorNodeOutputFile")
    out.location = (220, -160)
    out.base_path = BASE
    out.format.file_format = "PNG"
    out.format.color_mode = "BW"
    out.file_slots[0].path = "depth_"

    nt.links.new(rl.outputs["Image"], comp.inputs[0])
    # 近处亮、远处暗：先逐帧归一到 0..1，再反相
    nt.links.new(rl.outputs["Depth"], norm.inputs[0])
    nt.links.new(norm.outputs[0], inv.inputs["Color"])
    nt.links.new(inv.outputs["Color"], out.inputs[0])


def render():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"  # headless 下最稳；白膜 16 采样足够
    sc.cycles.samples = 16
    sc.cycles.use_denoising = False
    sc.cycles.device = "CPU"
    sc.render.resolution_x = W
    sc.render.resolution_y = H
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.filepath = BEAUTY
    bpy.ops.render.render(write_still=True)


clear()
build()
lights()
camera()
compositor_depth()
render()
print("BLOCKOUT_OK")
