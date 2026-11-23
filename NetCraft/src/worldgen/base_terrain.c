#include "base_terrain.h"
#include "noise.h"
#include "../config.h"
#include "../item.h"
#include <stdint.h>

int deep_stone(int x, int y, int z) {
    if (y >= 16) return Item_STONE;
    uint32_t hash = (uint32_t)x * 0x9e3779b1u ^ (uint32_t)y * 0x85ebca77u ^ (uint32_t)z * 0xc2b2ae3du;
    hash ^= hash >> 16;
    hash *= 0x7feb352du;
    hash ^= hash >> 15;
    if ((hash & 8191u) == 0) return Item_REDSTONE_ORE;
    if ((hash & 2047u) == 1) return Item_LAPIS_LAZULI_ORE;
    return Item_STONE;
}

void generateBaseTerrain(int dx, int dz, int x, int z, int start_h, int h, int flag, world_func func, void *arg) {
    for(int y = start_h; y < h; y++) {
        /* Past four octaves, the remaining cave weights sum to less than 0.000007. */
        if ((y < 4 || y > h - 2) || (simplex3(x * 0.005, y * 0.005, z * 0.02, 4, 0.05, 5)
            + simplex3(x * 0.02, y * 0.005, z * 0.005, 4, 0.05, 5) < 1.25)) {
            func(x, y, z, deep_stone(x, y, z) * flag, arg);
        }
    }
}
