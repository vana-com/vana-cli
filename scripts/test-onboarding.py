#!/usr/bin/env python3
"""Exercise the real piped Unix installer and five onboarding screens in a PTY.

Use --release-base-url file:///... --version candidate for a local SEA release;
by default this downloads and tests the latest published release. No account,
provider, browser, grant or payment is used. State lives in a disposable home.
"""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import struct
import tempfile
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--installer", default="install/install.sh")
parser.add_argument("--release-base-url")
parser.add_argument("--version")
parser.add_argument("--evidence", default="/tmp/vana-onboarding-proof.json")
args = parser.parse_args()
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


class Terminal:
    def __init__(self, command, env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvpe("sh", ["sh", "-c", command], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 120, 0, 0))
        self.output = ""
        self.offset = 0
        self.closed = False
        self.reaped = False

    def expect(self, text, timeout=45):
        deadline = time.monotonic() + timeout
        while text not in ansi.sub("", self.output[self.offset:]):
            if self.closed or time.monotonic() >= deadline:
                raise AssertionError(f"Did not see {text!r}:\n{ansi.sub('', self.output)[-6000:]}")
            ready, _, _ = select.select([self.fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    self.closed = True
                self.output += chunk.decode(errors="replace")
        return ansi.sub("", self.output[self.offset:])

    def send(self, data):
        self.offset = len(self.output)
        os.write(self.fd, data)

    def finish(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.reaped = True
                assert os.waitstatus_to_exitcode(status) == 0, self.output[-3000:]
                return
            # Drain pending terminal output so the process can finish writing.
            if not self.closed and select.select([self.fd], [], [], 0.1)[0]:
                try:
                    chunk = os.read(self.fd, 65536)
                    self.output += chunk.decode(errors="replace")
                    self.closed = not chunk
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    self.closed = True
        raise AssertionError("CLI did not exit after the guide")

    def close(self):
        if not self.reaped:
            os.kill(self.pid, signal.SIGTERM)
            os.waitpid(self.pid, 0)
        os.close(self.fd)


proof = {}
with tempfile.TemporaryDirectory(prefix="vana-onboarding-") as directory:
    home = Path(directory)
    env = dict(os.environ)
    for key in ("CI", "AGENT", "VANA_DETACHED", "VANA_HOME", "VANA_APP_ROOT", "VANA_SKILLS_DIR", "DATA_CONNECTORS_DIR"):
        env.pop(key, None)
    env.update(HOME=str(home), VANA_HOME=str(home / ".vana"),
               VANA_INSTALL_ROOT=str(home / "release"), VANA_INSTALL_BIN_DIR=str(home / "bin"),
               TERM="xterm-256color", VANA_TELEMETRY_DISABLED="1", VANA_NO_UPDATE_NOTIFIER="1")
    if args.version:
        env["VANA_VERSION"] = args.version
    if args.release_base_url:
        env["VANA_RELEASE_BASE_URL"] = args.release_base_url
    installer = shlex.quote(str(Path(args.installer).resolve()))
    terminal = Terminal(f"cd {shlex.quote(directory)} && cat {installer} | sh", env)
    try:
        welcome = terminal.expect("Up/Down: move | Enter: choose | Ctrl+C: exit", 180)
        for label in ("[OK] Vana installed.", "Collect or manage my data", "Use or share data",
                      "Build or test a connector", "Manage my Personal Server",
                      "Agent skills are included. No installation needed.", "vana skills setup"):
            assert label in welcome, label
        assert welcome.index("Manage my Personal Server") < welcome.index("Help: vana --help")
        proof["1-welcome-from-install"] = welcome
        terminal.send(b"\r")
        terminal.expect("Ctrl+O: Source not listed | Ctrl+C: exit")
        proof["2-source-picker"] = terminal.expect("Amazon")
        terminal.send(b"\x0f")
        proof["3-source-name"] = terminal.expect("Enter: continue | Ctrl+C: exit")
        assert "Which source are you looking for?" in proof["3-source-name"]
        terminal.send(b"Readwise")
        terminal.expect("Name or website: Readwise")
        terminal.send(b"\r")
        decision = terminal.expect("Choose another source")
        assert "Readwise isn't in Vana's source list." in decision
        assert "A connector is needed to collect your highlights." in decision
        assert "Build a Readwise connector" in decision
        proof["4-connector-decision"] = decision
        terminal.send(b"\r")
        proof["5-guide"] = terminal.expect("Follow the guide yourself, or share it with your agent.")
        assert "https://github.com/vana-com/vana-cli/blob/main/skills/create-connector/SKILL.md" in proof["5-guide"]
        terminal.finish()
        # Discovery must not install agent skills or require sign-in.
        assert not (home / ".agents/skills").exists()
        assert not (home / ".claude/skills").exists()
        proof["exit"] = 0
        print("PASS: fresh piped install -> welcome -> picker -> source name -> connector choice -> guide -> exit 0")
    finally:
        proof["raw-terminal"] = terminal.output
        Path(args.evidence).write_text(json.dumps(proof, indent=2))
        terminal.close()
