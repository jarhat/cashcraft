from math import atan2, hypot, pi
from time import monotonic

from craftbot import CraftBot, run_cli


class HumanoidBot(CraftBot):
    """Stand guard: let zombies approach, then face them and swing."""
    patrol = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.night = False
        self.next_swing = 0

    def handle_command(self, command):
        fields = command.rstrip('\r\n').split(',')
        if fields[0] == 'ZN':
            self.night = fields[1:] == ['1']
        elif fields[0] == 'M':
            if (not self.night or self.spawn is None or len(fields) < 8
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
