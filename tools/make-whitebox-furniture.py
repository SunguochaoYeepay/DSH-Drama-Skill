import bpy
import os
import sys

out_dir = sys.argv[-1]
os.makedirs(out_dir, exist_ok=True)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def mat():
    m = bpy.data.materials.new('WhiteboxFurniture')
    m.diffuse_color = (0.48, 0.22, 0.12, 1)
    return m

def cube(name, size, loc, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(material)
    return o

def export(name, objects):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, name + '.glb'), export_format='GLB', use_selection=True)

reset()
m = mat()
parts = [cube('table_top', (2.8, 1.6, 0.16), (0, 0, 1.05), m)]
for x in (-1.2, 1.2):
    for y in (-0.6, 0.6):
        parts.append(cube('table_leg', (0.16, 0.16, 1.05), (x, y, 0.525), m))
export('table_basic', parts)

reset()
m = mat()
parts = [cube('chair_seat', (0.7, 0.7, 0.14), (0, 0, 0.55), m), cube('chair_back', (0.7, 0.14, 0.10), (0, -0.28, 0.61), m)]
for x in (-0.25, 0.25):
    for y in (-0.25, 0.25):
        parts.append(cube('chair_leg', (0.1, 0.1, 0.55), (x, y, 0.275), m))
export('chair_basic', parts)
