#include <assert.h>
#include <math.h>
#include <GL/glew.h>
#include "../NetCraft/src/animals.h"

static double now;
double glfwGetTime(void) { return now; }

int main(void) {
    float distance;
    animals_update(1, 0, 0, -3, 0, "aaaaaa...aaaaaa", false, 0, 3);
    animals_update(2, 0, 0, -2, 0, "bbbbbb...bbbbbb", true, 0, 0);
    assert(animals_target(0, 1.7f, 0, 0, 0, -1, &distance) == 1);
    assert(fabsf(distance - 2.5f) < .04f);
    assert(!animals_target(0, 3, 0, 0, 0, -1, &distance));
    assert(!animals_target(1, 1.7f, 0, 0, 0, -1, &distance));
    animals_update(1, 0, 0, -3, 0, "aaaaaa...aaaaaa", true, 0, 0);
    assert(!animals_target(0, 1.7f, 0, 0, 0, -1, &distance));
    animals_update(1, 0, 0, -6, 0, "aaaaaa...aaaaaa", false, 0, 2);
    now = 1;
    assert(!animals_target(0, 1.7f, 0, 0, 0, -1, &distance));
    animals_clear();
    return 0;
}
