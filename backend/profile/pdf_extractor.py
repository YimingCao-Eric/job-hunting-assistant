"""Stage 1: PDF bytes → Markdown via opendataloader-pdf (local JVM)."""

from __future__ import annotations

import importlib.resources
import shutil
import subprocess
import tempfile
from pathlib import Path

import opendataloader_pdf

_JAR_NAME = "opendataloader-pdf-cli.jar"


def _calledprocess_detail(err: subprocess.CalledProcessError) -> str:
    """Best-effort message from a failed subprocess (quiet=True sets stderr/stdout; streaming mode sets output)."""
    parts: list[str] = []
    for attr in ("stderr", "stdout", "output"):
        val = getattr(err, attr, None)
        if not val:
            continue
        if isinstance(val, bytes):
            parts.append(val.decode("utf-8", errors="replace"))
        else:
            parts.append(str(val))
    deduped: list[str] = []
    for p in parts:
        p = p.strip()
        if p and p not in deduped:
            deduped.append(p)
    return "\n".join(deduped) if deduped else "(no stderr captured)"


def _run_jar_with_capture(pdf_path: Path, out_dir: Path) -> subprocess.CompletedProcess[str]:
    jar_ref = importlib.resources.files("opendataloader_pdf").joinpath("jar", _JAR_NAME)
    with importlib.resources.as_file(jar_ref) as jar_path:
        cmd = [
            "java",
            "-jar",
            str(jar_path),
            str(pdf_path),
            "--output-dir",
            str(out_dir),
            "--format",
            "markdown",
        ]
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def extract_resume_markdown(pdf_bytes: bytes, filename: str) -> str:
    """
    Write PDF to a temp dir, run opendataloader-pdf, return first .md file as UTF-8.
    Cleans up temp dir in a finally block.
    """
    safe_name = Path(filename).name
    if not safe_name.lower().endswith(".pdf"):
        safe_name = f"{safe_name}.pdf"

    tmp_dir = tempfile.mkdtemp(prefix="resume_pdf_")
    try:
        pdf_path = Path(tmp_dir) / safe_name
        pdf_path.write_bytes(pdf_bytes)
        out_dir = Path(tmp_dir) / "output"
        out_dir.mkdir(parents=True, exist_ok=True)

        try:
            # quiet=True → subprocess.run(capture_output=True) so failures include stderr/stdout on CalledProcessError
            opendataloader_pdf.convert(
                input_path=[str(pdf_path)],
                output_dir=str(out_dir),
                format="markdown",
                quiet=True,
            )
        except subprocess.CalledProcessError as e:
            detail = _calledprocess_detail(e)
            if detail == "(no stderr captured)":
                result = _run_jar_with_capture(pdf_path, out_dir)
                detail = (
                    f"stderr: {(result.stderr or '')[:500]}\n"
                    f"stdout: {(result.stdout or '')[:200]}"
                )
            raise RuntimeError(
                f"PDF extraction failed (exit {e.returncode}): {detail}"
            ) from e
        except Exception as e:
            try:
                result = _run_jar_with_capture(pdf_path, out_dir)
            except Exception:
                raise RuntimeError(f"PDF extraction failed: {e}") from e
            if result.returncode != 0:
                raise RuntimeError(
                    f"PDF extraction failed (exit {result.returncode}).\n"
                    f"stderr: {(result.stderr or '')[:500]}\n"
                    f"stdout: {(result.stdout or '')[:200]}"
                ) from e
            raise RuntimeError(f"PDF extraction failed: {e}") from e

        md_files = sorted(out_dir.rglob("*.md"))
        if not md_files:
            raise RuntimeError("opendataloader-pdf produced no output")

        return md_files[0].read_text(encoding="utf-8", errors="replace")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
