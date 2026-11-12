"""Run host regression tests without opening hardware connections."""
from pathlib import Path
import shutil
import subprocess
import sys

def main():
    tests = Path(__file__).resolve().parent / "tests"
    jobs = [(["node", str(path)], path.name) for path in sorted(tests.glob("*.test.mjs"))]
    jobs += [([sys.executable, str(path)], path.name) for path in sorted(tests.glob("*_test.py"))]
    if any(command[0] == "node" for command, _ in jobs) and not shutil.which("node"):
        raise RuntimeError("Node.js is required for JavaScript tests")
    for command, name in jobs:
        print(f"Running {name}", flush=True)
        subprocess.run(command, cwd=tests.parents[1], check=True)
    print(f"PASS: {len(jobs)} test files")

if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"Test run failed: {exc}")
