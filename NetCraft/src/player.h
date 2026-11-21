#ifndef _player_h_
#define _player_h_

#include "state.h"

#define MAX_NAME_LENGTH 32
#define MAX_CHAT_LENGTH 255

typedef struct {
    int id;
    char name[MAX_NAME_LENGTH];
    char chat[MAX_CHAT_LENGTH + 1];
    double chat_time;
    State state;
    State state1;
    State state2;
    GLuint buffer;
} Player;

#endif
