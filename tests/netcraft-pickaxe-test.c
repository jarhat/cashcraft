#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include "../NetCraft/src/pickaxe.h"

static bool near(float a, float b) {
    return fabsf(a - b) < .01f;
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
        PickaxePose rest = pickaxe_pose(width, height, 1, false, 1);
        PickaxePose start = pickaxe_pose(width, height, 1, true, 0);
        PickaxePose strike = pickaxe_pose(width, height, 1, true, .18);
        PickaxePose forward = pickaxe_pose(width, height, 1, true, .09);
        PickaxePose back = pickaxe_pose(width, height, 1, true, .27);
        PickaxePose returned = pickaxe_pose(width, height, 1, true, .36);
        assert(near(rest.x, start.x) && near(rest.y, start.y));
        assert(near(returned.x, rest.x) && near(returned.y, rest.y));
        assert(near(strike.x + strike.size * .1f, width * .5f));
        assert(near(strike.y + strike.size * .7f, height * .5f));
        assert(near(forward.x + back.x, rest.x + strike.x));
        assert(forward.y > back.y && forward.angle > 0 && back.angle < 0);
    }
    return 0;
}
