#include <math.h>
#include "pickaxe.h"

int pickaxe_vertices(float *vertices, bool mina) {
    static const char *pixels[16] = {
        "................",
        "................",
        "....ccccccc.....",
        "...cceeeeecc....",
        "..ccddddddddcc..",
        ".ccdddaaddddcc..",
        ".cdd.aa...dddc..",
        ".cc..aaa...ddc..",
        "......aba...cc..",
        ".......aba......",
        "........aba.....",
        ".........aba....",
        "..........aba...",
        "...........aba..",
        "............aba.",
        ".............ab."
    };
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
    for (int row = 0; row < 16; row++) {
        for (int col = 0; col < 16; col++) {
            char pixel = pixels[row][col];
            if (pixel < 'a' || pixel > 'e') continue;
            for (int i = 0; i < 6; i++) {
                float *vertex = vertices + count++ * PICKAXE_VERTEX_COMPONENTS;
                vertex[0] = (col + corners[i][0]) / 16.0f;
                vertex[1] = (15 - row + corners[i][1]) / 16.0f;
                for (int j = 0; j < 3; j++) vertex[2 + j] = colors[mina ? 1 : 0][pixel - 'a'][j];
            }
        }
    }
    return count;
}

PickaxePose pickaxe_pose(int width, int height, float scale, bool mining, double elapsed) {
    float size = fminf(150 * scale, fmaxf(80 * scale, fminf(width, height) * .18f));
    size = fminf(size, fminf(width, height) * .4f);
    PickaxePose pose = {width - size - 24 * scale, 24 * scale, size, 0};
    if (mining) {
        double phase = fmod(elapsed, .36) * (2.0 * 3.141592653589793 / .36);
        float progress = (float)((1.0 - cos(phase)) * .5);
        float arc = (float)sin(phase);
        float target_x = width * .5f - size * .1f;
        float target_y = height * .5f - size * .7f;
        pose.x += (target_x - pose.x) * progress + size * .07f * arc;
        pose.y += (target_y - pose.y) * progress + size * .18f * arc;
        pose.angle = .18f * arc;
    }
    return pose;
}
