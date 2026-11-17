#include <GL/glew.h>
#include <GLFW/glfw3.h>
#include <stdbool.h>
#include "mining.h"
#include "touch.h"

bool touch_forward = false;
bool touch_jump = false;
float touch_move_x = 0;
float touch_move_z = 0;

long touch_active = 0;
long touch_clientX = 0;
long touch_clientY = 0;

#ifndef __EMSCRIPTEN__
void init_touch_callbacks(GLFWwindow *w) {}

#else
#include <emscripten.h>
#include <emscripten/html5.h>

static GLFWwindow *window = NULL;
static double touch_activated_at = 0;
static bool touch_just_activated = false;
static bool touch_moved = false;
static bool button_mining = false;

extern void set_just_clicked(void);

static EM_BOOL on_touchstart(int eventType, const EmscriptenTouchEvent *touchEvent, void *userData) {
    if (touch_active) {
        return EM_TRUE;
    }

    for (int i = 0; i < touchEvent->numTouches; i++) {
        if (touchEvent->touches[i].isChanged) {
            touch_active = touchEvent->touches[i].identifier + 1;
            touch_clientX = touchEvent->touches[i].clientX;
            touch_clientY = touchEvent->touches[i].clientY;
            break;
        }
    }
    touch_activated_at = glfwGetTime();
    touch_just_activated = true;
    touch_moved = false;
    glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_DISABLED);

    // Hold = mine
    if (!button_mining) mining_start();

    return EM_TRUE;
}

static EM_BOOL on_touchmove(int eventType, const EmscriptenTouchEvent *touchEvent, void *userData) {
    if (touch_just_activated) {
        set_just_clicked(); // ignore next movement, since two datapoints are needed to move
        touch_just_activated = false;
    }
    for (int i = 0; i < touchEvent->numTouches; i++) {
        if (touchEvent->touches[i].identifier + 1 == touch_active) {
            touch_clientX = touchEvent->touches[i].clientX;
            touch_clientY = touchEvent->touches[i].clientY;
            touch_moved = true;
            break;
        }
    }

    if (!button_mining) mining_stop();

    return EM_TRUE;
}

static EM_BOOL on_touchend(int eventType, const EmscriptenTouchEvent *touchEvent, void *userData) {
    for (int i = 0; i < touchEvent->numTouches; ++i) {
        EmscriptenTouchPoint touch = touchEvent->touches[i];
        if (touch.isChanged && touch.identifier + 1 == touch_active) {
            // Was the first touch released? If so, exit touch.
            glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
            if (!button_mining) mining_stop();
            touch_active = 0;

            double duration = glfwGetTime() - touch_activated_at;
            if (duration < 0.07 && !touch_moved) {
                // Short duration = tap = build
                // TODO: only tap if touchstart position =~ touchend position?
                on_build();
            }
        }
    }

    return EM_TRUE;
}

static EM_BOOL on_touchcancel(int eventType, const EmscriptenTouchEvent *touchEvent, void *userData) {
    touch_active = 0;
    if (!button_mining) mining_stop();
    glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
    return EM_TRUE;
}

EMSCRIPTEN_KEEPALIVE void touch_set_move(float x, float z) {
    touch_move_x = x;
    touch_move_z = z;
}

EMSCRIPTEN_KEEPALIVE void touch_set_jump(int active) {
    touch_jump = active != 0;
}

EMSCRIPTEN_KEEPALIVE void touch_set_mine(int active) {
    button_mining = active != 0;
    if (active) mining_start(); else mining_stop();
}

EMSCRIPTEN_KEEPALIVE void touch_build(void) {
    on_build();
}

void init_touch_callbacks(GLFWwindow *w) {
    window = w;
    emscripten_set_touchstart_callback("#canvas", NULL, EM_FALSE, on_touchstart);
    emscripten_set_touchmove_callback("#canvas", NULL, EM_FALSE, on_touchmove);
    emscripten_set_touchend_callback("#canvas", NULL, EM_FALSE, on_touchend);
    emscripten_set_touchcancel_callback("#canvas", NULL, EM_FALSE, on_touchcancel);
}
#endif
