# Runs a command in a pseudo-terminal and passes its output through with what a site screenshot
# shouldn't show blanked out, space for space so nothing moves: the account's plan in Claude Code's
# header ("· Claude Max") and its hint about an image on the user's own clipboard; and Codex's
# usage-limit notices (its "Heads up, you have less than 50% of your 5h limit left" warning, the
# limit beside its footer and the count of warnings under it). Neither agent has a setting to hide
# them.
#
# Usage: python3 -I redact.py <command> [args...]
import fcntl
import os
import pty
import re
import select
import signal
import sys
import termios
import tty

# Claude Code draws each word of its header at its own cursor column ("·", ESC[40G, "Claude",
# ESC[47G, "Ultra"), so the words may be split by cursor moves and colors as well as spaces.
GAP = rb"(?:\x1b\[[0-9;?]*[A-Za-z]| )+"
# Codex marks a warning with "⚠ ".
WARNING = rb"(?:\xe2\x9a\xa0" + GAP + rb")?"
# What a notice may have between its first words and its last (a reset time): text and colors,
# but no cursor move, which would reach into whatever Codex draws next elsewhere on the screen.
REST_OF_LINE = rb"(?:\x1b\[[0-9;]*m|[^\x1b\r\n]){0,200}?"


def words(*parts: bytes) -> bytes:
    return GAP.join(parts)


REDACT = re.compile(
    b"|".join(
        [
            words(rb"\xc2\xb7", rb"Claude", rb"(?:Pro|Max|Ultra|Team|Enterprise)") + rb"(?:" + GAP + rb"\d+x)?",
            words(rb"Image", rb"in", rb"clipboard", rb"\xc2\xb7", rb"ctrl\+v", rb"to", rb"paste"),
            WARNING + words(rb"Heads", rb"up,", rb"you", rb"have", rb"less", rb"than") + REST_OF_LINE + rb"breakdown\.",
            # Any wording of it: "5h limit: 42% left", "weekly limit: only 5% left", ... "· /status".
            WARNING + words(rb"[\w-]+", rb"limit:") + REST_OF_LINE + rb"/status",
            WARNING + words(rb"\d+", rb"warnings?", rb"\xc2\xb7", rb"f2", rb"to", rb"view"),
        ]
    )
)
ESCAPE = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")
# Output is held back this many bytes, so a phrase split across two reads is still caught (Codex's
# warning, with its colors, is a few hundred).
HOLD = 512


def blank(match: re.Match[bytes]) -> bytes:
    """The match with its visible characters turned to spaces and its escapes kept."""
    parts = []
    last = 0
    for escape in ESCAPE.finditer(match.group(0)):
        text = match.group(0)[last : escape.start()]
        parts.append(b" " * len(text.decode("utf-8")))  # "·" is two bytes, one column
        parts.append(escape.group(0))
        last = escape.end()
    parts.append(b" " * len(match.group(0)[last:].decode("utf-8")))
    return b"".join(parts)


def copy_size(child: int) -> None:
    size = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
    fcntl.ioctl(child, termios.TIOCSWINSZ, size)


pid, child = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

copy_size(child)
signal.signal(signal.SIGWINCH, lambda *_: copy_size(child))
old = termios.tcgetattr(sys.stdin.fileno())
tty.setraw(sys.stdin.fileno())
pending = b""
# Read from until it ends: at EOF stdin stays readable, so selecting on it would spin.
inputs = [sys.stdin.fileno(), child]
try:
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [], 0.05)
        except InterruptedError:
            continue
        if sys.stdin.fileno() in ready:
            typed = os.read(sys.stdin.fileno(), 4096)
            if typed:
                os.write(child, typed)
            else:
                inputs.remove(sys.stdin.fileno())
        if child in ready:
            try:
                data = os.read(child, 65536)
            except OSError:
                break
            if not data:
                break
            pending = REDACT.sub(blank, pending + data)
            out, pending = pending[:-HOLD], pending[-HOLD:]
            os.write(sys.stdout.fileno(), out)
        elif pending:
            # Quiet for a moment: nothing more is coming for now, so let the rest through.
            os.write(sys.stdout.fileno(), REDACT.sub(blank, pending))
            pending = b""
finally:
    if pending:
        os.write(sys.stdout.fileno(), REDACT.sub(blank, pending))
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
