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
static bool admin_axe = false;
static bool holding_mine_button = false;
static bool attacking_animal = false;
static bool server_timed = false;
static bool waiting_for_start = false;
static bool waiting_for_edit = false;
static int building_progress = 0;
static bool holding_build_button = false;

static int mining_x = 0;
static int mining_y = 0;
static int mining_z = 0;
static int mining_w = 0;
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
extern bool on_mining_target(int x, int y, int z);
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

void mining_set_admin(bool enabled) {
    if (admin_axe == enabled) return;
    admin_axe = enabled;
    mining_stop();
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
    waiting_for_start = waiting_for_edit = false;
    mining_started = 0;
    mining_stage = 0;
}

static void start_target(void) {
    mining_started = glfwGetTime();
    next_swing_sound = mining_started;
    mining_stage = 0;
    waiting_for_edit = false;
    server_timed = mining_w && isfinite(is_hardness(mining_w)) &&
        on_mining_target(mining_x, mining_y, mining_z);
    waiting_for_start = server_timed;
}

void mining_target_confirmed(int x, int y, int z) {
    if (waiting_for_start && x == mining_x && y == mining_y && z == mining_z) {
        mining_started = glfwGetTime();
        waiting_for_start = false;
    }
}

void mining_block_updated(int x, int y, int z) {
    if (waiting_for_edit && x == mining_x && y == mining_y && z == mining_z) {
        waiting_for_edit = false;
        mining_stage = 0;
        mining_w = 0;
    }
}

void mining_tick() {
    // Retarget block every tick
    target_w = get_targeted_block(&target_x, &target_y, &target_z, &target_face);

    if (holding_mine_button) {
        if (admin_axe) return; // One instant break per press.
        bool was_attacking = attacking_animal;
        attacking_animal = on_pickaxe_attack();
        if (attacking_animal) {
            mining_started = glfwGetTime();
            mining_stage = 0;
            return;
        }
        if (was_attacking || target_w != mining_w ||
            target_x != mining_x || target_y != mining_y || target_z != mining_z) {
            mining_x = target_x;
            mining_y = target_y;
            mining_z = target_z;
            mining_w = target_w;
            start_target();
            return;
        }

        if (waiting_for_start || waiting_for_edit) return;

        if (!target_w || !isfinite(is_hardness(target_w))) {
            mining_started = glfwGetTime();
            mining_stage = 0;
            return;
        }

        double now = glfwGetTime();
        double hardness = is_hardness(target_w) * (has_pickaxe ? 0.25 : 1.0);
        double elapsed = now - mining_started;
        if (has_pickaxe && hardness > .18 && elapsed < hardness && now >= next_swing_sound) {
            on_mining_swing();
            next_swing_sound = now + .18;
        }

        // Block break indicator
        if (hardness <= 0) mining_stage = 9;
        else mining_stage = (int)fmin(9, floor(elapsed / hardness * 9));

        if (elapsed >= hardness) {
            mining_started = glfwGetTime();
            waiting_for_edit = server_timed;
            mining_stage = waiting_for_edit ? 9 : 0;
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
    waiting_for_start = waiting_for_edit = false;

    mining_w = get_targeted_block(&mining_x, &mining_y, &mining_z, &target_face);
    if (!attacking_animal && mining_w && isfinite(is_hardness(mining_w))) {
        if (admin_axe) {
            on_mining_swing();
            on_mine();
        } else {
            start_target();
        }
    }
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
