#ifndef _pickaxe_h_
#define _pickaxe_h_

#include <stdbool.h>

#define PICKAXE_GRID 32
#define PICKAXE_MAX_VERTICES (PICKAXE_GRID * PICKAXE_GRID * 6)
#define PICKAXE_VERTEX_COMPONENTS 5

typedef struct {
    float x, y, size, angle;
} PickaxePose;

int pickaxe_vertices(float *vertices, bool mina);
PickaxePose pickaxe_pose(int width, int height, bool mining, double elapsed);

#endif
