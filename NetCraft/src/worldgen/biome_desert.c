#include "biome_desert.h"
#include "noise.h"
#include "../config.h"
#include "../item.h"
#include <stdint.h>

static int palm_hash(int x, int z) {
    uint32_t hash = (uint32_t)x * 0x8da6b343u ^ (uint32_t)z * 0xd8163841u;
    hash ^= hash >> 16;
    hash *= 0x7feb352du;
    hash ^= hash >> 15;
    return (int)(hash & 0x7fffffffu);
}

void generateDesert(int dx, int dz, int x, int z, int start_h, int h, int flag, world_func func, void *arg) {
    for (int y = start_h; y < h; y++) {
        func(x, y, z, 2 * flag, arg);
    }

    int hash = palm_hash(x, z);
    int palm = dx >= 5 && dz >= 5 && dx + 5 < CHUNK_SIZE && dz + 5 < CHUNK_SIZE
        && hash % 211 == 0;
    if (palm) {
        int height = 13 + hash % 5;
        int top = h + height;
        for (int y = h; y < top; y++) {
            func(x, y, z, Item_WOOD, arg);
        }
        func(x, top, z, Item_LEAVES, arg);
        for (int ox = -1; ox <= 1; ox++) {
            for (int oz = -1; oz <= 1; oz++) {
                if (!ox && !oz) continue;
                for (int length = 1; length <= 5; length++) {
                    int y = top - (length >= 4 ? length - 3 : 0);
                    func(x + ox * length, y, z + oz * length, Item_LEAVES, arg);
                    if (length >= 2 && length <= 3 && (!ox || !oz)) {
                        func(x + ox * length + oz, y, z + oz * length + ox, Item_LEAVES, arg);
                        func(x + ox * length - oz, y, z + oz * length - ox, Item_LEAVES, arg);
                    }
                }
            }
        }
        return;
    }

    if (simplex2(-x * 0.1, z * 0.1, 4, 0.8, 2) > 0.8) {
        func(x, h, z, 18 * flag, arg);
    }

    int ok = 1;
    if (dx - 4 < 0 || dz - 4 < 0 ||
        dx + 4 >= CHUNK_SIZE || dz + 4 >= CHUNK_SIZE)
    {
        ok = 0;
    }
    if (ok && simplex2(x * 4, z * 4, 6, 0.45, 2) > 0.88) {
        int height = simplex2(x, z, 6, 0.5, 2) * 16;
        for (int y = h; y < h + height; y++) {
            func(x, y, z, Item_CACTUS, arg);
        }

        int oz = z % 3;

        if(x % 2) {
            func(x + 1, h + height - 4 - oz, z, Item_CACTUS, arg);
            func(x - 1, h + height - 4 + oz, z, Item_CACTUS, arg);

            func(x + 2, h + height - 4 - oz, z, Item_CACTUS, arg);
            func(x - 2, h + height - 4 + oz, z, Item_CACTUS, arg);

            func(x + 2, h + height - 3 - oz, z, Item_CACTUS, arg);
            func(x - 2, h + height - 3 + oz, z, Item_CACTUS, arg);
        } else {
            func(x, h + height - 4 - oz, z + 1, Item_CACTUS, arg);
            func(x, h + height - 4 + oz, z - 1, Item_CACTUS, arg);

            func(x, h + height - 4 - oz, z + 2, Item_CACTUS, arg);
            func(x, h + height - 4 + oz, z - 2, Item_CACTUS, arg);

            func(x, h + height - 3 - oz, z + 2, Item_CACTUS, arg);
            func(x, h + height - 3 + oz, z - 2, Item_CACTUS, arg);
        }
    }
}
