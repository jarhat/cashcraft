#include <math.h>
#include "pickaxe.h"

int pickaxe_vertices(float *vertices, bool mina) {
    static const float colors[2][6][3] = {
        {{.20f, .16f, .12f}, {.55f, .40f, .24f}, {.12f, .25f, .23f},
         {.22f, .72f, .65f}, {.25f, .96f, .87f}, {.69f, .50f, .28f}},
        {{.20f, .16f, .12f}, {.55f, .40f, .24f}, {.08f, .23f, .17f},
         {.19f, .65f, .40f}, {.48f, .96f, .67f}, {.69f, .50f, .28f}}
    };
    static const float corners[6][2] = {
        {0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}
    };
    int count = 0;
    for (int row = 0; row < 16; row++) {
        int y = 15 - row;
        for (int col = 0; col < 16; col++) {
            int pixel = -1;
            if (y >= 2 && y <= 13 && col >= y && col <= y + 2) {
                pixel = col == y ? 0 : (col == y + 1 ? 1 : 5);
            }
            if ((y == 1 && col >= 4 && col <= 11) ||
                (y >= 2 && y <= 3 && col >= 3 && col <= 13) ||
                (y == 4 && col >= 2 && col <= 11) ||
                (y == 5 && col >= 2 && col <= 7) ||
                (y >= 6 && y <= 11 && col >= 1 && col <= 4) ||
                (y == 12 && col >= 2 && col <= 3)) {
                pixel = 2;
                if ((y == 2 && col >= 4 && col <= 12) ||
                    (y == 3 && col >= 4 && col <= 7) ||
                    (y == 4 && col >= 3 && col <= 6) ||
                    (y == 5 && col >= 3 && col <= 5) ||
                    (y >= 6 && y <= 11 && col == 3)) pixel = 3;
                if ((y == 2 && col == 12) || (y == 11 && col == 3)) pixel = 4;
            }
            if (pixel < 0) continue;
            for (int i = 0; i < 6; i++) {
                float *vertex = vertices + count++ * PICKAXE_VERTEX_COMPONENTS;
                vertex[0] = (col + corners[i][0]) / 16.0f;
                vertex[1] = (row + corners[i][1]) / 16.0f;
                for (int j = 0; j < 3; j++) vertex[2 + j] = colors[mina ? 1 : 0][pixel][j];
            }
        }
    }
    return count;
}

PickaxePose pickaxe_pose(int width, int height, bool mining, double elapsed) {
    float size = fminf(width * .4f, height * .65f);
    PickaxePose pose = {width - size, height * .06f, size, 0};
    if (mining) {
        double phase = fmod(elapsed, .18) * (2.0 * 3.141592653589793 / .18);
        pose.angle = .08f * (float)sin(phase);
    }
    return pose;
}
