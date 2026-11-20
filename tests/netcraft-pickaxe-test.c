#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include "../NetCraft/src/pickaxe.h"

static bool near(float a, float b) {
    return fabsf(a - b) < .01f;
}

static const float *pixel_at(float *vertices, int count, int x, int y) {
    for (int i = 0; i < count; i += 6) {
        float *vertex = vertices + i * PICKAXE_VERTEX_COMPONENTS;
        if (near(vertex[0], x / 16.0f) && near(vertex[1], (15 - y) / 16.0f)) {
            return vertex;
        }
    }
    return NULL;
}

int main(void) {
    float standard[PICKAXE_MAX_VERTICES * PICKAXE_VERTEX_COMPONENTS];
    float mina[PICKAXE_MAX_VERTICES * PICKAXE_VERTEX_COMPONENTS];
    int count = pickaxe_vertices(standard, false);
    assert(count > 0 && count <= PICKAXE_MAX_VERTICES && count % 6 == 0);
    assert(pickaxe_vertices(mina, true) == count);
    bool different_color = false;
    for (int i = 0; i < count; i++) {
        int v = i * PICKAXE_VERTEX_COMPONENTS;
        assert(standard[v] >= 0 && standard[v] <= 1);
        assert(standard[v + 1] >= 0 && standard[v + 1] <= 1);
        assert(standard[v] == mina[v] && standard[v + 1] == mina[v + 1]);
        for (int c = 2; c < PICKAXE_VERTEX_COMPONENTS; c++) {
            assert(standard[v + c] >= 0 && standard[v + c] <= 1);
            assert(mina[v + c] >= 0 && mina[v + c] <= 1);
            if (standard[v + c] != mina[v + c]) different_color = true;
        }
    }
    assert(different_color);
    const float *head = pixel_at(standard, count, 6, 2);
    const float *blade = pixel_at(standard, count, 3, 10);
    const float *handle = pixel_at(standard, count, 13, 12);
    assert(head && blade && handle);
    assert(head[3] > head[2] && head[4] > head[2]);
    assert(blade[3] > blade[2] && blade[4] > blade[2]);
    assert(handle[2] > handle[3] && handle[3] > handle[4]);
    assert(!pixel_at(standard, count, 9, 10));
    for (int i = 0; i < count; i += 3) {
        int a = i * PICKAXE_VERTEX_COMPONENTS;
        int b = a + PICKAXE_VERTEX_COMPONENTS;
        int c = b + PICKAXE_VERTEX_COMPONENTS;
        assert((standard[b] - standard[a]) * (standard[c + 1] - standard[a + 1]) -
               (standard[b + 1] - standard[a + 1]) * (standard[c] - standard[a]) > 0);
    }

    for (int i = 0; i < 2; i++) {
        int width = i ? 390 : 1280;
        int height = i ? 844 : 720;
        PickaxePose rest = pickaxe_pose(width, height, false, 1);
        PickaxePose start = pickaxe_pose(width, height, true, 0);
        PickaxePose forward = pickaxe_pose(width, height, true, .045);
        PickaxePose back = pickaxe_pose(width, height, true, .135);
        PickaxePose returned = pickaxe_pose(width, height, true, .18);
        assert(near(rest.size, fminf(width * .4f, height * .65f)));
        assert(near(rest.x, width - rest.size));
        assert(near(rest.y, height * .06f));
        assert(near(rest.x, start.x) && near(rest.y, start.y));
        assert(near(returned.x, rest.x) && near(returned.y, rest.y));
        assert(near(forward.x, rest.x) && near(back.x, rest.x));
        assert(near(forward.y, rest.y) && near(back.y, rest.y));
        assert(near(forward.angle, .08f) && near(back.angle, -.08f));
        assert(near(returned.angle, 0));
    }
    return 0;
}
