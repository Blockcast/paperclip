"""Regression tests for the Dockerfile's CVE-2026-59873 (node-tar) build guard.

PEN-5800. The Dockerfile pins npm and then asserts the version of the `tar`
that npm bundles. The original assertion was `[ "${TAR_V%%.*}" -ge 7 ]`, which
compares only the MAJOR version — so it passed on tar 7.5.11, the exact
version npm 10.9.x bundles and squarely inside the advisory's vulnerable range
(GHSA-23hp-3jrh-7fpw: `tar <= 7.5.18`, first patched 7.5.19). The guard could
not fail in its own most likely regression case: lowering the npm pin back to
a 10.9.x.

These tests are the only CI-visible assertion about that guard. The image
build itself (`docker-webflow-bot.yml` → `build-and-push`) is gated on
`github.event_name != 'pull_request'`, so a PR never executes the Dockerfile.

Pure stdlib + AST/text inspection, like test_module_structure.py — no Docker
and no Camoufox/Playwright import. Where `node` happens to be on PATH we also
execute the real assertion, joined the way Docker joins continuation lines,
against synthetic `tar/package.json` fixtures.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"

# The advisory's first patched version. If node-tar ever issues a further
# advisory, raise this constant and the Dockerfile together.
MIN_TAR = "7.5.19"

# (version, should the build pass, why this case exists)
CASES = [
    ("6.2.1", False, "playwright base image default"),
    ("7.0.0", False, "first 7.x, still inside the vulnerable range"),
    ("7.5.11", False, "what npm 10.9.x bundles -- the PEN-5800 finding"),
    ("7.5.18", False, "last vulnerable version"),
    ("7.5.19", True, "first patched version"),
    ("7.5.22", True, "what the current npm pin bundles"),
    ("8.0.0", True, "future major"),
    ("7.5.19-beta.1", False, "prerelease is not a plain X.Y.Z -> fail closed"),
    ("7.5", False, "truncated version -> fail closed"),
    (None, False, "no version field at all -> fail closed"),
]


@pytest.fixture(scope="module")
def dockerfile_text() -> str:
    return DOCKERFILE.read_text()


@pytest.fixture(scope="module")
def tar_guard(dockerfile_text: str) -> str:
    """The tar assertion as `/bin/sh -c` receives it.

    Docker removes `\\<newline>` before handing the RUN instruction to the
    shell; we reproduce that join so the tests exercise the real string.
    """
    lines = dockerfile_text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("RUN npm install -g") and "npm@" in line:
            end = i
            while lines[end].rstrip().endswith("\\"):
                end += 1
            joined = re.sub(r"\\\n", "", "\n".join(lines[i : end + 1]))
            return joined[len("RUN ") :]
    pytest.fail("could not find the npm/tar RUN instruction in the Dockerfile")


def test_guard_does_not_compare_only_the_major_version(tar_guard: str) -> None:
    """`${TAR_V%%.*}` strips everything after the first dot (PEN-5800)."""
    assert "%%.*" not in tar_guard, (
        "The tar guard compares only the MAJOR version again. That passes on "
        f"tar 7.5.11, which is vulnerable to CVE-2026-59873. Compare against "
        f"{MIN_TAR} instead."
    )


def test_guard_thresholds_on_the_advisory_fix_version(tar_guard: str) -> None:
    assert MIN_TAR in tar_guard, (
        f"The tar guard must threshold on {MIN_TAR}, the first patched "
        "version in GHSA-23hp-3jrh-7fpw."
    )


def test_comment_states_the_real_threshold(dockerfile_text: str) -> None:
    """The prose beside the guard must not promise a weaker/stronger check."""
    assert f"below {MIN_TAR}" in dockerfile_text, (
        f"The comment beside the tar guard should say it fails below {MIN_TAR}."
    )
    assert "ever back below 7." not in dockerfile_text, (
        "The comment still describes a major-version floor."
    )


def test_npm_pin_bundles_a_patched_tar(dockerfile_text: str) -> None:
    """Guard against the pin and the comment drifting apart."""
    pin = re.search(r"npm install -g[^\n\\]*npm@(\d+\.\d+\.\d+)", dockerfile_text)
    assert pin, "could not read the npm pin"
    assert f"npm@{pin.group(1)} bundles tar" in dockerfile_text, (
        f"The comment should name the tar version npm@{pin.group(1)} bundles."
    )


@pytest.mark.skipif(shutil.which("node") is None, reason="node not on PATH")
@pytest.mark.parametrize(
    ("version", "should_pass", "why"),
    CASES,
    ids=[str(v) for v, _, _ in CASES],
)
def test_guard_verdict(
    tar_guard: str, tmp_path: Path, version: str | None, should_pass: bool, why: str
) -> None:
    """Run the real assertion against a synthetic tar/package.json."""
    body: dict[str, str] = {"name": "tar"}
    if version is not None:
        body["version"] = version
    pkg = tmp_path / "package.json"
    pkg.write_text(json.dumps(body))

    # The Dockerfile derives TAR_PKG from `npm root -g`; point it at the fixture.
    if "node -e" not in tar_guard:
        pytest.fail(
            "the tar guard is no longer a `node -e` assertion, so this matrix "
            "cannot execute it; update the test alongside the Dockerfile"
        )
    script = tar_guard[tar_guard.index("node -e") :]
    proc = subprocess.run(
        ["sh", "-c", f'TAR_PKG="{pkg}"; {script}'],
        capture_output=True,
        text=True,
    )

    passed = proc.returncode == 0
    assert passed is should_pass, (
        f"tar {version}: guard {'passed' if passed else 'failed'}, expected "
        f"{'pass' if should_pass else 'fail'} ({why})\n"
        f"stdout={proc.stdout.strip()}\nstderr={proc.stderr.strip()}"
    )
    if not should_pass:
        assert "CVE-2026-59873" in (proc.stderr + proc.stdout), (
            "a rejection should name the CVE so the build log explains itself"
        )
