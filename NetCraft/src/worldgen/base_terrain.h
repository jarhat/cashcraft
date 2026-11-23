#ifndef _base_terrain_h_
#define _base_terrain_h_

#include "world.h"

void generateBaseTerrain(int dx, int dz, int x, int z, int start_h, int h, int flag, world_func func, void *arg);
int deep_stone(int x, int y, int z);

#endif // _base_terrain_h_
