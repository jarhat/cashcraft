#ifndef _animals_h_
#define _animals_h_

#include "attrib.h"

void animals_update(unsigned int id, float x, float y, float z, int heading);
void animals_remove(unsigned int id);
void animals_clear(void);
void animals_shutdown(void);
void animals_render(Attrib *attrib, float *view, float x, float y, float z, int radius);

#endif
