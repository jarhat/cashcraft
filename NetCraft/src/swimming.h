#ifndef _swimming_h_
#define _swimming_h_

#include <stdbool.h>

static inline float swim_velocity(float velocity, float dt, bool ascend, bool descend) {
    float target = ascend == descend ? -0.5f : ascend ? 4.0f : -3.0f;
    if (velocity < -5.0f) velocity = -5.0f;
    if (velocity > 5.0f) velocity = 5.0f;
    float blend = dt * 5.0f;
    if (blend > 1.0f) blend = 1.0f;
    return velocity + (target - velocity) * blend;
}

#endif
