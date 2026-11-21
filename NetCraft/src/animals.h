#ifndef _animals_h_
#define _animals_h_

#include "attrib.h"
#include <stdbool.h>

#define ANIMAL_NAME_LENGTH 15

void animals_update(unsigned int id, float x, float y, float z, int heading, const char *name, bool pacified);
void animals_remove(unsigned int id);
void animals_clear(void);
void animals_shutdown(void);
void animals_render(Attrib *attrib, float *view, float x, float y, float z, int radius, bool night);
void animals_render_names(Attrib *attrib, float *view, float x, float y, float z, bool night);
unsigned int animals_target(float x, float y, float z, float vx, float vy, float vz, float *distance);

#endif
