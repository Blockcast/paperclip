"""Sanity tests for the extracted webflow_bot/__main__.py.

These tests run via plain AST inspection so they do NOT require Camoufox or
Playwright to be installed — the CI step that imports them runs before the
Docker build (which is where the runtime dependencies land).

When the source is split into modules (follow-up to BLO-6870), these tests
should be replaced with proper unit tests that mock Camoufox/Page and exercise
pure-logic surfaces like `_auth_ok` and `_read_json`.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "webflow_bot" / "__main__.py"


@pytest.fixture(scope="module")
def module_ast() -> ast.Module:
    """Parse webflow_bot/__main__.py into an AST once per test session."""
    return ast.parse(SRC.read_text())


def _top_level_function_names(tree: ast.Module) -> set[str]:
    return {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}


def _top_level_class_names(tree: ast.Module) -> set[str]:
    return {n.name for n in tree.body if isinstance(n, ast.ClassDef)}


def test_module_parses_as_valid_python(module_ast: ast.Module) -> None:
    """Extracted source must be syntactically valid Python.

    This is the regression gate that catches yaml-block-scalar indentation
    bugs during the extraction (a common failure mode when copying out of
    a `|` block: misaligned dedent → SyntaxError).
    """
    assert isinstance(module_ast, ast.Module)
    assert len(module_ast.body) > 0


def test_module_has_main_entry_point(module_ast: ast.Module) -> None:
    """`python3 -m webflow_bot` needs a `main()` callable at module top level."""
    assert "main" in _top_level_function_names(module_ast)


def test_module_has_control_handler_class(module_ast: ast.Module) -> None:
    """The HTTP control plane on :7000 is the bot's public surface.

    `_ControlHandler` MUST be present — if a future edit removes it the bot
    silently 503s every endpoint and the cluster agent can't drive Designer.
    """
    classes = _top_level_class_names(module_ast)
    assert "_ControlHandler" in classes
    assert "_ControlServer" in classes


@pytest.mark.parametrize(
    "name",
    [
        # Session-level
        "_do_login",
        "_is_logged_in",
        "_open_designer",
        "_has_bridge_app",
        "_try_launch_bridge_app",
        # Per-endpoint handlers — the HTTP contract
        "_ep_screenshot",
        "_ep_eval",
        "_ep_click",
        "_ep_dblclick",
        "_ep_key",
        "_ep_set_html_embed",
        "_ep_create_page",
        # Helpers used by endpoints
        "_run_in_page",
        "_click_aid_by_coords",
        "_fill_aid",
    ],
)
def test_required_functions_present(module_ast: ast.Module, name: str) -> None:
    """Each of these is referenced from operator runbooks or cluster yaml.

    If any goes missing, an external integration breaks. Pin them here so the
    next person editing the script gets a CI failure instead of a silent
    production-only break.
    """
    assert name in _top_level_function_names(module_ast)


def test_shebang_and_docstring_present(module_ast: ast.Module) -> None:
    """Module-level docstring documents the contract; shebang lets the file
    be run directly during noVNC-bootstrap debugging."""
    first_line = SRC.read_text().splitlines()[0]
    assert first_line.startswith("#!"), "missing shebang line"
    assert ast.get_docstring(module_ast) is not None
