#include <GL/glew.h>
#include <GLFW/glfw3.h>
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include "animals.h"
#include "config.h"
#include "cube.h"
#include "matrix.h"
#include "rendering.h"
#include "util.h"

#define ANIMAL_PARTS 8

typedef struct {
    unsigned int id;
    float from[3];
    float to[3];
    double updated;
    int heading;
    bool pacified;
    char name[ANIMAL_NAME_LENGTH + 1];
} Animal;

static Animal *animals;
static size_t animal_count;
static size_t animal_capacity;
static GLuint animal_buffer;
static GLuint zombie_buffers[2];

static void animal_position(const Animal *animal, double now, float *position) {
    float t = (float)(now - animal->updated);
    t = fmaxf(0, fminf(1, t));
    for (int i = 0; i < 3; ++i) {
        position[i] = animal->from[i] + (animal->to[i] - animal->from[i]) * t;
    }
}

static size_t animal_index(unsigned int id) {
    size_t lo = 0, hi = animal_count;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (animals[mid].id < id) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

void animals_update(unsigned int id, float x, float y, float z, int heading, const char *name, bool pacified) {
    if (!id || !isfinite(x) || !isfinite(y) || !isfinite(z) ||
        heading < 0 || heading > 3) return;
    size_t i = animal_index(id);
    double now = glfwGetTime();
    if (i == animal_count || animals[i].id != id) {
        if (animal_count == animal_capacity) {
            size_t capacity = animal_capacity ? animal_capacity * 2 : 32;
            Animal *grown = realloc(animals, capacity * sizeof(*animals));
            if (!grown) return;
            animals = grown;
            animal_capacity = capacity;
        }
        memmove(animals + i + 1, animals + i, (animal_count - i) * sizeof(*animals));
        ++animal_count;
        animals[i] = (Animal){.id = id, .from = {x, y, z}, .to = {x, y, z}};
    } else {
        animal_position(&animals[i], now, animals[i].from);
    }
    animals[i].to[0] = x; animals[i].to[1] = y; animals[i].to[2] = z;
    animals[i].heading = heading;
    animals[i].pacified = pacified;
    animals[i].updated = now;
    if (strlen(name) == ANIMAL_NAME_LENGTH &&
        strspn(name, "0123456789abcdef.") == ANIMAL_NAME_LENGTH) {
        memcpy(animals[i].name, name, ANIMAL_NAME_LENGTH + 1);
    }
}

unsigned int animals_target(float x, float y, float z, float vx, float vy, float vz, float *distance) {
    double now = glfwGetTime();
    for (int step = 0; step <= 128; ++step) {
        float d = step / 32.0f;
        float px = x + vx * d, py = y + vy * d, pz = z + vz * d;
        for (size_t i = 0; i < animal_count; ++i) {
            if (animals[i].pacified) continue;
            float pos[3];
            animal_position(&animals[i], now, pos);
            if (fabsf(px - pos[0]) <= .5f && fabsf(pz - pos[2]) <= .5f &&
                py >= pos[1] && py <= pos[1] + 2.1f) {
                *distance = d;
                return animals[i].id;
            }
        }
    }
    return 0;
}

float animals_nearest_distance(float x, float y, float z, float range) {
    float nearest = range * range;
    double now = glfwGetTime();
    for (size_t i = 0; i < animal_count; ++i) {
        if (animals[i].pacified) continue;
        float pos[3];
        animal_position(&animals[i], now, pos);
        float dx = pos[0] - x, dy = pos[1] + 1.0f - y, dz = pos[2] - z;
        float distance = dx * dx + dy * dy + dz * dz;
        if (distance < nearest) nearest = distance;
    }
    return sqrtf(nearest);
}

void animals_remove(unsigned int id) {
    size_t i = animal_index(id);
    if (i < animal_count && animals[i].id == id) {
        --animal_count;
        memmove(animals + i, animals + i + 1, (animal_count - i) * sizeof(*animals));
    }
}

void animals_clear(void) {
    animal_count = 0;
}

void animals_shutdown(void) {
    animals_clear();
    free(animals);
    animals = NULL;
    animal_capacity = 0;
    del_buffer(animal_buffer);
    animal_buffer = 0;
    for (int i = 0; i < 2; ++i) {
        del_buffer(zombie_buffers[i]);
        zombie_buffers[i] = 0;
    }
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

static GLuint make_zombie_buffer(int pose) {
    GLfloat *data = malloc_faces(10, ANIMAL_PARTS * 6);
    float stride = pose ? .15f : -.15f;
    animal_part(data, 0, 1.05f, 0, .65f, .8f, .4f, 9);
    animal_part(data + 360, 0, 1.75f, 0, .6f, .6f, .5f, 15);
    animal_part(data + 2 * 360, -.19f, .32f, stride, .25f, .64f, .3f, 5);
    animal_part(data + 3 * 360, .19f, .32f, -stride, .25f, .64f, .3f, 5);
    animal_part(data + 4 * 360, -.43f, 1.15f, -.3f, .2f, .22f, .8f, 15);
    animal_part(data + 5 * 360, .43f, 1.15f, -.3f, .2f, .22f, .8f, 15);
    animal_part(data + 6 * 360, -.14f, 1.8f, -.26f, .09f, .09f, .03f, 13);
    animal_part(data + 7 * 360, .14f, 1.8f, -.26f, .09f, .09f, .03f, 13);
    return gen_faces(10, ANIMAL_PARTS * 6, data);
}

void animals_render(Attrib *attrib, float *view, float x, float y, float z, int radius, bool night) {
    if (!animal_count) return;
    if (!animal_buffer) animal_buffer = make_animal_buffer();
    double now = glfwGetTime();
    int pose = ((int)(now * 3)) % 2;
    if (night && !zombie_buffers[pose]) zombie_buffers[pose] = make_zombie_buffer(pose);
    for (size_t i = 0; i < animal_count; ++i) {
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
        draw_triangles_3d_ao(attrib, night && !animals[i].pacified ? zombie_buffers[pose] : animal_buffer, ANIMAL_PARTS * 36);
    }
}

void animals_render_names(Attrib *attrib, float *view, float x, float y, float z, bool night) {
    const float glyph = .045f;
    const double now = glfwGetTime();
    float right[3] = {view[0], view[4], view[8]};
    float up[3] = {view[1], view[5], view[9]};
    normalize(right, right + 1, right + 2);
    normalize(up, up + 1, up + 2);
    float *data = NULL;
    size_t faces = 0, capacity = 0;
    for (size_t i = 0; i < animal_count; ++i) {
        if (!animals[i].name[0]) continue;
        float pos[3];
        animal_position(&animals[i], now, pos);
        float dx = pos[0] - x, dy = pos[1] - y, dz = pos[2] - z;
        if (dx * dx + dy * dy + dz * dz > 32 * 32) continue;
        pos[1] += night && !animals[i].pacified ? 2.2f : 1.45f;
        float clip[4], anchor[4] = {pos[0], pos[1], pos[2], 1};
        mat_vec_multiply(clip, view, anchor);
        if (clip[3] <= 0 || fabsf(clip[0]) > clip[3] || fabsf(clip[1]) > clip[3]) continue;
        if (faces + ANIMAL_NAME_LENGTH > capacity) {
            capacity = capacity ? capacity * 2 : 64;
            float *grown = realloc(data, capacity * 30 * sizeof(*data));
            if (!grown) break;
            data = grown;
        }
        for (int j = 0; j < ANIMAL_NAME_LENGTH; ++j) {
            float vertices[24];
            make_character(vertices, (j - (ANIMAL_NAME_LENGTH - 1) / 2) * glyph,
                0, glyph / 2, glyph, animals[i].name[j]);
            for (int v = 0; v < 6; ++v) {
                const float *vertex = vertices + v * 4;
                float *out = data + faces * 30 + v * 5;
                for (int axis = 0; axis < 3; ++axis) {
                    out[axis] = pos[axis] + right[axis] * vertex[0] + up[axis] * vertex[1];
                }
                out[3] = vertex[2];
                out[4] = vertex[3];
            }
            ++faces;
        }
    }
    if (faces) {
        glUseProgram(attrib->program);
        glUniformMatrix4fv(attrib->matrix, 1, GL_FALSE, view);
        glUniform1i(attrib->sampler, 1);
        glUniform1i(attrib->extra1, 0);
        glUniform1f(attrib->extra2, 1);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        GLuint buffer = gen_faces(5, faces, data);
        draw_triangles_3d_text(attrib, buffer, faces * 6);
        del_buffer(buffer);
        glDisable(GL_BLEND);
    } else {
        free(data);
    }
}
