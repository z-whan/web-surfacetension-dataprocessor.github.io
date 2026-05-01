#!/usr/bin/env python3
"""Generate the browser bundle of Python source files for Pyodide."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


HEADER = "// Generated file. Do not edit manually."
ASSIGNMENT = "window.__PYTHON_SOURCES__ = "
DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PY_ROOT = DEFAULT_REPO_ROOT / "py"
DEFAULT_OUTPUT = DEFAULT_REPO_ROOT / "assets" / "js" / "python-sources.js"


def iter_python_files(py_root: Path) -> list[Path]:
    """Return Python files below py_root in deterministic POSIX path order."""
    if not py_root.is_dir():
        raise FileNotFoundError(f"Python source root does not exist: {py_root}")

    return sorted(
        (path for path in py_root.rglob("*.py") if path.is_file()),
        key=lambda path: path.relative_to(py_root).as_posix(),
    )


def build_sources(py_root: Path, path_prefix: str = "py") -> dict[str, str]:
    """Build a mapping from runtime mirror paths to Python source text."""
    normalized_prefix = path_prefix.strip("/")
    sources: dict[str, str] = {}

    for source_path in iter_python_files(py_root):
        relative_path = source_path.relative_to(py_root).as_posix()
        runtime_path = (
            f"{normalized_prefix}/{relative_path}" if normalized_prefix else relative_path
        )
        sources[runtime_path] = source_path.read_text(encoding="utf-8")

    return sources


def render_python_sources(py_root: Path, path_prefix: str = "py") -> str:
    """Render assets/js/python-sources.js content."""
    payload = json.dumps(
        build_sources(py_root, path_prefix=path_prefix),
        ensure_ascii=True,
        indent=2,
        sort_keys=True,
    )
    return f"{HEADER}\n{ASSIGNMENT}{payload};\n"


def write_python_sources(output_path: Path, content: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")


def check_python_sources(output_path: Path, expected_content: str) -> bool:
    try:
        current_content = output_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    return current_content == expected_content


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate assets/js/python-sources.js from the py/ source tree."
    )
    parser.add_argument(
        "--py-root",
        type=Path,
        default=DEFAULT_PY_ROOT,
        help="Python source root to bundle. Defaults to ./py.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="JavaScript output file. Defaults to ./assets/js/python-sources.js.",
    )
    parser.add_argument(
        "--path-prefix",
        default="py",
        help="Runtime path prefix stored in the generated mapping. Defaults to 'py'.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the generated output differs from the current file.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    expected_content = render_python_sources(args.py_root, path_prefix=args.path_prefix)

    if args.check:
        if check_python_sources(args.output, expected_content):
            print(f"{args.output} is up to date.")
            return 0
        print(
            f"{args.output} is stale. Run: python tools/build_python_sources.py",
            file=sys.stderr,
        )
        return 1

    write_python_sources(args.output, expected_content)
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
