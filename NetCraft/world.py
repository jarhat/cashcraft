# gcc -std=c99 -O3 -shared -o world \
# -I src -I deps/noise deps/noise/noise.c src/world.c

from ctypes import CDLL, CFUNCTYPE, c_float, c_int, c_void_p
from collections import OrderedDict
import threading


dll = CDLL('./world')

WORLD_FUNC = CFUNCTYPE(
    None,
    c_int, c_int, c_int, c_int,
    c_void_p
)

# The C library uses shared generator state, including its seed.
_dll_lock = threading.RLock()


def dll_seed(x):
    dll.seed(int(x))


def dll_create_world(p, q):
    result = {}

    def world_func(x, y, z, w, arg):
        result[(x, y, z)] = w

    # Keep a reference to the callback until the synchronous C call completes.
    callback = WORLD_FUNC(world_func)

    with _dll_lock:
        dll.create_world(int(p), int(q), callback, None)

    return result


dll.simplex2.restype = c_float
dll.simplex2.argtypes = [
    c_float,
    c_float,
    c_int,
    c_float,
    c_float,
]


def dll_simplex2(x, y, octaves=1, persistence=0.5, lacunarity=2.0):
    return dll.simplex2(x, y, octaves, persistence, lacunarity)


dll.simplex3.restype = c_float
dll.simplex3.argtypes = [
    c_float,
    c_float,
    c_float,
    c_int,
    c_float,
    c_float,
]


def dll_simplex3(x, y, z, octaves=1, persistence=0.5, lacunarity=2.0):
    return dll.simplex3(x, y, z, octaves, persistence, lacunarity)


class World(object):
    def __init__(self, seed=None, cache_size=8192):
        self.seed = seed
        self.cache = OrderedDict()
        self.cache_size = max(0, int(cache_size))
        self._lock = threading.RLock()

    def create_chunk(self, p, q):
        # The C noise generator has global seed state, so serialize seeding
        # and generation together.
        with _dll_lock:
            if self.seed is not None:
                dll_seed(self.seed)

            return dll_create_world(p, q)

    def get_chunk(self, p, q):
        key = (int(p), int(q))

        with self._lock:
            try:
                chunk = self.cache.pop(key)
            except KeyError:
                chunk = self.create_chunk(*key)

            self.cache[key] = chunk

            while len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)

            return chunk

