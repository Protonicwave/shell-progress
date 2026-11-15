"""Measures the CPU time mod/hooks/sampler.ps1 uses over a minute of sampling.

Runs the sampler, waits for its first line so that PowerShell's start-up is
left out, then reads the child's CPU time again 60 seconds later. Prints the
figure next to the budget and exits 1 when it is over, or 2 when the sampler
cannot be measured. Windows only.
"""

import ctypes
import queue
import shutil
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

SAMPLER = Path(__file__).resolve().parent.parent / "mod" / "hooks" / "sampler.ps1"
MEASURED_SECONDS = 60
BUDGET_MS = 600
FIRST_LINE_TIMEOUT_SECONDS = 30
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
FILETIME_TICKS_PER_MS = 10_000


def cpu_ms(pid: int) -> float:
    """User plus kernel time of the process so far, in milliseconds."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"cannot open process {pid}")
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(
            handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)
        ):
            raise OSError(ctypes.get_last_error(), f"cannot read the times of process {pid}")
    finally:
        kernel32.CloseHandle(handle)
    ticks = sum((filetime.dwHighDateTime << 32) | filetime.dwLowDateTime for filetime in (kernel, user))
    return ticks / FILETIME_TICKS_PER_MS


def forward_lines(stream: "subprocess.IO[str]", lines: "queue.Queue[str]") -> None:
    for line in stream:
        lines.put(line)


def measure(powershell: str) -> tuple[float, float, int]:
    """CPU milliseconds at the first line, over the next minute, and the lines in that minute."""
    command = [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(SAMPLER)]
    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True, encoding="utf-8") as child:
        try:
            assert child.stdout is not None, "stdout was requested as a pipe"
            lines: queue.Queue[str] = queue.Queue()
            threading.Thread(target=forward_lines, args=(child.stdout, lines), daemon=True).start()
            lines.get(timeout=FIRST_LINE_TIMEOUT_SECONDS)
            start_up_ms = cpu_ms(child.pid)
            time.sleep(MEASURED_SECONDS)
            sampling_ms = cpu_ms(child.pid) - start_up_ms
            if child.poll() is not None:
                raise RuntimeError(f"the sampler exited with code {child.returncode} while it was measured")
            return start_up_ms, sampling_ms, lines.qsize()
        finally:
            child.kill()


def main() -> int:
    powershell = shutil.which("powershell")
    if sys.platform != "win32" or powershell is None:
        print("the sampler needs Windows PowerShell", file=sys.stderr)
        return 2
    try:
        start_up_ms, sampling_ms, line_count = measure(powershell)
    except (OSError, RuntimeError, queue.Empty) as error:
        print(f"cannot measure the sampler: {error!r}", file=sys.stderr)
        return 2
    print(f"start-up: {start_up_ms:.0f} ms of CPU, not counted")
    print(f"sampling: {sampling_ms:.0f} ms of CPU over {MEASURED_SECONDS} s and {line_count} lines; budget {BUDGET_MS} ms")
    return 0 if sampling_ms <= BUDGET_MS else 1


if __name__ == "__main__":
    sys.exit(main())
