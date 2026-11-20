#include <assert.h>
#include "../NetCraft/src/inventory.h"

int main(void) {
    Inventory inventory;
    int items[INVENTORY_COUNT_LEN];
    Inventory_reset(&inventory);
    assert(Inventory_items(&inventory, items) == 0);
    Inventory_collect(&inventory, 83);
    Inventory_collect(&inventory, 6);
    Inventory_collect(&inventory, 6);
    assert(Inventory_items(&inventory, items) == 2);
    assert(items[0] == 6 && items[1] == 83);
    Inventory_use(&inventory, 6);
    assert(Inventory_items(&inventory, items) == 2);
    Inventory_use(&inventory, 6);
    assert(Inventory_items(&inventory, items) == 1 && items[0] == 83);
    Inventory_reset(&inventory);
    assert(Inventory_items(&inventory, items) == 0);
    return 0;
}
