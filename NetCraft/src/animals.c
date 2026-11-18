#include <GL/glew.h>
#include <GLFW/glfw3.h>
#include <math.h>
#include <stdbool.h>
#include <string.h>
#include "animals.h"
#include "config.h"
#include "cube.h"
#include "matrix.h"
#include "rendering.h"
#include "util.h"

#define MAX_ANIMALS 8
#define ANIMAL_PARTS 8

typedef struct {
    unsigned int id;
    float from[3];
    float to[3];
    double updated;
    int heading;
} Animal;

static Animal animals[MAX_ANIMALS];
static int animal_count;
static GLuint animal_buffer;

static void animal_position(const Animal *animal, double now, float *position) {
    float t = (float)(now - animal->updated);
    t = fmaxf(0, fminf(1, t));
    for (int i = 0; i < 3; ++i) {
        position[i] = animal->from[i] + (animal->to[i] - animal->from[i]) * t;
    }
}

void animals_update(unsigned int id, float x, float y, float z, int heading) {
    if (!id || !isfinite(x) || !isfinite(y) || !isfinite(z) ||
        heading < 0 || heading > 3) return;
    int i;
    for (i = 0; i < animal_count && animals[i].id != id; ++i) {}
    double now = glfwGetTime();
    if (i == animal_count) {
        if (animal_count == MAX_ANIMALS) return;
        ++animal_count;
        animals[i] = (Animal){.id = id, .from = {x, y, z}, .to = {x, y, z}};
    } else {
        animal_position(&animals[i], now, animals[i].from);
    }
    animals[i].to[0] = x; animals[i].to[1] = y; animals[i].to[2] = z;
    animals[i].heading = heading;
    animals[i].updated = now;
}

void animals_remove(unsigned int id) {
    for (int i = 0; i < animal_count; ++i) {
        if (animals[i].id == id) {
            animals[i] = animals[--animal_count];
            return;
        }
    }
}

void animals_clear(void) {
    animal_count = 0;
}

void animals_shutdown(void) {
    animals_clear();
    del_buffer(animal_buffer);
    animal_buffer = 0;
}

static void animal_part(float *data, float x, float y, float z,
                        float sx, float sy, float sz, int block) {
    float ao[6][4] = {{0}};
    float light[6][4] = {{0}};
    make_cube(data, ao, light, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0.5, block);
    for (int i = 0; i < 36; ++i) {
        data[i * 10] = data[i * 10] * sx + x;
        data[i * 10 + 1] = data[i * 10 + 1] * sy + y;
        data[i * 10 + 2] = data[i * 10 + 2] * sz + z;
    }
}

static GLuint make_animal_buffer(void) {
    GLfloat *data = malloc_faces(10, ANIMAL_PARTS * 6);
    animal_part(data, 0, .65f, 0, .8f, .65f, 1.1f, 9);
    animal_part(data + 360, 0, .85f, -.7f, .6f, .6f, .55f, 5);
    for (int i = 0; i < 4; ++i) {
        animal_part(data + (2 + i) * 360, (i & 1) ? .27f : -.27f,
            .2f, (i & 2) ? .38f : -.38f, .2f, .4f, .2f, 5);
    }
    animal_part(data + 6 * 360, -.14f, .9f, -.98f, .08f, .08f, .03f, 13);
    animal_part(data + 7 * 360, .14f, .9f, -.98f, .08f, .08f, .03f, 13);
    return gen_faces(10, ANIMAL_PARTS * 6, data);
}

void animals_render(Attrib *attrib, float *view, float x, float y, float z, int radius) {
    if (!animal_count) return;
    if (!animal_buffer) animal_buffer = make_animal_buffer();
    double now = glfwGetTime();
    for (int i = 0; i < animal_count; ++i) {
        float pos[3];
        animal_position(&animals[i], now, pos);
        float dx = x - pos[0], dy = y - pos[1], dz = z - pos[2];
        float distance = radius * CHUNK_SIZE;
        if (dx * dx + dz * dz > distance * distance) continue;
        float angle = animals[i].heading * 1.57079632679f;
        float rotation[16], translation[16], model[16], matrix[16];
        mat_rotate(rotation, 0, 1, 0, angle);
        mat_translate(translation, pos[0], pos[1], pos[2]);
        mat_multiply(model, translation, rotation);
        mat_multiply(matrix, view, model);
        glUniformMatrix4fv(attrib->matrix, 1, GL_FALSE, matrix);
        glUniform3f(attrib->camera, cosf(angle) * dx + sinf(angle) * dz,
            dy, -sinf(angle) * dx + cosf(angle) * dz);
        draw_triangles_3d_ao(attrib, animal_buffer, ANIMAL_PARTS * 36);
    }
}
