#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <GLFW/glfw3.h>
#include "mining.h"
#include "item.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

static double mining_started = 0;
static double mining_swing_started = 0;
static bool has_swung = false;
static double next_swing_sound = 0;
static bool has_pickaxe = false;
static bool wallet_pickaxe = false;
static bool wallet_connected = false;
static bool holding_mine_button = false;
static bool attacking_animal = false;
static int building_progress = 0;
static bool holding_build_button = false;

static int mining_x = 0;
static int mining_y = 0;
static int mining_z = 0;
int mining_stage = 0;

int target_x = 0;
int target_y = 0;
int target_z = 0;
int target_face = 0;
int target_w = 0;

extern void on_mine(void);
extern void on_build(void);
extern void on_mining_swing(void);
extern bool on_pickaxe_attack(void);
extern int get_targeted_block(int *x, int *y, int *z, int *face);

static void update_pickaxe(void) {
    bool next = wallet_connected && wallet_pickaxe;
    if (next != has_pickaxe) {
        has_pickaxe = next;
        if (holding_mine_button) mining_started = glfwGetTime();
        mining_stage = 0;
    }
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void mining_set_pickaxe(int enabled) {
    wallet_pickaxe = enabled != 0;
    update_pickaxe();
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void mining_set_wallet_connected(int enabled) {
    wallet_connected = enabled != 0;
    update_pickaxe();
}

bool is_mining() {
    return holding_mine_button && target_w != 0 && !attacking_animal;
}

bool mining_is_swinging(void) {
    double elapsed = glfwGetTime() - mining_swing_started;
    return holding_mine_button || (has_swung && elapsed >= 0 && elapsed < .18);
}

bool mining_has_pickaxe(void) {
    return has_pickaxe;
}

double mining_swing_elapsed(void) {
    return glfwGetTime() - mining_swing_started;
}

void mining_stop() {
    holding_mine_button = false;
    attacking_animal = false;
    mining_started = 0;
    mining_stage = 0;
}

void mining_tick() {
    // Retarget block every tick
    target_w = get_targeted_block(&target_x, &target_y, &target_z, &target_face);

    if (holding_mine_button) {
        attacking_animal = on_pickaxe_attack();
        if (attacking_animal) {
            mining_started = glfwGetTime();
            mining_stage = 0;
            return;
        }
        if (target_x != mining_x || target_y != mining_y || target_z != mining_z) {
            mining_x = target_x;
            mining_y = target_y;
            mining_z = target_z;

            mining_started = glfwGetTime();
            mining_stage = 0;
            return;
        }

        if (!target_w || !isfinite(is_hardness(target_w))) {
            mining_started = glfwGetTime();
            mining_stage = 0;
            return;
        }

        double now = glfwGetTime();
        if (has_pickaxe && now >= next_swing_sound) {
            on_mining_swing();
            next_swing_sound = now + .18;
        }
        double hardness = is_hardness(target_w) * (has_pickaxe ? 0.25 : 1.0);
        double elapsed = glfwGetTime() - mining_started;

        // Block break indicator
        if (hardness <= 0) mining_stage = 9;
        else mining_stage = (int)fmin(9, floor(elapsed / hardness * 9));

        if (elapsed >= hardness) {
            mining_started = glfwGetTime();
            mining_stage = 0;
            on_mine();
            return;
        }
    }
}

void mining_start() {
    holding_mine_button = true;
    mining_started = glfwGetTime();
    mining_swing_started = mining_started;
    has_swung = true;
    next_swing_sound = mining_started;
    attacking_animal = on_pickaxe_attack();

    (void) get_targeted_block(&mining_x, &mining_y, &mining_z, &target_face);
}


void building_stop() {
    holding_build_button = false;
    building_progress = 0;
}


void building_tick() {
    if (holding_build_button) {
        if (building_progress == BLOCK_BUILD_TIME) {
            building_progress = 0;
            on_build();
        }

        building_progress++;
    }
}

void building_start() {
    holding_build_button = true;
    building_progress = 0;
    on_build();
}
