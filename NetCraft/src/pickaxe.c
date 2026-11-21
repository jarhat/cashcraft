#include <math.h>
#include <stdlib.h>
#include "pickaxe.h"

static int tool_vertices(float *vertices, bool mina, bool axe) {
    static const float colors[2][6][3] = {
        {{.20f, .16f, .12f}, {.55f, .40f, .24f}, {.20f, .22f, .24f},
         {.61f, .66f, .68f}, {.88f, .91f, .92f}, {.69f, .50f, .28f}},
        {{.20f, .16f, .12f}, {.55f, .40f, .24f}, {.08f, .23f, .17f},
         {.19f, .65f, .40f}, {.48f, .96f, .67f}, {.69f, .50f, .28f}}
    };
    static const float corners[6][2] = {
        {0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}
    };
    int count = 0;
    for (int row = 0; row < PICKAXE_GRID; row++) {
        for (int col = 0; col < PICKAXE_GRID; col++) {
            // Work along and across the shaft so both sides of the head match.
            int along = col - row;
            float across = abs(col + row - (PICKAXE_GRID - 1));
            int pixel = -1;
            if (along >= -15 && along <= 21 && across <= (along >= 20 ? 2 : 3)) {
                pixel = across >= 3 || along == 21 ? 0 : across <= 1 ? 5 : 1;
            }
            float blade = along - (-15.0f + .047f * across * across);
            float thickness = 4.0f - .16f * across;
            int side = col + row - (PICKAXE_GRID - 1);
            if (axe && side >= -2 && side <= 13 && along >= -19 + abs(side - 6) / 3 &&
                along <= -7 - abs(side - 6) / 2) {
                pixel = side >= 12 || along <= -17 ? 2 : along <= -14 ? 4 : 3;
            } else if (!axe && across <= 16 && fabsf(blade) <= thickness) {
                pixel = across >= 15 || fabsf(blade) > thickness - 1.3f ? 2
                    : blade < -.6f ? 4 : 3;
            }
            if (pixel < 0) continue;
            for (int i = 0; i < 6; i++) {
                float *vertex = vertices + count++ * PICKAXE_VERTEX_COMPONENTS;
                vertex[0] = (col + corners[i][0]) / PICKAXE_GRID;
                vertex[1] = (row + corners[i][1]) / PICKAXE_GRID;
                for (int j = 0; j < 3; j++) vertex[2 + j] = colors[mina ? 1 : 0][pixel][j];
            }
        }
    }
    return count;
}

int pickaxe_vertices(float *vertices, bool mina) {
    return tool_vertices(vertices, mina, false);
}

int admin_axe_vertices(float *vertices) {
    return tool_vertices(vertices, true, true);
}

PickaxePose pickaxe_pose(int width, int height, bool mining, double elapsed) {
    float size = fminf(width * .4f, height * .65f);
    PickaxePose pose = {width - size + size * (2.0f / 16.0f), height * .06f, size, 0};
    if (mining) {
        double phase = fmod(elapsed, .18) * (2.0 * 3.141592653589793 / .18);
        pose.angle = .08f * (float)sin(phase);
    }
    return pose;
}
