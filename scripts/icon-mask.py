"""Make everything outside the macOS rounded square transparent (qlmanage renders SVG on white).
Usage: python3 scripts/icon-mask.py build/icon.png   (1024x1024 RGBA, square at 100..924, radius 185)"""
import struct, sys, zlib

path = sys.argv[1]
data = open(path, 'rb').read()
pos, idat, ihdr = 8, b'', None
while pos < len(data):
    n = struct.unpack('>I', data[pos:pos + 4])[0]
    kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]
    if kind == b'IHDR': ihdr = body
    if kind == b'IDAT': idat += body
    pos += 12 + n
w, h, depth, ctype = struct.unpack('>IIBB', ihdr[:10])
assert (depth, ctype) == (8, 6), 'expects 8-bit RGBA'
raw, bpp, stride = zlib.decompress(idat), 4, w * 4

# Undo PNG row filters.
rows, prev = [], bytearray(stride)
for y in range(h):
    f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
    for x in range(stride):
        a = line[x - bpp] if x >= bpp else 0
        b, c = prev[x], prev[x - bpp] if x >= bpp else 0
        if f == 1: line[x] = (line[x] + a) & 255
        elif f == 2: line[x] = (line[x] + b) & 255
        elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
        elif f == 4:
            p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(line); prev = line

def inside(x, y, x0=100, x1=924, r=185):
    cx = min(max(x, x0 + r), x1 - r); cy = min(max(y, x0 + r), x1 - r)
    return x0 <= x <= x1 and x0 <= y <= x1 and (x - cx) ** 2 + (y - cy) ** 2 <= r * r

s = w / 1024
for y, line in enumerate(rows):
    for x in range(w):
        if not inside(x / s, y / s): line[x * 4 + 3] = 0

out = b''.join(b'\x00' + bytes(l) for l in rows)
chunk = lambda k, b: struct.pack('>I', len(b)) + k + b + struct.pack('>I', zlib.crc32(k + b) & 0xffffffff)
open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(out, 9)) + chunk(b'IEND', b''))
assert rows[0][3] == 0 and rows[h // 2][(w // 2) * 4 + 3] == 255  # self-check: corner clear, centre opaque
print('masked', path)
