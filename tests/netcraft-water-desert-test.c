#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include "../NetCraft/src/item.h"
#include "../NetCraft/src/swimming.h"
#include "../NetCraft/src/worldgen/biome_desert.h"

static int woods, leaves, highest_wood, lowest_wood, outside;
static void collect(int x, int y, int z, int w, void *arg) {
    (void)arg;
    if (w == Item_WOOD) {
        woods++;
        if (y > highest_wood) highest_wood = y;
        if (y < lowest_wood) lowest_wood = y;
    } else if (w == Item_LEAVES) {
        leaves++;
    }
    if ((w == Item_WOOD || w == Item_LEAVES) && (x < 0 || x >= 32 || z < 0 || z >= 32)) outside++;
}

int main(void) {
    assert(swim_velocity(-100.0f, .1f, true, false) > -5.0f);
    assert(swim_velocity(0, 1, true, false) > 0);
    assert(swim_velocity(0, 1, false, true) < 0);
    assert(swim_velocity(0, 1, false, false) < 0);
    SwimAudio audio = {0};
    assert(swim_sound(&audio, false, false, 3, 1) == SWIM_SILENT);
    assert(swim_sound(&audio, true, false, 0, .1f) == SWIM_DIVE);
    assert(swim_sound(&audio, true, true, 0, .1f) == SWIM_SILENT);
    assert(swim_sound(&audio, true, false, 0, 1) == SWIM_SILENT);
    assert(swim_sound(&audio, true, true, 0, .1f) == SWIM_DIVE);
    assert(swim_sound(&audio, true, true, 1, .3f) == SWIM_SILENT);
    assert(swim_sound(&audio, true, true, 1, .3f) == SWIM_STROKE);
    assert(swim_sound(&audio, true, true, 0, 1) == SWIM_SILENT);
    int palms = 0;
    for (int x = 0; x < 32; x++) {
        for (int z = 0; z < 32; z++) {
            woods = leaves = highest_wood = outside = 0;
            lowest_wood = 256;
            generateDesert(x, z, x, z, 32, 60, 1, collect, NULL);
            if (woods) {
                palms++;
                assert(highest_wood - lowest_wood + 1 >= 13);
                assert(leaves >= 40);
                assert(!outside);
            }
        }
    }
    assert(palms > 0);
}
