int mining_get_target(int *x, int *y, int *z, int *face);
bool is_mining(void);
bool mining_is_swinging(void);
bool mining_has_pickaxe(void);
double mining_swing_elapsed(void);
void mining_stop(void);
void mining_tick(void);
void mining_start(void);
void mining_set_pickaxe(int enabled);
void mining_set_wallet_connected(int enabled);
void building_stop(void);
void building_tick(void);
void building_start(void);

#define BLOCK_BUILD_TIME 10

extern void on_mine(void);
extern void on_build(void);

extern int mining_stage;
extern int target_x;
extern int target_y;
extern int target_z;
extern int target_face;
extern int target_w;
