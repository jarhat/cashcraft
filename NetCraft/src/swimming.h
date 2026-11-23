#ifndef _swimming_h_
#define _swimming_h_

#include <stdbool.h>

typedef enum { SWIM_SILENT, SWIM_STROKE, SWIM_DIVE } SwimSound;

typedef struct {
    bool wet, submerged;
    float distance, cooldown;
} SwimAudio;

static inline SwimSound swim_sound(SwimAudio *audio, bool wet, bool submerged, float distance, float dt) {
    bool diving = wet && (!audio->wet || (submerged && !audio->submerged));
    audio->wet = wet;
    audio->submerged = submerged;
    audio->cooldown -= dt;
    if (!wet) {
        audio->distance = 0;
        return SWIM_SILENT;
    }
    if (diving && audio->cooldown <= 0) {
        audio->distance = 0;
        audio->cooldown = 0.5f;
        return SWIM_DIVE;
    }
    audio->distance += distance;
    if (audio->distance >= 2.0f && audio->cooldown <= 0) {
        audio->distance = 0;
        audio->cooldown = 0.5f;
        return SWIM_STROKE;
    }
    return SWIM_SILENT;
}

static inline float swim_velocity(float velocity, float dt, bool ascend, bool descend) {
    float target = ascend == descend ? -0.5f : ascend ? 4.0f : -3.0f;
    if (velocity < -5.0f) velocity = -5.0f;
    if (velocity > 5.0f) velocity = 5.0f;
    float blend = dt * 5.0f;
    if (blend > 1.0f) blend = 1.0f;
    return velocity + (target - velocity) * blend;
}

#endif
