#ifndef _world_h_
#define _world_h_

#define WORLD_MIN_Y (-24)
#define WORLD_MAX_Y 255

typedef enum {
    Biome_TEMPERATE,
    Biome_DESERT,
    Biome_RAINFOREST,
    Biome_TAIGA,
    Biome_max
} Biome;

typedef void (*world_func)(int, int, int, int, void *);

void create_world(int p, int q, world_func func, void *arg);
int world_stream(int x, int z, int *bottom, int *top);
int world_stream_direction(int x);
Biome biome_at_pos(int x, int z);

#endif // _world_h_
