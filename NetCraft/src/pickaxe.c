#include <math.h>
#include "pickaxe.h"

int pickaxe_vertices(float *vertices, bool mina) {
    static const float colors[2][6][3] = {
        {{.20f, .11f, .06f}, {.58f, .34f, .16f}, {.20f, .22f, .24f},
         {.61f, .66f, .68f}, {.88f, .91f, .92f}, {.78f, .50f, .26f}},
        {{.09f, .24f, .17f}, {.19f, .53f, .35f}, {.15f, .55f, .35f},
         {.26f, .93f, .58f}, {.73f, 1.0f, .85f}, {.45f, .29f, .16f}}
    };
    static const int head_left[11] = {8, 5, 3, 2, 2, 3, 4, 6, 8, 11, 14};
    static const int head_right[11] = {24, 27, 29, 30, 30, 29, 28, 26, 24, 21, 18};
    static const int arch_left[11] = {11, 9, 7, 6, 6, 7, 8, 10, 12, 14, 16};
    static const int arch_right[11] = {21, 23, 25, 26, 26, 25, 24, 22, 20, 18, 16};
    static const float corners[6][2] = {
        {0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}
    };
    int count = 0;
    for (int row = 0; row < 32; row++) {
        for (int col = 0; col < 32; col++) {
            int pixel = -1;
            int source_col = 31 - col;
            int shaft = source_col - row;
            if (row <= 23 && shaft >= 4 && shaft <= 7) {
                pixel = shaft == 4 || shaft == 7 ? 0 : (shaft == 5 ? 1 : 5);
            }
            if (row >= 19 && row <= 29) {
                int i = row - 19;
                bool in_head = source_col >= head_left[i] && source_col <= head_right[i];
                bool in_arch = source_col > arch_left[i] && source_col < arch_right[i];
                if (in_head && !in_arch) {
                    pixel = source_col == head_left[i] || source_col == head_right[i] ||
                        source_col == arch_left[i] + 1 || source_col == arch_right[i] - 1
                        ? 2 : (row >= 26 ? 4 : 3);
                }
            }
            if (pixel < 0) continue;
            for (int i = 0; i < 6; i++) {
                float *vertex = vertices + count++ * PICKAXE_VERTEX_COMPONENTS;
                vertex[0] = (col + corners[i][0]) / 32.0f;
                vertex[1] = (row + corners[i][1]) / 32.0f;
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
