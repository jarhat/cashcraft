#define GLFW_INCLUDE_NONE
#include <assert.h>
#include <math.h>
#include "../NetCraft/src/joy.c"

static float axes[4];
static unsigned char buttons[16];
static int started, stopped;

const char *glfwGetJoystickName(int joy) { return "STANDARD GAMEPAD"; }
const float *glfwGetJoystickAxes(int joy, int *count) { *count = 4; return axes; }
const unsigned char *glfwGetJoystickButtons(int joy, int *count) { *count = 16; return buttons; }
GLFWjoystickfun glfwSetJoystickCallback(GLFWjoystickfun cb) { return cb; }
int glfwJoystickPresent(int joy) { return joy == GLFW_JOYSTICK_1; }
void on_scroll(GLFWwindow *window, double x, double y) {}
void on_key(GLFWwindow *window, int key, int scan, int action, int mods) {}
void mining_start(void) { started++; }
void mining_stop(void) { stopped++; }
void building_start(void) {}
void building_stop(void) {}

int main(void) {
    init_joystick_callbacks();
    assert(is_gamepad_connected());
    double x = 0, z = 0;
    axes[1] = -1;
    joystick_apply_move(&x, &z);
    assert(z < 0);
    axes[1] = 1;
    x = z = 0;
    joystick_apply_move(&x, &z);
    assert(z > 0);
    axes[1] = 0.05;
    x = z = 0;
    joystick_apply_move(&x, &z);
    assert(x == 0 && z == 0);
    axes[1] = 0;
    buttons[GAMEPAD_DPAD_UP] = 1;
    joystick_apply_move(&x, &z);
    assert(z == -1);
    bool jumping = false, crouching = false;
    joystick_apply_buttons(&jumping, &crouching);
    assert(!jumping && !crouching);
    buttons[GAMEPAD_A] = buttons[GAMEPAD_B] = 1;
    joystick_apply_buttons(&jumping, &crouching);
    assert(jumping && crouching);
    buttons[GAMEPAD_R2_TRIGGER] = 1;
    handle_gamepad_input();
    handle_gamepad_input();
    assert(started == 1);
    buttons[GAMEPAD_R2_TRIGGER] = 0;
    handle_gamepad_input();
    assert(stopped == 1);
    on_joystick_connection(GLFW_JOYSTICK_1, GLFW_DISCONNECTED);
    assert(!is_gamepad_connected() && stopped == 2);
}
