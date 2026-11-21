#include <assert.h>
#include <stdbool.h>
#include "../NetCraft/src/map.h"
#include "../NetCraft/src/worldgen/world.h"

int main(void) {
    Map map;
    map_alloc(&map, -1, WORLD_MIN_Y, -1, 3);
    assert(map_set(&map, -1, WORLD_MIN_Y, -1, -65));
    assert(map_set(&map, 0, -18, 0, 12));
    assert(map_set(&map, 0, WORLD_MAX_Y, 0, 6));
    assert(map_get(&map, -1, WORLD_MIN_Y, -1) == -65);
    assert(map_get(&map, 0, -18, 0) == 12);
    assert(map_get(&map, 0, WORLD_MAX_Y, 0) == 6);
    assert(!map_set(&map, 0, WORLD_MIN_Y - 1, 0, 6));
    assert(map_set(&map, 0, -18, 0, 0));
    assert(map_get(&map, 0, -18, 0) == 0);
    map_free(&map);
}
