#include "base_terrain.h"
#include "noise.h"
#include "../config.h"
#include "../item.h"
#include <stdint.h>

/* Redstone is rare (about 1 in 8192 deep stone blocks); the bottom 16 layers
 * (bedrock band and deep stone) are the only place it spawns. */
#define REDSTONE_MAX_Y 16

static int deep_redstone(int x, int y, int z) {
    uint32_t hash = (uint32_t)x * 0x9e3779b1u ^ (uint32_t)y * 0x85ebca77u ^ (uint32_t)z * 0xc2b2ae3du;
    hash ^= hash >> 16;
    hash *= 0x7feb352du;
    hash ^= hash >> 15;
    return (hash & 8191u) == 0;
}

void generateBaseTerrain(int dx, int dz, int x, int z, int start_h, int h, int flag, world_func func, void *arg) {
    for(int y = start_h; y < h; y++) {
        /* Past four octaves, the remaining cave weights sum to less than 0.000007. */
        if ((y < 4 || y > h - 2) || (simplex3(x * 0.005, y * 0.005, z * 0.02, 4, 0.05, 5)
            + simplex3(x * 0.02, y * 0.005, z * 0.005, 4, 0.05, 5) < 1.25)) {
            int block = Item_STONE;
            if (y < REDSTONE_MAX_Y && deep_redstone(x, y, z)) {
                block = Item_REDSTONE_ORE;
            }
            func(x, y, z, block, arg);
        }
    }
}
