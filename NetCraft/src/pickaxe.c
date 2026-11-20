#include <math.h>
#include "pickaxe.h"

int pickaxe_vertices(float *vertices, bool mina) {
    static const int left[10] = {8, 8, 9, 10, 11, 12, 14, 16, 18, 20};
    static const int right[10] = {31, 31, 31, 31, 30, 30, 29, 28, 27, 25};
    static const float colors[2][5][3] = {
        {{.25f, .14f, .08f}, {.58f, .36f, .18f}, {.25f, .29f, .31f},
         {.62f, .68f, .69f}, {.88f, .92f, .90f}},
        {{.09f, .24f, .17f}, {.19f, .53f, .35f}, {.15f, .55f, .35f},
         {.26f, .93f, .58f}, {.73f, 1.0f, .85f}}
    };
    static const float corners[6][2] = {
        {0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}
    };
    int count = 0;
    for (int row = 0; row < 32; row++) {
        for (int col = 0; col < 32; col++) {
            int pixel = -1;
            int diagonal = col - row;
            if (row <= 23 && diagonal >= -1 && diagonal <= 2) {
                pixel = diagonal == -1 || diagonal == 2 ? 0 : 1;
                if (row % 7 == 0) pixel = 0;
            }
            if (row >= 20 && row < 30) {
                int i = row - 20;
                if (col >= left[i] && col <= right[i]) {
                    if (i < 3 && col > left[i] + i + 1 && col < right[i] - i - 1 &&
                        (col < 19 || col > 25)) continue;
                    pixel = col == left[i] || col == right[i] || i == 9 ? 2 :
                        (i >= 7 || (i == 6 && col % 3 != 0) ? 4 : 3);
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
    PickaxePose pose = {0, 0, size, 0};
    if (mining) {
        double phase = fmod(elapsed, .18) * (2.0 * 3.141592653589793 / .18);
        pose.angle = .08f * (float)sin(phase);
    }
    return pose;
}
