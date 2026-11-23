#ifndef _map_h_
#define _map_h_

#define MAP_XZ_MAX 127
#define MAP_Y_MAX 511
#define EMPTY_ENTRY(entry) (!(entry)->e.used)

#define MAP_FOR_EACH(map, ex, ey, ez, ew) \
    for (unsigned int i = 0; i <= map->mask; i++) { \
        MapEntry *entry = map->data + i; \
        if (EMPTY_ENTRY(entry)) { \
            continue; \
        } \
        int ex = entry->e.x + map->dx; \
        int ey = entry->e.y + map->dy; \
        int ez = entry->e.z + map->dz; \
        int ew = entry->e.w;

#define END_MAP_FOR_EACH }

typedef struct {
    // Keep entries to one word while supporting 9-bit relative heights.
    struct {
        unsigned int x : 7;
        unsigned int y : 9;
        unsigned int z : 7;
        signed int w : 8;
        unsigned int used : 1;
    } e;
} MapEntry;

typedef struct {
    int dx;
    int dy;
    int dz;
    unsigned int mask;
    unsigned int size;
    MapEntry *data;
} Map;

void map_alloc(Map *map, int dx, int dy, int dz, int mask);
void map_free(Map *map);
void map_copy(Map *dst, Map *src);
void map_grow(Map *map);
bool map_set(Map *map, int x, int y, int z, int w);
int map_get(Map *map, int x, int y, int z);

#endif
