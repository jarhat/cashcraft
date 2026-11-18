#include "../config.h"
#include "../item.h"
#include "noise.h"
#include "world.h"
#include "base_terrain.h"
#include "biome_temperate.h"
#include "biome_desert.h"
#include "biome_rainforest.h"
#include "biome_taiga.h"
#include <math.h>
#include <stdint.h>

static int mina_deposit(int x, int z) {
    uint32_t hash = (uint32_t)x * 0x8da6b343u ^ (uint32_t)z * 0xd8163841u;
    hash ^= hash >> 16;
    hash *= 0x7feb352du;
    hash ^= hash >> 15;
    return (hash & 31u) == 0;
}

void create_world(int p, int q, world_func func, void *arg) {
    int pad = 1;

    for (int dx = -pad; dx < CHUNK_SIZE + pad; dx++) {
        for (int dz = -pad; dz < CHUNK_SIZE + pad; dz++) {
            int flag = 1;
            if (dx < 0 || dz < 0 ||
                dx >= CHUNK_SIZE || dz >= CHUNK_SIZE) {
                flag = -1;
            }

            int x = p * CHUNK_SIZE + dx;
            int z = q * CHUNK_SIZE + dz;

            /* Lower frequencies make terrain features broader. */
            float f = simplex2(
                x * 0.003f, z * 0.003f,
                4, 0.5f, 2.0f
            );
            float g = simplex2(
                -x * 0.003f, -z * 0.003f,
                2, 0.9f, 2.0f
            );

            int mh = g * simplex2(
                -x * 0.0003f, -z * 0.0003f,
                2, 16.0f, 2.0f
            );

            mh += simplex2(
                -x * 0.00015f, -z * 0.00015f,
                2, 16.0f, 2.0f
            ) * simplex2(
                -x * 0.0015f, -z * 0.0015f,
                2, 16.0f, 2.0f
            ) * 100;

            mh += 100;
            int h = f * mh;

            generateBaseTerrain(
                dx, dz, x, z, 0, 32, flag, func, arg
            );

            Biome biome = biome_at_pos(q, x, z);

            if (biome == Biome_TEMPERATE) {
                generateTemperate(
                    dx, dz, x, z, 32, 32 + h, flag, func, arg
                );
            } else if (biome == Biome_DESERT) {
                generateDesert(
                    dx, dz, x, z, 32, 32 + h, flag, func, arg
                );
            } else if (biome == Biome_RAINFOREST) {
                generateRainforest(
                    dx, dz, x, z, 32, 32 + h, flag, func, arg
                );
            } else if (biome == Biome_TAIGA) {
                generateTaiga(
                    dx, dz, x, z, 32, 32 + h, flag, func, arg
                );
            }

            int surface = 31 + h;
            if (surface >= 32 && surface < 256 && mina_deposit(x, z)) {
                func(x, surface, z, Item_MINA_ORE * flag, arg);
            }

            /* Clouds */
            for (int y = 128; y < 132; y++) {
                if (simplex3(
                    x * 0.01f, y * 0.1f, z * 0.01f,
                    8, 0.5f, 2.0f
                ) > 0.75f) {
                    func(x, y, z, 16 * flag, arg);
                }
            }
        }
    }
}

Biome biome_at_pos(int q, int x, int z) {
    /*
     * Use floating-point division so BIOME_SIZE values greater than 1
     * don't make (1 / BIOME_SIZE) evaluate to zero.
     */
    float biome_scale = 0.0005f / (float) BIOME_SIZE;

    float biomen = simplex3(
        -x * biome_scale,
        -z * biome_scale,
        q * 0.001f,
        2, 16.0f, 1.0f
    );

    Biome biome = Biome_max;

    if (biomen > (1.0f / 4.0f)) {
        biome = Biome_TEMPERATE;
    }
    if (biomen > (2.0f / 4.0f)) {
        biome = Biome_DESERT;
    }
    if (biomen > (3.0f / 4.0f)) {
        biome = Biome_RAINFOREST;
    }
    if (biome == Biome_max) {
        biome = Biome_TAIGA;
    }

    return biome;
}
