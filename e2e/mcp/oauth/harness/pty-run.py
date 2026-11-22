"""Run a command on a pseudo-terminal, relaying this process's stdin and stdout.

Claude Code's `mcp login` refuses to run without a terminal ("this isn't an
interactive terminal"); the OAuth CLI spec runs it here so the test can read
the authorization URL it prints and paste the callback back. Python's pty
module copes with a non-terminal stdin, which BSD `script` does not.
"""
import os
import pty
import sys

sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))
