import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


BOTS = Path(__file__).resolve().parents[1] / "NetCraft" / "CraftBot"


class CraftBotJoinTests(unittest.TestCase):
    def test_guest_join_from_another_working_directory(self):
        with tempfile.TemporaryDirectory() as cwd, socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen()
            server.settimeout(5)
            host, port = server.getsockname()
            for name in ("SnakeBot", "MakerBot", "TerraformBot", "HumanoidBot"):
                with self.subTest(name=name), subprocess.Popen(
                    [sys.executable, BOTS / f"{name.lower()}.py", host, str(port)],
                    cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                ) as bot:
                    try:
                        conn, _ = server.accept()
                        with conn, conn.makefile("rb") as reader:
                            conn.settimeout(5)
                            self.assertEqual(reader.readline(), b"V,1\n")
                            self.assertEqual(reader.readline(), f"T,/nick {name}\n".encode())
                            conn.sendall(b"U,7,-19,")
                            conn.sendall(b"42,-3,0,0\nN,7,guest7\nH\n")
                            if name == "TerraformBot":
                                self.assertEqual(reader.readline(), b"T,Terraformbot ready for action.\n")
                            if name == "HumanoidBot":
                                # Day, wildlife, a pacified zombie and a distant zombie are ignored.
                                conn.sendall(b"ZN,0\nM,10,-19,41,-6,0,aaaaaa...aaaaaa,0,0,3\n"
                                             b"ZN,1\nM,11,-19,41,-6,0,-,0,1\n"
                                             b"M,12,-19,41,-6,0,aaaaaa...aaaaaa,1,0,0\n"
                                             b"M,13,-19,41,-20,0,aaaaaa...aaaaaa,0,0,3\n"
                                             b"M,14,-19,41,-6,0,aaaaaa...aaaaaa,0,0,2\n")
                                self.assertTrue(reader.readline().startswith(b"P,-19.000000,42.000000,-3.000000,"))
                                self.assertEqual(reader.readline(), b"ZA,14\n")
                        stdout, stderr = bot.communicate(timeout=5)
                        self.assertEqual(bot.returncode, 0, stderr)
                        self.assertIn("as player 7", stdout)
                    finally:
                        if bot.poll() is None:
                            bot.kill()
