"""Behaviour of helpers/progress.sh, exercised through real Bash processes."""

import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent / "helpers" / "progress.sh"
BASH = shutil.which("bash")
SUBPROCESS_TIMEOUT_SECONDS = 60
SECONDS_PER_HOUR = 3600
CLEANUP_MAX_FILES = 500
RUNNING_LINE = re.compile(r"^(\d+) (\d+) (\d+)(?: (.*))?$")
FILE_NAME = re.compile(r"^job\.sh-(\d+)\.txt$")


@unittest.skipIf(BASH is None, "bash was not found on PATH")
class BashHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.progress_dir = self.root / "progress"
        self.script = self.root / "job.sh"

    def environment(self, **extra: str) -> dict[str, str]:
        env = dict(os.environ)
        env["CLAUDE_PROGRESS_DIR"] = self.progress_dir.as_posix()
        env.update(extra)
        return env

    def write_script(self, body: str, *, strict: bool = False, keep_running: bool = False) -> None:
        lines = ["set -euo pipefail"] if strict else []
        lines.append(f'source "{HELPER.as_posix()}"')
        lines.append(body)
        if keep_running:
            # Without this the exit trap would replace the running line.
            lines.append("trap - EXIT")
        self.script.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    def start(self, env: dict[str, str], cwd: Path | None = None) -> subprocess.Popen[str]:
        return subprocess.Popen(  # noqa: S603
            [BASH, self.script.as_posix()],
            env=env,
            cwd=cwd or self.root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    def run_job(
        self,
        body: str,
        *,
        strict: bool = False,
        keep_running: bool = False,
        env: dict[str, str] | None = None,
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        self.write_script(body, strict=strict, keep_running=keep_running)
        return subprocess.run(  # noqa: S603
            [BASH, self.script.as_posix()],
            env=env or self.environment(),
            cwd=cwd or self.root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
            check=False,
        )

    def only_progress_file(self, directory: Path | None = None) -> Path:
        files = list((directory or self.progress_dir).glob("*.txt"))
        self.assertEqual(len(files), 1, files)
        return files[0]

    def running_fields(self, line: str) -> tuple[int, int, int, str]:
        match = RUNNING_LINE.match(line)
        self.assertIsNotNone(match, line)
        assert match is not None
        started, step, total, label = match.groups()
        return int(started), int(step), int(total), label or ""

    def read_line(self, path: Path) -> str:
        text = path.read_bytes().decode("utf-8")
        self.assertTrue(text.endswith("\n"))
        return text[:-1]

    def seed(self, name: str, text: str) -> Path:
        self.progress_dir.mkdir(parents=True, exist_ok=True)
        path = self.progress_dir / name
        path.write_text(text, encoding="utf-8", newline="\n")
        return path

    def seed_finished(self, name: str, ended_hours_ago: int) -> Path:
        ended = int(time.time()) - ended_hours_ago * SECONDS_PER_HOUR
        return self.seed(name, f"1000 done 0 {ended}\n")

    def test_running_line_holds_start_time_step_total_and_label(self) -> None:
        before = int(time.time())
        result = self.run_job("progress 7 12 compiling assets", keep_running=True)
        after = int(time.time())
        self.assertEqual(result.returncode, 0, result.stderr)
        started, step, total, label = self.running_fields(self.read_line(self.only_progress_file()))
        self.assertTrue(before <= started <= after)
        self.assertEqual((step, total, label), (7, 12, "compiling assets"))

    def test_file_name_is_script_name_with_extension_and_pid(self) -> None:
        self.run_job("progress 1 2 x", keep_running=True)
        self.assertRegex(self.only_progress_file().name, FILE_NAME)

    def test_total_zero_is_written_as_is(self) -> None:
        self.run_job("progress 3 0 working", keep_running=True)
        _, step, total, label = self.running_fields(self.read_line(self.only_progress_file()))
        self.assertEqual((step, total, label), (3, 0, "working"))

    def test_empty_label_leaves_no_trailing_space(self) -> None:
        self.run_job("progress 3 9", keep_running=True)
        line = self.read_line(self.only_progress_file())
        self.assertRegex(line, r"^\d+ 3 9$")

    def test_label_words_are_joined_with_single_spaces(self) -> None:
        self.run_job('progress 1 2 compiling "the   assets" now', keep_running=True)
        line = self.read_line(self.only_progress_file())
        self.assertEqual(self.running_fields(line)[3], "compiling the   assets now")

    def test_label_words_ignore_a_changed_field_separator(self) -> None:
        self.run_job("IFS=,; progress 1 2 one two", keep_running=True)
        line = self.read_line(self.only_progress_file())
        self.assertEqual(self.running_fields(line)[3], "one two")

    def test_carriage_returns_and_line_feeds_in_label_become_spaces(self) -> None:
        self.run_job(r"progress 1 2 $'a\rb\nc'", keep_running=True)
        line = self.read_line(self.only_progress_file())
        self.assertEqual(self.running_fields(line)[3], "a b c")

    def test_tabs_in_label_become_spaces(self) -> None:
        self.run_job(r"progress 1 2 $'a\tb'", keep_running=True)
        line = self.read_line(self.only_progress_file())
        self.assertEqual(self.running_fields(line)[3], "a b")

    def test_repeated_calls_keep_the_same_start_time(self) -> None:
        body = (
            'file="$CLAUDE_PROGRESS_DIR/job.sh-$$.txt"\n'
            "progress 1 3 first\n"
            'echo "seen:$(<"$file")"\n'
            "sleep 1.2\n"
            "progress 2 3 second\n"
            'echo "seen:$(<"$file")"'
        )
        result = self.run_job(body, keep_running=True)
        seen = [line[len("seen:") :] for line in result.stdout.splitlines() if line.startswith("seen:")]
        self.assertEqual(len(seen), 2, result.stderr)
        first, second = (self.running_fields(line) for line in seen)
        self.assertEqual(first[0], second[0])
        self.assertEqual((first[1], second[1]), (1, 2))

    def test_finished_line_for_exit_zero(self) -> None:
        before = int(time.time())
        self.run_job("progress 1 1 only")
        after = int(time.time())
        started, word, code, ended = self.read_line(self.only_progress_file()).split(" ")
        self.assertEqual((word, code), ("done", "0"))
        self.assertTrue(before <= int(started) <= int(ended) <= after)

    def test_finished_line_for_non_zero_exit(self) -> None:
        result = self.run_job("progress 1 1 only\nexit 3")
        self.assertEqual(result.returncode, 3)
        fields = self.read_line(self.only_progress_file()).split(" ")
        self.assertEqual(fields[1:3], ["done", "3"])

    def test_finished_line_is_written_when_set_e_aborts_the_script(self) -> None:
        result = self.run_job("progress 1 1 only\nfalse\necho unreachable", strict=True)
        self.assertEqual(result.returncode, 1)
        fields = self.read_line(self.only_progress_file()).split(" ")
        self.assertEqual(fields[1:3], ["done", "1"])

    def test_script_trap_calling_progress_done_writes_the_finished_line(self) -> None:
        self.run_job("trap 'progress_done \"$?\"' EXIT\nprogress 1 1 only\nexit 4")
        fields = self.read_line(self.only_progress_file()).split(" ")
        self.assertEqual(fields[1:3], ["done", "4"])

    def test_write_leaves_no_temporary_file_and_one_lf_line_without_bom(self) -> None:
        self.run_job("progress 1 2 first\nprogress 2 2 second", keep_running=True)
        self.assertEqual(list(self.progress_dir.glob("*.tmp")), [])
        raw = self.only_progress_file().read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(raw.count(b"\n"), 1)
        self.assertNotIn(b"\r", raw)

    def test_rejects_non_integer_or_negative_step(self) -> None:
        for step in ("abc", "-1", "1.5", "", "1e3", "0x10"):
            with self.subTest(step=step):
                shutil.rmtree(self.progress_dir, ignore_errors=True)
                body = 'progress "$STEP" 3 label\necho "status=$?"'
                result = self.run_job(body, keep_running=True, env=self.environment(STEP=step))
                self.assertIn("status=2", result.stdout)
                self.assertIn(
                    f"progress: expected non-negative integers for step and total, got '{step}' '3'",
                    result.stderr,
                )
                self.assertEqual(list(self.progress_dir.glob("*")), [])

    def test_rejects_negative_total(self) -> None:
        result = self.run_job("progress 1 -2 label\necho \"status=$?\"", keep_running=True)
        self.assertIn("status=2", result.stdout)
        self.assertIn("got '1' '-2'", result.stderr)
        self.assertEqual(list(self.progress_dir.glob("*")), [])

    def test_cleanup_deletes_a_finished_file_that_ended_25_hours_ago(self) -> None:
        old = self.seed_finished("old.txt", 25)
        self.run_job("true", keep_running=True)
        self.assertFalse(old.exists())

    def test_cleanup_deletes_an_old_finished_file_with_a_negative_exit_code(self) -> None:
        ended = int(time.time()) - 25 * SECONDS_PER_HOUR
        old = self.seed("old.txt", f"1000 done -1073741819 {ended}\n")
        self.run_job("true", keep_running=True)
        self.assertFalse(old.exists())

    def test_cleanup_keeps_a_finished_file_that_ended_an_hour_ago(self) -> None:
        recent = self.seed_finished("recent.txt", 1)
        self.run_job("true", keep_running=True)
        self.assertTrue(recent.exists())

    def test_cleanup_keeps_a_running_file_with_an_old_start_time(self) -> None:
        running = self.seed("running.txt", "1 3 12 building\n")
        self.run_job("true", keep_running=True)
        self.assertTrue(running.exists())

    def test_cleanup_keeps_an_unparsable_file(self) -> None:
        junk = self.seed("junk.txt", "this is not a progress line\n")
        self.run_job("true", keep_running=True)
        self.assertTrue(junk.exists())

    def test_cleanup_examines_at_most_the_file_limit(self) -> None:
        extra = 2
        for index in range(CLEANUP_MAX_FILES + extra):
            self.seed_finished(f"old-{index:04d}.txt", 25)
        self.run_job("true", keep_running=True)
        self.assertEqual(len(list(self.progress_dir.glob("old-*.txt"))), extra)

    def test_sourcing_under_failglob_with_no_progress_files_runs_the_script(self) -> None:
        # The first source leaves the directory empty, so the second one's
        # clean-up matches nothing.
        result = self.run_job(
            f'shopt -s failglob\nsource "{HELPER.as_posix()}"\nshopt -q failglob && echo kept\n'
            "echo reached",
            strict=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("kept", result.stdout)
        self.assertIn("reached", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_two_concurrent_runs_write_two_files_with_different_pids(self) -> None:
        self.write_script("progress 1 2 x\nsleep 1")
        env = self.environment()
        first, second = self.start(env), self.start(env)
        for process in (first, second):
            process.communicate(timeout=SUBPROCESS_TIMEOUT_SECONDS)
        names = sorted(path.name for path in self.progress_dir.glob("*.txt"))
        self.assertEqual(len(names), 2, names)
        pids = {FILE_NAME.match(name).group(1) for name in names}  # type: ignore[union-attr]
        self.assertEqual(len(pids), 2)

    def test_without_progress_dir_variable_the_file_lands_under_the_working_directory(self) -> None:
        work = self.root / "work"
        work.mkdir()
        env = self.environment()
        del env["CLAUDE_PROGRESS_DIR"]
        self.run_job("progress 1 2 x", keep_running=True, env=env, cwd=work)
        self.only_progress_file(work / ".claude" / "progress")

    def test_empty_progress_dir_variable_falls_back_to_the_working_directory(self) -> None:
        work = self.root / "work"
        work.mkdir()
        env = self.environment(CLAUDE_PROGRESS_DIR="")
        self.run_job("progress 1 2 x", keep_running=True, env=env, cwd=work)
        self.only_progress_file(work / ".claude" / "progress")

    def test_script_under_strict_mode_runs_to_completion_after_a_call(self) -> None:
        result = self.run_job("progress 1 2 x\necho reached", strict=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reached", result.stdout)

    def test_unwritable_progress_dir_warns_and_does_not_fail_the_script(self) -> None:
        blocker = self.root / "blocker"
        blocker.write_text("a file, not a directory", encoding="utf-8")
        env = self.environment(CLAUDE_PROGRESS_DIR=blocker.as_posix())
        result = self.run_job("progress 1 2 x\necho reached", strict=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reached", result.stdout)
        self.assertIn("progress: cannot write", result.stderr)
        self.assertIn("job.sh-", result.stderr)


if __name__ == "__main__":
    unittest.main()
