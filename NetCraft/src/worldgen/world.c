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
#include <stdlib.h>

static int phase64(int coordinate) {
    return (int)((uint32_t)coordinate & 63u);
}

int world_stream_direction(int x) {
    int phase = phase64(x);
    return phase < 36 ? 1 : phase > 36 ? -1 : 0;
}

static int stream_height(int x) {
    return -18 + abs(phase64(x) - 36) / 4;
}

int world_stream(int x, int z, int *bottom, int *top) {
    int lane = phase64(z);
    int bend = abs(phase64(x) - 36) / 4 - 5;
    int water = abs(lane - (16 + bend));
    int lava = abs(lane - (48 - bend));
    *bottom = stream_height(x);
    int upstream = x - world_stream_direction(x);
    *top = phase64(x) == 0 || phase64(x) == 63 ? *bottom : stream_height(upstream);
    if (*top < *bottom) *top = *bottom;
    int phase = phase64(x);
    int water_width = 2 + (phase >= 7 && phase <= 12);
    int lava_width = 2 + (phase >= 50 && phase <= 60) + (phase >= 53 && phase <= 57);
    return water <= water_width ? Item_WATER : lava <= lava_width ? Item_LAVA : Item_EMPTY;
}

static void generate_underworld(int x, int z, int flag, world_func func, void *arg) {
    int height, top;
    int material = world_stream(x, z, &height, &top);
    func(x, WORLD_MIN_Y, z, Item_BEDROCK * flag, arg);
    func(x, WORLD_MIN_Y + 1, z, Item_LAVA * flag, arg);
    func(x, WORLD_MIN_Y + 2, z, Item_LAVA * flag, arg);
    // Shafts off the stream banks expose the lava below the old floor.
    int vent = abs(phase64(x) - 24) <= 1 && abs(phase64(z) - 28) <= 1;
    if (!vent) func(x, DEEP_BEDROCK_Y, z, Item_BEDROCK * flag, arg);
    if (material) {
        for (int y = DEEP_BEDROCK_Y + 1; y < height; y++) {
            func(x, y, z, deep_stone(x, y, z) * flag, arg);
        }
        for (int y = height; y <= top; y++) {
            func(x, y, z, material * flag, arg);
        }
    } else {
        int bottom, unused;
        int bank = (world_stream(x, z - 1, &bottom, &unused) ||
                    world_stream(x, z + 1, &bottom, &unused)) ? height : -20;
        if (bank == -20 && simplex2(x * .05f, z * .05f, 2, .5f, 2) > .62f) {
            bank += 2;
        }
        for (int y = DEEP_BEDROCK_Y + 1; !vent && y <= bank; y++) {
            func(x, y, z, deep_stone(x, y, z) * flag, arg);
        }
    }
}

int world_spawn_x(void) {
    return WORLD_SPAWN_X;
}

static int mina_deposit(int x, int z) {
    uint32_t hash = (uint32_t)x * 0x8da6b343u ^ (uint32_t)z * 0xd8163841u;
    hash ^= hash >> 16;
    hash *= 0x7feb352du;
    hash ^= hash >> 15;
    return (hash & 31u) == 0;
}

static int terrain_height(int x, int z) {
    float f = simplex2(x * 0.003f, z * 0.003f, 4, 0.5f, 2.0f);
    float ridge = simplex2(-x * 0.00015f, -z * 0.00015f, 2, 16.0f, 2.0f)
        * simplex2(-x * 0.0015f, -z * 0.0015f, 2, 16.0f, 2.0f) * 100;
    float classic = simplex2(x * .01f, z * .01f, 4, .5f, 2.0f)
        * (16.0f + 32.0f * simplex2(-x * .01f, -z * .01f, 2, .9f, 2.0f));
    int h = f * (100.0f + ridge) + (classic - 16.0f) * .75f;
    return h < 1 ? 1 : h;
}

static const int lake_level = 43;

int world_surface(int x, int z, Biome *biome, int *water) {
    int h = terrain_height(x, z);
    *biome = biome_at_pos(x, z);
    static const int canopy[] = {7, 20, 53, 29};
    int max_h = WORLD_MAX_Y - 32 - canopy[*biome];
    float radius = fminf(hypotf((float)x - 80.0f, (float)z),
        hypotf(((float)x + 42.0f) * 1.15f, (float)z - 119.0f));
    if (radius < 60.0f) {
        // An enclosed basin, with a dry lip before blending back into the biome.
        float basin = lake_level - 11.0f + 15.0f * radius * radius / (44.0f * 44.0f);
        float blend = radius <= 44.0f ? 1.0f : (60.0f - radius) / 16.0f;
        h = (int)roundf((basin - 31.0f) * blend + h * (1.0f - blend));
    }
    if (h < 1) h = 1;
    if (h > max_h) h = max_h;
    int surface = 31 + h;
    *water = radius <= 44.0f && surface < lake_level;
    return surface;
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

            Biome biome;
            int submerged;
            int surface = world_surface(x, z, &biome, &submerged);

            generate_underworld(x, z, flag, func, arg);
            // Small openings in the bedrock connect to the natural deep caves.
            int opening = abs(phase64(x) - 16) <= 1 && abs(phase64(z) - 16) <= 1;
            if (!opening) func(x, 0, z, Item_BEDROCK * flag, arg);
            generateBaseTerrain(
                dx, dz, x, z, opening ? 4 : 1, 32, flag, func, arg
            );

            if (submerged) {
                for (int y = 32; y < surface; y++) {
                    func(x, y, z, Item_DIRT * flag, arg);
                }
                func(x, surface, z, Item_SAND * flag, arg);
                for (int y = surface + 1; y <= lake_level; y++) {
                    func(x, y, z, Item_WATER * flag, arg);
                }
            } else if (biome == Biome_TEMPERATE) {
                generateTemperate(
                    dx, dz, x, z, 32, surface + 1, flag, func, arg
                );
            } else if (biome == Biome_DESERT) {
                generateDesert(
                    dx, dz, x, z, 32, surface + 1, flag, func, arg
                );
            } else if (biome == Biome_RAINFOREST) {
                generateRainforest(
                    dx, dz, x, z, 32, surface + 1, flag, func, arg
                );
            } else if (biome == Biome_TAIGA) {
                generateTaiga(
                    dx, dz, x, z, 32, surface + 1, flag, func, arg
                );
            }

            if (!submerged && (x != WORLD_SPAWN_X || z != 0) && mina_deposit(x, z)) {
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

Biome biome_at_pos(int x, int z) {
    /*
     * Use floating-point division so BIOME_SIZE values greater than 1
     * don't make (1 / BIOME_SIZE) evaluate to zero.
     */
    float biome_scale = 0.0005f / (float) BIOME_SIZE;

    float biomen = simplex2(-x * biome_scale, -z * biome_scale, 2, 0.35f, 2.0f);
    float spawn_distance = hypotf((float)(x - WORLD_SPAWN_X), (float)z);
    if (spawn_distance < 112.0f) {
        float influence = fminf(1.0f, (112.0f - spawn_distance) / 48.0f);
        float boundary = -65.0f + 18.0f * (simplex2(x * .025f, z * .025f, 2, .5f, 2) - .5f);
        float local = fmaxf(.55f, fminf(.9f, .75f + ((float)x - boundary) * .006f));
        biomen += (local - biomen) * influence;
    }

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
