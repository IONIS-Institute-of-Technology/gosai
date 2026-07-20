"""`gosai-train` command-line entry point (multi-model)."""

from __future__ import annotations

import argparse

from .context import default_model, discover_models, load_context
from .registry import get_pipeline
from .util import console


def _add(subparsers, name: str, help_text: str):
    return subparsers.add_parser(name, help=help_text, description=help_text)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gosai-train",
        description="Train GOSAI driver models. Select a model with --model (default: auto).",
    )
    parser.add_argument(
        "--model", "-m", default=None,
        help="Model to operate on (a folder under training/models/). Default: auto.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    _add(sub, "models", "List available models.")
    _add(sub, "download", "Download configured datasets.")
    _add(sub, "negatives", "Fetch optional external negatives / synthesize glare.")
    _add(sub, "prepare", "Merge sources into a single-class dataset.")

    p_frames = _add(sub, "frames", "Extract frames from data/custom/videos.")
    p_frames.add_argument("--step", type=int, default=15, help="Keep 1 of every N frames.")

    p_auto = _add(sub, "autolabel", "Auto-draft labels for data/custom/images.")
    p_auto.add_argument("--weights", default=None, help="Model weights (default: latest best.pt or base).")
    p_auto.add_argument("--conf", type=float, default=0.25, help="Detection confidence threshold.")
    p_auto.add_argument(
        "--preview", action=argparse.BooleanOptionalAction, default=True,
        help="Write annotated preview JPEGs for review (default: on).",
    )

    _add(sub, "train", "Fine-tune the model on the merged dataset.")

    p_eval = _add(sub, "eval", "Evaluate weights on the test split, golden set, and FP rate.")
    p_eval.add_argument("--weights", default=None, help="Weights to evaluate (default: latest best.pt).")
    p_eval.add_argument("--conf", type=float, default=0.25, help="Confidence for the false-positive check.")

    p_mine = _add(sub, "mine", "Mine hard negatives: collect frames where the model fires, for review.")
    p_mine.add_argument("--source", default=None, help="Videos/images to scan (default: data/custom/videos).")
    p_mine.add_argument("--weights", default=None, help="Model weights (default: latest best.pt).")
    p_mine.add_argument("--conf", type=float, default=0.3, help="Detection confidence threshold.")
    p_mine.add_argument("--step", type=int, default=10, help="Scan 1 of every N video frames.")

    p_export = _add(sub, "export", "Export the trained model (ONNX by default).")
    p_export.add_argument(
        "--formats", default="onnx",
        help="Comma-separated export formats: onnx,coreml,engine (default: onnx).",
    )
    p_export.add_argument("--weights", default=None, help="Weights to export (default: latest best.pt).")

    p_install = _add(sub, "install", "Install exported model into its driver package.")
    p_install.add_argument("--src", default=None, help="Path to a specific exported file to install.")

    _add(sub, "all", "download -> negatives -> prepare -> train -> export -> install.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.command == "models":
        models = discover_models()
        if not models:
            console.print("[yellow]no models found[/] add one under training/models/<name>/")
            return 0
        current = default_model()
        for name in models:
            ctx = load_context(name)
            marker = " [dim](default)[/]" if name == current else ""
            console.print(f"[cyan]{name}[/] ({ctx.type}) -> {ctx.manifest.get('install_path', '?')}{marker}")
        return 0

    name = args.model or default_model()
    if name is None:
        available = ", ".join(discover_models()) or "(none)"
        raise SystemExit(f"multiple models exist; pass --model <name>. Available: {available}")

    ctx = load_context(name)
    pipeline = get_pipeline(ctx.type)
    command = pipeline.COMMANDS.get(args.command)
    if command is None:
        supported = ", ".join(sorted(pipeline.COMMANDS))
        raise SystemExit(
            f"command {args.command!r} is not supported for model type {ctx.type!r}. "
            f"Supported: {supported}"
        )

    console.print(f"[bold]model[/] {ctx.name} ([dim]{ctx.type}[/])")
    command(ctx, args)

    if args.command == "all":
        console.print("[bold green]pipeline complete[/] model installed into its driver.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
