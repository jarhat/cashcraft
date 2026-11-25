from ctypes import CDLL, CFUNCTYPE, c_bool, c_int, c_void_p
from collections import OrderedDict
from pathlib import Path
import os
import subprocess
import tempfile

WORLD_FUNC = CFUNCTYPE(None, c_int, c_int, c_int, c_int, c_void_p)

def load_generator():
    bundled = Path(__file__).with_name('terrain.so')
    if bundled.is_file():
        dll = CDLL(str(bundled))
    else:
        dll = build_generator()
    dll.create_world.argtypes = [c_int, c_int, WORLD_FUNC, c_void_p]
    dll.create_world.restype = None
    dll.init_blocks()
    dll.is_obstacle.argtypes = [c_int]
    dll.is_obstacle.restype = c_bool
    return dll

def build_generator():
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='craftbot-') as directory:
        library = Path(directory) / 'terrain.so'
        subprocess.run([
            os.environ.get('CC', 'cc'), '-shared', '-fPIC', '-O2',
            '-DGLFW_INCLUDE_NONE', '-I', root / 'src', '-I', root / 'deps/noise',
            root / 'src/item.c', root / 'src/gamemode.c',
            root / 'deps/noise/noise.c', *sorted((root / 'src/worldgen').glob('*.c')),
            '-lm', '-o', library,
        ], check=True)
        return CDLL(str(library))

def dll_create_world(dll, p, q):
    result = {}
    def world_func(x, y, z, w, arg):
        result[(x, y, z)] = w
    dll.create_world(p, q, WORLD_FUNC(world_func), None)
    return result

class World(object):
    def __init__(self, seed=None, cache_size=512):
        self.dll = None
        self.seed = seed
        self.cache = OrderedDict()
        self.cache_size = cache_size
    def create_chunk(self, p, q):
        if self.dll is None:
            self.dll = load_generator()
        if self.seed is not None:
            self.dll.seed(self.seed)
        return dll_create_world(self.dll, p, q)
    def get_chunk(self, p, q):
        try:
            chunk = self.cache.pop((p, q))
        except KeyError:
            chunk = self.create_chunk(p, q)
        self.cache[(p, q)] = chunk
        if len(self.cache) > self.cache_size:
            self.cache.popitem(False)
        return chunk
