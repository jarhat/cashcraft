#ifndef _chunk_h_
#define _chunk_h_

#include <GL/glew.h>
#include "map.h"
#include "sign.h"

typedef struct {
    Map map;
    Map lights;
    SignList signs;
    int p;
    int q;
    int faces;
    int sign_faces;
    int dirty;
#ifdef __EMSCRIPTEN__
    int needs_resync;
    int sync_pending;
#endif
    int miny;
    int maxy;
    GLuint buffer;
    GLuint sign_buffer;
} Chunk;

#endif
