from math import atan2, hypot, pi
from time import monotonic

from craftbot import CraftBot, run_cli


class HumanoidBot(CraftBot):
    """Stand guard: let zombies approach, then face them and swing."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.night = False
        self.next_swing = 0

    def on_you(self, id, position):
        x, y, z = map(round, position[:3])
        if -28 <= x <= 28 and -25 <= z <= 28 and y >= 180:
            # Zombies cannot spawn on the sky park. Guard the ground beside it.
            x = 32
        elif y > 1:
            return
        for height in range(253, 0, -1):
            if self.get_block(x, height, z) not in (0, 16, 17, 18, 19, 20, 21, 22, 23):
                self.move_player(x, height + 2, z)
                return
        raise ValueError(f'No ground for guard at {x},{z}')

    def handle_command(self, command):
        fields = command.rstrip('\r\n').split(',')
        if fields[0] == 'ZN':
            self.night = fields[1:] == ['1']
        elif fields[0] == 'M':
            if (not self.night or not self.ready or len(fields) < 8
                    or fields[7] != '0' or (len(fields) > 8 and fields[8] != '0')):
                return  # Daytime, pacified animal or wildlife.
            now = monotonic()
            if now < self.next_swing:
                return
            ax, ay, az = map(float, fields[2:5])
            x, y, z = self.player.position[:3]
            dx, dy, dz = ax - x, ay + 1.05 - y, az - z
            horizontal = hypot(dx, dz)
            if hypot(horizontal, dy) <= 4:
                self.move_player(rx=atan2(dz, dx) + pi / 2, ry=atan2(dy, horizontal))
                self.send(f'ZA,{int(fields[1])}')
                self.next_swing = now + 0.3
        else:
            super().handle_command(command)


if __name__ == '__main__':
    run_cli(HumanoidBot)
