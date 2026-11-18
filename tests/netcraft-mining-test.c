#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include "../NetCraft/src/mining.h"

static double now;
static int target = 1;
static int target_x_value;
static int mined;

double glfwGetTime(void) { return now; }
float is_hardness(int block) { return block == 2 ? INFINITY : 2.0f; }
int get_targeted_block(int *x, int *y, int *z, int *face) {
    *x = target_x_value;
    *y = *z = *face = 0;
    return target;
}
void on_mine(void) { mined++; }
void on_build(void) {}

static void check_rate(double step) {
    now = 0;
    mined = 0;
    target = 1;
    target_x_value = 0;
    mining_start();
    while (now < 1.9) {
        mining_tick();
        assert(mined == 0);
        now += step;
    }
    now = 2.01;
    mining_tick();
    assert(mined == 1);
    mining_stop();
}

int main(void) {
    check_rate(1.0 / 20);
    check_rate(1.0 / 120);
    now = 10;
    mined = 0;
    mining_start();
    now = 11.9;
    target_x_value = 1;
    mining_tick();
    now = 12.1;
    mining_tick();
    assert(mined == 0);
    now = 14;
    mining_tick();
    assert(mined == 1);
    target = 2;
    now = 100;
    mining_tick();
    assert(mined == 1);
    mining_stop();
    return 0;
}
