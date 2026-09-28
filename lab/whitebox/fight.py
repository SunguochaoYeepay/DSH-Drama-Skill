"""打斗白膜（blockout）—— 带表演 + 专业长镜头调度。

场景：A 从画面深处走向 B，站定蓄力，右拳击打 B 面部，B 后仰踉跄跌坐。
镜头：一镜到底（不切镜），全程不过轴；建立 → 跟随 → 蓄力静止 →
      击打变焦推 + 微震 → 摇镜跟受击者 → 收势后撤。

用法：
    blender -b --python fight.py
环境变量：
    WB_FRAMES  帧数，默认 168（7 秒 @24fps）
    WB_TAG     输出前缀，默认 fight
"""
import math
import os

import bpy
from mathutils import Matrix

BASE = r"D:\DeepSeek\ai-images-harness\lab\whitebox\out\frames"
TAG = os.environ.get("WB_TAG", "fight")
FRAMES = int(os.environ.get("WB_FRAMES", "168"))
W, H = 480, 864  # 竖屏
FPS = 24

# ---------------- 时间线（帧 @24fps）----------------
F_WALK_END = 54    # A 走到位
F_WINDUP = 84      # 蓄力拉满
F_HIT = 88         # 接触帧
F_RECOIL = 96      # B 后仰到顶
F_STAGGER = 130    # 踉跄结束
F_SIT = 152        # B 跌坐到底
STEP = 26          # 走路循环周期（一周期两步）

# ---------------- 场面调度（世界坐标，米）----------------
A_P0 = (-1.35, -1.15)   # A 起点（远离 B）
A_P1 = (0.02, 0.20)     # A 走到 B 面前（站定位置）
B_P0 = (0.42, 1.05)     # B 站位
B_BACK1 = (0.60, 1.48)  # 受击后退第一步
B_BACK2 = (0.74, 1.86)  # 踉跄终点
LUNGE = 0.28            # 出拳时的上步距离

D = math.radians


def heading(p_from, p_to):
    """让角色局部 +y 轴对准 (p_from -> p_to)。"""
    return math.atan2(p_to[1] - p_from[1], p_to[0] - p_from[0]) - math.pi / 2


A_HEAD = heading(A_P0, A_P1)   # 走路朝向（沿路径）
A_FACE = heading(A_P1, B_P0)   # 站定后转身对准对手
B_HEAD = heading(B_P0, A_P1)   # B 面朝 A


def face_dir(theta):
    """朝向 theta 时，角色局部 +y（正前方）在世界里的单位向量。"""
    return (math.cos(theta + math.pi / 2.0), math.sin(theta + math.pi / 2.0))


PAIR_MID = ((A_P1[0] + B_P0[0]) / 2.0, (A_P1[1] + B_P0[1]) / 2.0)  # 两人中点，构图用


# ---------------- 基础构件 ----------------
def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def gray(name, rgb, rough=0.78):
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def empty(name, loc=(0.0, 0.0, 0.0)):
    o = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(o)
    o.empty_display_type = "PLAIN_AXES"
    o.empty_display_size = 0.25
    o.location = loc
    return o


def box(name, size, loc, mat, pivot_bottom=False):
    """尺寸烘焙进 mesh data，**不要用 object.scale**——
    否则挂在它下面的子物体（头、手臂）会连带被缩放。"""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object
    o.name = name
    if pivot_bottom:
        o.data.transform(Matrix.Translation((0, 0, 0.5)))  # 单位空间里抬到 [0,1]
    o.data.transform(Matrix.Diagonal((size[0], size[1], size[2], 1.0)))
    o.data.materials.append(mat)
    return o


def cyl(name, r, h, loc, mat, pivot_top=False):
    """pivot_top=True 时原点落到顶端（用于绕肩/髋摆动的四肢）。"""
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc)
    o = bpy.context.active_object
    o.name = name
    if pivot_top:
        o.data.transform(Matrix.Translation((0, 0, -h / 2.0)))
    o.data.materials.append(mat)
    return o


def ball(name, r, loc, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    return o


# ---------------- 场景 ----------------
def build_set(mats):
    m_floor, m_wall, m_prop = mats["floor"], mats["wall"], mats["prop"]
    box("Floor", (13.0, 13.0, 0.1), (0, 0, -0.05), m_floor)
    box("WallBack", (13.0, 0.12, 3.4), (0, 4.2, 1.7), m_wall)
    box("WallLeft", (0.12, 10.0, 3.4), (-4.2, 0.4, 1.7), m_wall)
    box("WallRight", (0.12, 10.0, 3.4), (4.6, 0.4, 1.7), m_wall)

    # 环境道具全部摆在动作区另一侧的深景层：给扩散模型空间参照，
    # 但机位（始终在 -x 侧）扫过去不会挡主体。竖屏视野窄，摆错一点就抢镜。
    box("BarCounter", (0.8, 3.0, 1.00), (3.30, 0.80, 0.50), m_prop)
    box("Crate_A", (0.70, 0.70, 0.70), (2.90, -1.40, 0.35), m_prop)
    box("Crate_B", (0.55, 0.55, 0.55), (2.72, -0.72, 0.98), m_prop)


def lights():
    bpy.ops.object.light_add(type="SUN", location=(3.0, -2.4, 5.0))
    s = bpy.context.active_object
    s.data.energy = 3.4
    s.rotation_euler = (D(54), 0, D(34))

    bpy.ops.object.light_add(type="AREA", location=(-2.0, 2.4, 3.0))
    a = bpy.context.active_object
    a.data.energy = 65.0
    a.data.size = 4.0
    a.rotation_euler = (D(66), 0, D(-28))

    sc = bpy.context.scene
    sc.world = bpy.data.worlds.new("W_Clay")
    bg = sc.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.88, 0.88, 0.88, 1.0)
    bg.inputs[1].default_value = 0.55


# ---------------- 角色（简易 rig）----------------
# 层级：Rig(定位/朝向) ├ LegL/LegR
#                      └ Body(起伏/扭转) ├ Pelvis
#                                        └ Torso(弯腰) ├ Head
#                                                      ├ ArmL
#                                                      └ ArmR
def build_actor(prefix, mat_body, mat_head):
    """层级（子物体一律显式写**局部**坐标，父不在原点时省得算错）：
    Rig(定位/朝向) ├ Leg(大腿) → Shin(小腿)
                   └ Body(起伏/拧转) ├ Pelvis
                                     └ Torso(弯腰) ├ Neck, Head, Face
                                                   └ Arm(上臂) → Fore(前臂) → Fist

    加肘和膝是必须的：单根直棍读不出"蓄力"和"出拳"的区别，
    四条直腿走起来也像僵尸。白色的 Face 板是给人/模型读朝向用的。
    """
    rig = empty(f"Rig_{prefix}")
    body = empty(f"Body_{prefix}")

    pelvis = box(f"Pelvis_{prefix}", (0.34, 0.23, 0.24), (0, 0, 0.80), mat_body)
    torso = box(f"Torso_{prefix}", (0.39, 0.25, 0.52), (0, 0, 0.92), mat_body, pivot_bottom=True)
    neck = cyl(f"Neck_{prefix}", 0.055, 0.10, (0, 0, 0.52), mat_body)
    head = ball(f"Head_{prefix}", 0.115, (0, 0, 0.68), mat_head)
    face = box(f"Face_{prefix}", (0.17, 0.04, 0.19), (0, 0.13, 0.36), mat_head)

    legs, shins = [], []
    for sx in (0.095, -0.095):
        thigh = cyl(f"Leg_{prefix}", 0.082, 0.46, (sx, 0, 0.92), mat_body)
        shin = cyl(f"Shin_{prefix}", 0.072, 0.46, (sx, 0, 0.92), mat_body)
        thigh.parent = rig
        thigh.location = (sx, 0, 0.92)
        shin.parent = thigh
        shin.location = (0, 0, -0.46)
        legs.append(thigh)
        shins.append(shin)

    arms, fores, fists = [], [], []
    for sx in (0.215, -0.215):
        arm = cyl(f"Arm_{prefix}", 0.054, 0.30, (sx, 0, 0.50), mat_body)
        fore = cyl(f"Fore_{prefix}", 0.046, 0.30, (sx, 0, 0.50), mat_body)
        fist = ball(f"Fist_{prefix}", 0.068, (sx, 0, 0.50), mat_body)
        arm.parent = torso
        arm.location = (0.252 if sx > 0 else -0.252, 0, 0.46)
        fore.parent = arm
        fore.location = (0, 0, -0.30)
        fist.parent = fore
        fist.location = (0, 0, -0.30)
        arms.append(arm)
        fores.append(fore)
        fists.append(fist)

    body.parent = rig
    pelvis.parent = body
    torso.parent = body
    neck.parent = torso
    neck.location = (0, 0, 0.52)
    head.parent = torso
    head.location = (0, 0, 0.68)
    face.parent = torso
    face.location = (0, 0.13, 0.36)

    return {
        "rig": rig,
        "body": body,
        "torso": torso,
        "head": head,
        "armR": arms[0], "armL": arms[1],
        "foreR": fores[0], "foreL": fores[1],
        "fistR": fists[0], "fistL": fists[1],
        "legR": legs[0], "legL": legs[1],
        "shinR": shins[0], "shinL": shins[1],
    }


# ---------------- 动画 ----------------
def kf(obj, prop, frame, value):
    setattr(obj, prop, value)
    obj.keyframe_insert(prop, frame=frame)


def smooth(t):
    return t * t * (3.0 - 2.0 * t)


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def lerp1(a, b, t):
    return a + (b - a) * t


def iter_fcurves(action):
    """Blender 5.x 把 Action 改成分层结构（layer/strip/channelbag），
    老的 action.fcurves 直接没了。两条路都试一遍，别让版本差异卡住。"""
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    out = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                out.extend(list(bag.fcurves))
    return out


def linearize(obj, props):
    """走路循环这类周期动作不要贝塞尔缓动，否则会有莫名的卡顿。"""
    ad = obj.animation_data
    if not ad or not ad.action:
        return
    for fc in iter_fcurves(ad.action):
        if fc.data_path in props:
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"


def anim_A(a):
    rig, body, torso, head = a["rig"], a["body"], a["torso"], a["head"]
    armR, armL, foreR, foreL = a["armR"], a["armL"], a["foreR"], a["foreL"]
    legR, legL, shinR, shinL = a["legR"], a["legL"], a["shinR"], a["shinL"]

    kf(rig, "rotation_euler", 1, (0, 0, A_HEAD))

    # ---- 1) 走向 B：走路循环（大腿摆 + 后摆侧屈膝；手臂反相摆 + 肘微弯）----
    for f in range(1, F_WALK_END + 1):
        x, y = a_pos(f)  # 与摄影取景用同一套位置，避免两边各算各的
        kf(rig, "location", f, (x, y, 0.0))

        ph = 2.0 * math.pi * (f - 1) / STEP
        s = math.sin(ph)
        kf(legR, "rotation_euler", f, (D(27) * s, 0, 0))
        kf(legL, "rotation_euler", f, (-D(27) * s, 0, 0))
        # 膝盖只能往后折：后摆那条腿屈膝，前摆那条伸直
        kf(shinR, "rotation_euler", f, (-D(36) * max(0.0, -s), 0, 0))
        kf(shinL, "rotation_euler", f, (-D(36) * max(0.0, s), 0, 0))

        kf(armR, "rotation_euler", f, (-D(17) * s, 0, 0))
        kf(armL, "rotation_euler", f, (D(17) * s, 0, 0))
        kf(foreR, "rotation_euler", f, (D(20 + 12 * s), 0, 0))
        kf(foreL, "rotation_euler", f, (D(20 - 12 * s), 0, 0))

        kf(body, "location", f, (0, 0, 0.022 * math.cos(2.0 * ph)))
        kf(body, "rotation_euler", f, (0, 0, -D(6) * s))
        kf(torso, "rotation_euler", f, (-D(4), 0, 0))
        kf(head, "rotation_euler", f, (0, 0, 0))

    # 走过来之后转身正对对手（走路方向 ≠ 对面方向，不转就是歪着打）
    kf(rig, "rotation_euler", F_WALK_END, (0, 0, A_HEAD))
    kf(rig, "rotation_euler", F_WALK_END + 8, (0, 0, A_FACE))

    # ---- 2) 站定 + 蓄力：弓步下沉、右拳收到下巴前、躯干后拧 ----
    kf(rig, "location", F_WALK_END + 6, (A_P1[0], A_P1[1], 0.0))
    kf(legR, "rotation_euler", F_WALK_END + 6, (-D(22), 0, 0))
    kf(legL, "rotation_euler", F_WALK_END + 6, (D(20), 0, 0))
    kf(shinR, "rotation_euler", F_WALK_END + 6, (-D(20), 0, 0))
    kf(shinL, "rotation_euler", F_WALK_END + 6, (-D(8), 0, 0))
    kf(body, "location", F_WALK_END + 6, (0, 0, -0.03))
    kf(body, "rotation_euler", F_WALK_END + 6, (0, 0, -D(20)))  # 拧转：右肩后拉
    kf(torso, "rotation_euler", F_WALK_END + 6, (D(3), 0, 0))   # 微微后坐
    kf(armR, "rotation_euler", F_WALK_END + 6, (D(30), 0, 0))
    kf(foreR, "rotation_euler", F_WALK_END + 6, (D(80), 0, 0))
    kf(armL, "rotation_euler", F_WALK_END + 6, (D(20), 0, 0))
    kf(foreL, "rotation_euler", F_WALK_END + 6, (D(55), 0, 0))
    kf(head, "rotation_euler", F_WALK_END + 6, (0, 0, -D(8)))

    kf(rig, "location", F_WINDUP, (A_P1[0], A_P1[1], 0.0))
    kf(legR, "rotation_euler", F_WINDUP, (-D(26), 0, 0))
    kf(legL, "rotation_euler", F_WINDUP, (D(24), 0, 0))
    kf(shinR, "rotation_euler", F_WINDUP, (-D(26), 0, 0))
    kf(shinL, "rotation_euler", F_WINDUP, (-D(10), 0, 0))
    kf(body, "location", F_WINDUP, (0, 0, -0.055))
    kf(body, "rotation_euler", F_WINDUP, (0, 0, -D(26)))
    kf(torso, "rotation_euler", F_WINDUP, (D(6), 0, 0))
    kf(armR, "rotation_euler", F_WINDUP, (D(50), 0, 0))    # 上臂抬起
    kf(foreR, "rotation_euler", F_WINDUP, (D(120), 0, 0))  # 前臂折回 = 拳护在下巴前
    kf(armL, "rotation_euler", F_WINDUP, (D(26), 0, 0))
    kf(foreL, "rotation_euler", F_WINDUP, (D(62), 0, 0))
    kf(head, "rotation_euler", F_WINDUP, (0, 0, -D(10)))

    # ---- 3) 出拳：4 帧爆发 + 上半身前冲（前臂从折到直，这是关键读点）----
    fd = face_dir(A_FACE)
    lx = A_P1[0] + fd[0] * LUNGE
    ly = A_P1[1] + fd[1] * LUNGE
    kf(rig, "location", F_HIT, (lx, ly, 0.0))
    kf(legR, "rotation_euler", F_HIT, (-D(32), 0, 0))
    kf(legL, "rotation_euler", F_HIT, (D(34), 0, 0))
    kf(shinR, "rotation_euler", F_HIT, (-D(30), 0, 0))
    kf(shinL, "rotation_euler", F_HIT, (-D(14), 0, 0))
    kf(body, "location", F_HIT, (0, 0, -0.02))
    kf(body, "rotation_euler", F_HIT, (0, 0, D(26)))    # 右肩送出（绕 z 正转才送得出去）
    kf(torso, "rotation_euler", F_HIT, (-D(14), 0, 0))  # 前倾压上
    kf(armR, "rotation_euler", F_HIT, (D(122), 0, 0))   # 上臂顶到水平之上
    kf(foreR, "rotation_euler", F_HIT, (D(0), 0, 0))    # 前臂打直 → 拳送到 B 的脸
    kf(armL, "rotation_euler", F_HIT, (-D(28), 0, 0))
    kf(foreL, "rotation_euler", F_HIT, (D(88), 0, 0))   # 左拳收回护住自己
    kf(head, "rotation_euler", F_HIT, (-D(4), 0, 0))

    # ---- 4) 收拳站定 ----
    kf(rig, "location", F_HIT + 16, (lerp1(A_P1[0], lx, 0.55), lerp1(A_P1[1], ly, 0.55), 0.0))
    kf(armR, "rotation_euler", F_HIT + 16, (D(26), 0, 0))
    kf(foreR, "rotation_euler", F_HIT + 16, (D(70), 0, 0))
    kf(armL, "rotation_euler", F_HIT + 16, (D(10), 0, 0))
    kf(foreL, "rotation_euler", F_HIT + 16, (D(40), 0, 0))
    kf(body, "rotation_euler", F_HIT + 16, (0, 0, D(10)))
    kf(torso, "rotation_euler", F_HIT + 16, (-D(5), 0, 0))
    kf(legR, "rotation_euler", F_HIT + 16, (-D(24), 0, 0))
    kf(legL, "rotation_euler", F_HIT + 16, (D(26), 0, 0))
    kf(shinR, "rotation_euler", F_HIT + 16, (-D(20), 0, 0))
    kf(shinL, "rotation_euler", F_HIT + 16, (-D(8), 0, 0))
    kf(head, "rotation_euler", F_HIT + 16, (-D(2), 0, 0))

    kf(rig, "location", FRAMES, (lerp1(A_P1[0], lx, 0.45), lerp1(A_P1[1], ly, 0.45), 0.0))
    kf(armR, "rotation_euler", FRAMES, (D(14), 0, 0))
    kf(foreR, "rotation_euler", FRAMES, (D(30), 0, 0))
    kf(armL, "rotation_euler", FRAMES, (D(6), 0, 0))
    kf(foreL, "rotation_euler", FRAMES, (D(22), 0, 0))
    kf(body, "rotation_euler", FRAMES, (0, 0, D(4)))
    kf(body, "location", FRAMES, (0, 0, 0.0))
    kf(torso, "rotation_euler", FRAMES, (-D(2), 0, 0))
    kf(legR, "rotation_euler", FRAMES, (-D(14), 0, 0))
    kf(legL, "rotation_euler", FRAMES, (D(16), 0, 0))
    kf(head, "rotation_euler", FRAMES, (0, 0, 0))

    for o in (legR, legL, shinR, shinL, armR, armL, foreR, foreL):
        linearize(o, {"rotation_euler"})


def arm_key(a, side, frame, upper, elbow, spread=0.0):
    """一条胳膊的关键帧：upper=上臂角（+ 向前），elbow=肘屈（+ 折向前上）。"""
    kf(a["arm" + side], "rotation_euler", frame, (upper, 0, D(spread if side == "R" else -spread)))
    kf(a["fore" + side], "rotation_euler", frame, (elbow, 0, 0))


def leg_key(a, side, frame, hip, knee, spread=0.0):
    kf(a["leg" + side], "rotation_euler", frame, (hip, 0, D(spread if side == "R" else -spread)))
    kf(a["shin" + side], "rotation_euler", frame, (knee, 0, 0))


def anim_B(b):
    rig, body, torso, head = b["rig"], b["body"], b["torso"], b["head"]

    kf(rig, "rotation_euler", 1, (0, 0, B_HEAD))
    kf(rig, "location", 1, (B_P0[0], B_P0[1], 0.0))

    # ---- 1) 静立：只有呼吸 + 转头看向走近的 A ----
    for f in (1, F_WALK_END // 2, F_WALK_END):
        kf(rig, "location", f, (B_P0[0], B_P0[1], 0.0))
        kf(body, "location", f, (0, 0, 0.006 * math.sin(2 * math.pi * f / 60.0)))
        kf(body, "rotation_euler", f, (0, 0, 0))
        kf(torso, "rotation_euler", f, (0, 0, 0))
        kf(head, "rotation_euler", f, (0, 0, D(-6 if f == 1 else 2)))
        arm_key(b, "R", f, 0, D(12))
        arm_key(b, "L", f, 0, D(12))
        leg_key(b, "R", f, 0, 0)
        leg_key(b, "L", f, 0, 0)

    # ---- 2) 察觉：抬手护胸，重心后压 ----
    arm_key(b, "R", F_WINDUP, D(52), D(95), 12)
    arm_key(b, "L", F_WINDUP, D(46), D(95), 12)
    kf(body, "rotation_euler", F_WINDUP, (0, 0, 0))
    kf(torso, "rotation_euler", F_WINDUP, (D(6), 0, 0))   # 正角 = 后仰/后压
    kf(head, "rotation_euler", F_WINDUP, (0, 0, D(4)))
    kf(rig, "location", F_WINDUP, (B_P0[0], B_P0[1], 0.0))

    # ---- 3) 中拳：头猛甩 + 躯干后仰 + 整个人被推退 ----
    # 接触那一帧人还在原地，之后才被推出去（先受力、后位移）
    kf(rig, "location", F_HIT, (B_P0[0], B_P0[1], 0.0))
    kf(head, "rotation_euler", F_HIT + 1, (D(22), 0, 0))
    kf(head, "rotation_euler", F_RECOIL, (D(42), 0, D(-14)))  # 头向后甩并侧偏
    kf(torso, "rotation_euler", F_RECOIL, (D(24), 0, 0))
    kf(body, "rotation_euler", F_RECOIL, (0, 0, D(16)))
    kf(body, "location", F_RECOIL, (0, 0, -0.02))
    kf(rig, "location", F_RECOIL, (B_BACK1[0], B_BACK1[1], 0.0))
    arm_key(b, "R", F_RECOIL, D(72), D(120), 20)   # 双手上抬护脸
    arm_key(b, "L", F_RECOIL, D(66), D(120), 20)
    leg_key(b, "R", F_RECOIL, -D(18), -D(30))
    leg_key(b, "L", F_RECOIL, D(14), -D(30))

    # ---- 4) 踉跄后退：大腿乱摆、膝盖发软 ----
    kf(rig, "location", F_STAGGER, (B_BACK2[0], B_BACK2[1], 0.0))
    leg_key(b, "R", F_STAGGER - 12, D(26), -D(44))
    leg_key(b, "L", F_STAGGER - 12, -D(22), -D(30))
    leg_key(b, "R", F_STAGGER, -D(20), -D(46))
    leg_key(b, "L", F_STAGGER, D(24), -D(34))
    kf(torso, "rotation_euler", F_STAGGER, (-D(6), 0, 0))
    kf(body, "rotation_euler", F_STAGGER, (0, 0, D(-8)))
    kf(head, "rotation_euler", F_STAGGER, (-D(8), 0, 0))
    arm_key(b, "R", F_STAGGER, D(40), D(70), 26)
    arm_key(b, "L", F_STAGGER, D(36), D(70), 26)

    # ---- 5) 跌坐：重心落地，腿前伸屈膝，上身前俯，手往后撑 ----
    kf(rig, "location", F_SIT, (B_BACK2[0] + 0.04, B_BACK2[1] + 0.06, -0.36))
    leg_key(b, "R", F_SIT, D(74), -D(58), 10)
    leg_key(b, "L", F_SIT, D(68), -D(54), 10)
    kf(torso, "rotation_euler", F_SIT, (-D(26), 0, 0))
    kf(body, "rotation_euler", F_SIT, (0, 0, 0))
    kf(head, "rotation_euler", F_SIT, (-D(18), 0, 0))
    arm_key(b, "R", F_SIT, D(34), D(38), 34)   # 手掌往后撑地
    arm_key(b, "L", F_SIT, D(28), D(38), 34)

    kf(rig, "location", FRAMES, (B_BACK2[0] + 0.05, B_BACK2[1] + 0.07, -0.37))
    kf(head, "rotation_euler", FRAMES, (-D(14), 0, 0))
    kf(torso, "rotation_euler", FRAMES, (-D(22), 0, 0))
    arm_key(b, "R", FRAMES, D(30), D(38), 34)
    arm_key(b, "L", FRAMES, D(24), D(38), 34)
    leg_key(b, "R", FRAMES, D(74), -D(58), 10)
    leg_key(b, "L", FRAMES, D(68), -D(54), 10)


# ---------------- 摄影 ----------------
# 一镜到底，全程不过轴（相机永远待在动作轴 A→B 的同一侧）。
#
# 机位不写死坐标，而是写「看谁 + 多远 + 什么方位角 + 多高」——
# 竖屏水平视野只有 22.6°，硬编码坐标很容易把主体框出画外；
# 由目标点反推机位，构图才锁得住。
#
#   frame, 注视点(x,y,z),                    距离, 方位角(°), 机位高, 焦距
CAM_KEYS = [
    # 建立：单人镜头跟着 A，B 在画面深处（不硬塞两个人）
    (1, (A_P0[0], A_P0[1], 1.00), 3.45, 233.0, 1.55, 46.0),
    (F_WALK_END // 2, (0.0, 0.0, 1.10), 3.60, 206.0, 1.52, 46.0),
    # 到位：镜头绕到侧后方，两人先后进画，形成对峙关系
    (F_WALK_END, (PAIR_MID[0], PAIR_MID[1], 1.15), 3.90, 172.0, 1.50, 48.0),
    # 蓄力：镜头继续侧移收拢，锁死不晃（让观众憋着）
    (F_WINDUP, (PAIR_MID[0], PAIR_MID[1], 1.25), 3.50, 152.0, 1.46, 52.0),
    # 击打：变焦推 + 机位前压，框住两个人上半身（再近就只剩特写，读不出动作）
    (F_HIT, (0.28, 0.75, 1.35), 4.00, 146.0, 1.40, 56.0),
    (F_HIT + 4, (0.30, 0.82, 1.32), 4.10, 148.0, 1.41, 52.0),
    # 摇镜跟住被打飞的人（留一点 A 在画框里，别把施暴者整个丢掉）
    (F_STAGGER, (0.51, 1.32, 1.00), 4.40, 158.0, 1.47, 48.0),
    # 收势后拉，把结果（跌坐）交代清楚
    (FRAMES, (0.53, 1.36, 0.85), 4.60, 152.0, 1.56, 44.0),
]


def a_pos(f):
    """A 在第 f 帧的位置（走路段用 smoothstep，之后站定不动）。"""
    if f >= F_WALK_END:
        return A_P1
    t = smooth((f - 1) / float(F_WALK_END - 1))
    return (lerp1(A_P0[0], A_P1[0], t), lerp1(A_P0[1], A_P1[1], t))


def cam_at(f):
    """由「注视点 + 方位 + 距离」反推第 f 帧的机位。"""
    keys = list(CAM_KEYS)
    keys[1] = (keys[1][0], (a_pos(F_WALK_END // 2)[0], a_pos(F_WALK_END // 2)[1], keys[1][1][2]),
               keys[1][2], keys[1][3], keys[1][4], keys[1][5])
    for i in range(len(keys) - 1):
        f0, t0, d0, a0, h0, l0 = keys[i]
        f1, t1, d1, a1, h1, l1 = keys[i + 1]
        if f0 <= f <= f1:
            u = (f - f0) / float(f1 - f0) if f1 > f0 else 0.0
            tgt = lerp(t0, t1, u)
            dist = lerp1(d0, d1, u)
            az = math.radians(lerp1(a0, a1, u))
            loc = (tgt[0] + dist * math.cos(az), tgt[1] + dist * math.sin(az), lerp1(h0, h1, u))
            return loc, tgt, lerp1(l0, l1, u)
    return None, None, None


def camera():
    loc, tgt_loc, lens = cam_at(1)
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.active_object
    cam.name = "Cam_Main"
    cam.data.lens = lens

    tgt = empty("CamTarget", tgt_loc)
    c = cam.constraints.new(type="TRACK_TO")
    c.target = tgt
    c.track_axis = "TRACK_NEGATIVE_Z"
    c.up_axis = "UP_Y"
    bpy.context.scene.camera = cam
    return cam, tgt


def anim_camera(cam, tgt):
    for f, _t, _d, _a, _h, _l in CAM_KEYS:
        loc, look, lens = cam_at(f)
        kf(cam, "location", f, loc)
        kf(tgt, "location", f, look)
        kf(cam.data, "lens", f, lens)

    # 击打冲击：几帧内衰减的抖动。别过头——白膜抖狠了整个控制信号会废掉。
    amp = 0.045
    for f in range(F_HIT - 2, F_HIT + 5):
        base, _look, _lens = cam_at(f)
        decay = math.exp(-abs(f - F_HIT) / 2.2)
        dx = amp * decay * math.sin(f * 2.7)
        dy = amp * decay * math.sin(f * 3.9 + 1.1)
        dz = amp * decay * 0.6 * math.sin(f * 3.1 + 0.4)
        kf(cam, "location", f, (base[0] + dx, base[1] + dy, base[2] + dz))


# ---------------- 渲染 ----------------
def render():
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
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


def diag():
    """WB_DIAG=1 时不渲染，只把层级/求值后的位置打出来。"""
    sc = bpy.context.scene
    sc.frame_set(1)
    deps = bpy.context.evaluated_depsgraph_get()
    print("=== 层级与位置（frame 1）===")
    for n in ("Rig_A", "Body_A", "Pelvis_A", "Torso_A", "Neck_A", "Head_A", "Face_A",
              "Arm_A", "Fore_A", "Fist_A", "Leg_A", "Shin_A"):
        o = bpy.data.objects.get(n)
        if o is None:
            print("  %-14s <不存在>" % n)
            continue
        e = o.evaluated_get(deps)
        print("  %-14s parent=%-12s local=%-22s world=%s" % (
            n, o.parent.name if o.parent else "-",
            [round(v, 2) for v in o.location],
            [round(v, 2) for v in e.matrix_world.translation]))

    for f in (1, 20, F_WALK_END, F_WINDUP, F_HIT, F_HIT + 4, F_RECOIL, F_STAGGER, FRAMES):
        sc.frame_set(f)
        deps = bpy.context.evaluated_depsgraph_get()
        cd = bpy.data.objects["Cam_Main"].data
        vfov = math.degrees(cd.angle_y if sc.render.resolution_y >= sc.render.resolution_x else cd.angle_x)

        def w(n):
            return [round(v, 2) for v in bpy.data.objects[n].evaluated_get(deps).matrix_world.translation]

        fist, hb, hb_low = w("Fist_A"), w("Head_B"), w("Neck_B")
        print("DIAG f=%-3d cam=%s 机高=%.2f lens=%.0f vfov=%.1f°%s | rigA=%s rigB=%s | 拳-头=%.2f"
              % (f, w("Cam_Main"), w("Cam_Main")[2], cd.lens, vfov,
                 " (墙外!)" if w("Cam_Main")[1] > 4.2 or w("Cam_Main")[0] < -4.2 else "",
                 w("Rig_A"), w("Rig_B"), math.dist(fist, hb)))


clear()
mats = {
    "floor": gray("M_Floor", (0.50, 0.50, 0.50)),
    "wall": gray("M_Wall", (0.66, 0.66, 0.66)),
    "prop": gray("M_Prop", (0.36, 0.36, 0.38)),
    "bodyA": gray("M_BodyA", (0.80, 0.80, 0.80)),
    "bodyB": gray("M_BodyB", (0.62, 0.62, 0.62)),
    "headA": gray("M_HeadA", (0.88, 0.88, 0.88)),
    "headB": gray("M_HeadB", (0.72, 0.72, 0.72)),
}
build_set(mats)
lights()
A = build_actor("A", mats["bodyA"], mats["headA"])
B = build_actor("B", mats["bodyB"], mats["headB"])
cam, tgt = camera()
anim_A(A)
anim_B(B)
anim_camera(cam, tgt)

sc = bpy.context.scene
sc.frame_start = 1
sc.frame_end = FRAMES
def stills():
    """WB_STILLS=... 时只渲指定帧（构图检查用，比整段渲染快得多）。"""
    fs = [int(x) for x in os.environ["WB_STILLS"].split(",")]
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    try:
        sc.eevee.taa_render_samples = 16
    except Exception:
        pass
    sc.render.resolution_x = W
    sc.render.resolution_y = H
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    for f in fs:
        sc.frame_set(f)
        sc.render.filepath = os.path.join(os.path.dirname(BASE), "stills", "s_%03d.png" % f)
        bpy.ops.render.render(write_still=True)
    print("STILLS_OK", fs)


if os.environ.get("WB_DIAG"):
    diag()
elif os.environ.get("WB_STILLS"):
    stills()
else:
    render()
    print(f"WHITEBOX_FIGHT_OK frames={FRAMES} -> {BASE}")
