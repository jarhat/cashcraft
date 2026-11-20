#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include "../NetCraft/src/mining.h"

static double now;
static int target = 1;
static int target_x_value;
static int mined;
static int swings;
static int builds;

double glfwGetTime(void) { return now; }
float is_hardness(int block) { return block == 2 ? INFINITY : 2.0f; }
int get_targeted_block(int *x, int *y, int *z, int *face) {
    *x = target_x_value;
    *y = *z = *face = 0;
    return target;
}
void on_mine(void) { mined++; }
void on_build(void) { builds++; }
void on_mining_swing(void) { swings++; }

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
    building_start();
    assert(builds == 1);
    for (int i = 0; i < BLOCK_BUILD_TIME; i++) building_tick();
    assert(builds == 1);
    building_tick();
    assert(builds == 2);
    building_stop();
    for (int i = 0; i < BLOCK_BUILD_TIME * 2; i++) building_tick();
    assert(builds == 2);
    check_rate(1.0 / 20);
    check_rate(1.0 / 120);
    now = 5;
    target = 0;
    mining_start();
    mining_tick();
    assert(!is_mining());
    target = 1;
    mining_tick();
    assert(is_mining());
    target = 0;
    mining_tick();
    assert(!is_mining());
    mining_stop();
    assert(!is_mining());
    target = 1;
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
    target_x_value = 2;
    now = 14.1;
    mining_tick();
    now = 16.2;
    mining_tick();
    assert(mined == 2);
    target = 2;
    now = 100;
    mining_tick();
    assert(mined == 2);
    mining_stop();

    target = 1;
    target_x_value = 0;
    now = 200;
    mining_set_wallet_connected(1);
    mining_set_pickaxe(1);
    assert(mining_has_pickaxe());
    mining_start();
    now = 200.2;
    assert(fabs(mining_swing_elapsed() - .2) < .0001);
    mining_tick();
    assert(mined == 2);
    assert(swings == 1);
    now = 200.3;
    mining_tick();
    assert(swings == 1);
    now = 200.5;
    mining_tick();
    assert(mined == 3);
    assert(swings == 2);
    mining_set_pickaxe(0);
    assert(!mining_has_pickaxe());
    now = 201.51;
    mining_tick();
    assert(mined == 3);
    now = 202.51;
    mining_tick();
    assert(mined == 4);
    target = 2;
    mining_set_pickaxe(1);
    now = 300;
    mining_tick();
    assert(mined == 4);
    mining_stop();
    mining_set_pickaxe(0);
    mining_set_wallet_connected(0);
    mining_set_guest_pickaxe(1);
    assert(!mining_has_pickaxe());
    mining_set_wallet_connected(1);
    assert(mining_has_pickaxe());
    mining_set_pickaxe(1);
    mining_set_guest_pickaxe(0);
    assert(mining_has_pickaxe());
    mining_set_pickaxe(0);
    assert(!mining_has_pickaxe());
    return 0;
}
