
OFFSETS = [
    (-0.5, -0.5, -0.5),
    (-0.5, -0.5, 0.5),
    (-0.5, 0.5, -0.5),
    (-0.5, 0.5, 0.5),
    (0.5, -0.5, -0.5),
    (0.5, -0.5, 0.5),
    (0.5, 0.5, -0.5),
    (0.5, 0.5, 0.5),
]

CRAFT_USER = 'ryansturmer'
def sphere(cx, cy, cz, r, fill=False, fx=False, fy=False, fz=False):
    result = set()
    for x in range(cx - r, cx + r + 1):
        if fx and x != cx:
            continue
        for y in range(cy - r, cy + r + 1):
            # if y < cy:
            #     continue # top hemisphere only
            if fy and y != cy:
                continue
            for z in range(cz - r, cz + r + 1):
                if fz and z != cz:
                    continue
                inside = False
                outside = fill
                for dx, dy, dz in OFFSETS:
                    ox, oy, oz = x + dx, y + dy, z + dz
                    d2 = (ox - cx) ** 2 + (oy - cy) ** 2 + (oz - cz) ** 2
                    d = d2 ** 0.5
                    if d < r:
                        inside = True
                    else:
                        outside = True
                if inside and outside:
                    result.add((x, y, z))
    return result

def line(a,b):
    delta = [end - start for start, end in zip(a, b)]
    steps = int(max(map(abs, delta)))
    if not steps:
        return [tuple(map(round, a))]
    return [tuple(round(start + d * i / steps) for start, d in zip(a, delta))
            for i in range(steps + 1)]

def polyline(points, closed=False):
    if len(points) <2:
        return []

    if closed:
        if points[-1] != points[0]:
            points.append(points[0])

    retval = []
    for i in range(len(points)-1):
        retval.extend(line(points[i], points[i+1]))

    return retval

def neighbors(x,y,z, xz=False, xy=False, yz=False):
    n = [(x+1,y,z), (x-1,y,z), (x,y+1,z), (x,y-1,z), (x,y,z+1),(x,y,z-1),
                        (x+1,y+1,z),(x+1,y-1,z),(x-1,y+1,z),(x-1,y-1,z), 
                       (x+1,y,z+1),(x+1,y,z-1),(x-1,y,z+1),(x-1,y,z-1),
                       (x,y+1,z+1),(x,y+1,z-1),(x,y-1,z+1),(x,y-1,z-1)]
    if(xz):
        return [(px,py,pz) for (px,py,pz) in n if py == y]
    if(xy):
        return [(px,py,pz) for (px,py,pz) in n if pz == z]
    if(yz):
        return [(px,py,pz) for (px,py,pz) in n if px == x]
    
    return n