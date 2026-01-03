from __future__ import annotations

import json
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Iterable, List, Tuple

import anndata as ad
import click
import numpy as np
import pandas as pd
import scipy.sparse as sp
from rich.console import Console

console = Console()

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = ROOT / "public" / "data"
DEFAULT_CONVERT_OUT = "lumap_bundle"
DEFAULT_PORT = 5173
DEFAULT_HOST = "0.0.0.0"

# Simple, bright palette (cycled per attribute code)
PALETTE: List[Tuple[int, int, int]] = [
    (239, 83, 80),  # red
    (255, 167, 38),  # orange
    (255, 238, 88),  # yellow
    (102, 187, 106),  # green
    (66, 165, 245),  # blue
    (171, 71, 188),  # purple
    (0, 188, 212),  # cyan
    (255, 202, 40),  # gold
]


def _select_embedding(adata: ad.AnnData, key: str | None) -> Tuple[np.ndarray, str]:
    """Pick an embedding and return an (N,3) float32 array and the chosen key."""
    if key:
        if key not in adata.obsm:
            raise click.ClickException(f"Embedding '{key}' not found in .obsm")
        emb = adata.obsm[key]
        if sp.issparse(emb):
            emb = emb.toarray()
        chosen = key
    else:
        chosen = None
        emb = None
        for cand in ("X_umap", "X_tsne", "X_pca"):
            if cand in adata.obsm:
                emb = adata.obsm[cand]
                chosen = cand
                break
        if emb is None:
            if adata.X is None:
                raise click.ClickException(
                    "No embedding found (tried X_umap/X_tsne/X_pca and adata.X)"
                )
            emb = adata.X
            if sp.issparse(emb):
                emb = emb.toarray()
            chosen = "X"

    arr = np.asarray(emb)
    if arr.ndim != 2 or arr.shape[1] < 2:
        raise click.ClickException(
            f"Embedding '{chosen}' must be 2D or 3D (got shape {arr.shape})"
        )
    if arr.shape[1] == 2:
        arr = np.concatenate(
            [arr, np.zeros((arr.shape[0], 1), dtype=arr.dtype)], axis=1
        )
    elif arr.shape[1] > 3:
        arr = arr[:, :3]
    return arr.astype(np.float32), chosen


def _extract_categorical(df: pd.DataFrame, column: str) -> Tuple[List[str], np.ndarray]:
    if column not in df.columns:
        raise click.ClickException(f"Column '{column}' not found in .obs")
    series = df[column]
    if not pd.api.types.is_categorical_dtype(series):
        series = series.astype("category")
    cat = series.cat
    names = list(cat.categories)
    codes = cat.codes.to_numpy()
    if codes.min(initial=0) < 0:
        raise click.ClickException(
            f"Column '{column}' has missing values; fill or drop NA first"
        )
    if len(names) > 255:
        raise click.ClickException(
            f"Column '{column}' has {len(names)} categories; limit to 255"
        )
    return names, codes.astype(np.uint8)


def _codes_to_colors(codes: np.ndarray) -> np.ndarray:
    colors = np.zeros((len(codes), 3), dtype=np.uint8)
    for i, code in enumerate(codes):
        r, g, b = PALETTE[int(code) % len(PALETTE)]
        colors[i] = (r, g, b)
    return colors.reshape(-1)


def _write_bin(path: Path, array: np.ndarray, dtype: np.dtype) -> None:
    np.asarray(array, dtype=dtype).tofile(path)


def _run_dev_server(host: str, port: int, open_browser: bool) -> int:
    cmd = ["npm", "run", "dev", "--", "--host", host, "--port", str(port)]
    console.print(f"[cyan]Starting Vite dev server[/cyan] on {host}:{port} ...")
    try:
        proc = subprocess.Popen(cmd, cwd=ROOT)
    except FileNotFoundError as exc:
        raise click.ClickException(
            "npm not found; install Node.js 18+ and npm"
        ) from exc

    url_host = "localhost" if host in ("0.0.0.0", "127.0.0.1") else host
    url = f"http://{url_host}:{port}"
    if open_browser:
        webbrowser.open(url)
    console.print(f"[green]Viewer ready:[/green] {url}")
    try:
        proc.wait()
    except KeyboardInterrupt:
        console.print("\n[cyan]Stopping server...[/cyan]")
        proc.terminate()
    return proc.returncode or 0


def _restore_sample_data(target: Path, backup: Path) -> None:
    """Ensure public/data points to the bundled sample if backup exists."""
    if target.is_symlink():
        target.unlink()
    if backup.exists():
        backup.rename(target)


@click.group()
def main() -> None:
    """lumap CLI (minimal): convert AnnData to viewer format and serve the app."""


@main.command()
@click.argument("input_h5ad", type=click.Path(exists=True, dir_okay=False))
@click.option(
    "--out",
    "out_dir",
    default=DEFAULT_CONVERT_OUT,
    show_default=True,
    type=click.Path(file_okay=False),
    help="Output directory for binaries",
)
@click.option(
    "--color", "color_attr", default=None, help="Obs column to use as default colors"
)
@click.option(
    "--attribute",
    "extra_attrs",
    multiple=True,
    help="Additional categorical obs columns",
)
@click.option(
    "--embedding",
    "embedding_key",
    default=None,
    help="obsm key for embedding (fallback: X_umap/X_tsne/X_pca/X)",
)
def convert(
    input_h5ad: str,
    out_dir: str,
    color_attr: str | None,
    extra_attrs: Iterable[str],
    embedding_key: str | None,
) -> None:
    """Convert an .h5ad into lumap binary files."""
    path = Path(input_h5ad)
    console.print(f"[cyan]Reading[/cyan] {path} ...")
    adata = ad.read_h5ad(path)

    coords, chosen_emb = _select_embedding(adata, embedding_key)
    console.print(f"Using embedding: [bold]{chosen_emb}[/bold] -> coords.bin")

    requested_attrs: List[str] = []
    if color_attr:
        requested_attrs.append(color_attr)
    requested_attrs.extend(list(extra_attrs))
    if not requested_attrs:
        # Try a sensible default
        for fallback in ("celltype", "cell_type", "leiden"):
            if fallback in adata.obs.columns:
                requested_attrs.append(fallback)
                break

    attributes_json = None
    attr_data: dict[str, np.ndarray] = {}

    if requested_attrs:
        attributes_json = {"default_attribute": requested_attrs[0], "attributes": {}}

        for col in requested_attrs:
            names, codes = _extract_categorical(adata.obs, col)
            attributes_json["attributes"][col] = {"names": names}
            attr_data[col] = codes
            console.print(f"Attribute [bold]{col}[/bold]: {len(names)} categories")

    out_path = Path(out_dir).expanduser().resolve()
    out_path.mkdir(parents=True, exist_ok=True)

    _write_bin(out_path / "coords.bin", coords, np.float32)

    if attr_data:
        # Write attribute bins and color variants
        for name, codes in attr_data.items():
            _write_bin(out_path / f"attribute_{name}.bin", codes, np.uint8)
            color_bytes = _codes_to_colors(codes)
            _write_bin(out_path / f"colors_{name}.bin", color_bytes, np.uint8)

        default_attr = attributes_json["default_attribute"]
        _write_bin(
            out_path / "colors.bin", _codes_to_colors(attr_data[default_attr]), np.uint8
        )

        (out_path / "attributes.json").write_text(json.dumps(attributes_json, indent=2))
        console.print(f"[green]Wrote[/green] {len(coords)} points to {out_path}")
    else:
        # No attributes: emit all-white points and skip attributes.json
        whites = np.full((coords.shape[0] * 3,), 255, dtype=np.uint8)
        _write_bin(out_path / "colors.bin", whites, np.uint8)
        console.print(
            f"[green]Wrote[/green] {len(coords)} points to {out_path} (no attributes; white points)"
        )


@main.command()
@click.argument(
    "data_dir",
    type=click.Path(file_okay=False, exists=True, resolve_path=True),
)
@click.option("--host", default=DEFAULT_HOST, show_default=True)
@click.option("--port", default=DEFAULT_PORT, show_default=True, type=int)
@click.option("--open/--no-open", "open_browser", default=False, show_default=True)
def serve(data_dir: str, host: str, port: int, open_browser: bool) -> None:
    """Serve the web viewer (uses npm run dev) against a data directory."""
    data_path = Path(data_dir).expanduser().resolve()
    target = DEFAULT_DATA_DIR
    backup = target.with_name("data_default_backup")
    moved_sample = False

    if target.is_symlink():
        target.unlink()
    elif target.exists():
        if not backup.exists():
            target.rename(backup)
            moved_sample = True
            console.print(f"[yellow]Moved existing public/data to {backup}[/yellow]")
        else:
            raise click.ClickException(
                f"public/data exists and backup already present at {backup}; remove or rename it first"
            )

    try:
        target.symlink_to(data_path)
    except OSError as exc:
        # Attempt to restore on failure
        if moved_sample and backup.exists():
            backup.rename(target)
        raise click.ClickException(
            f"Failed to link {data_path} to public/data: {exc}"
        ) from exc

    console.print(f"Serving data from {data_path}")
    try:
        rc = _run_dev_server(host, port, open_browser)
    finally:
        if target.is_symlink():
            target.unlink()
        if moved_sample and backup.exists():
            backup.rename(target)
    sys.exit(rc)


@main.command(name="zebra")
@click.option("--port", default=DEFAULT_PORT, show_default=True, type=int)
@click.option("--open/--no-open", "open_browser", default=False, show_default=True)
def zebra(port: int, open_browser: bool) -> None:
    """Launch the viewer against the bundled zebrafish sample in public/data."""
    target = DEFAULT_DATA_DIR
    backup = target.with_name("data_default_backup")
    if backup.exists():
        _restore_sample_data(target, backup)

    if not target.exists():
        raise click.ClickException(f"Sample data not found at {target}")
    console.print("Using bundled sample data at public/data")
    sys.exit(_run_dev_server(DEFAULT_HOST, port, open_browser))


if __name__ == "__main__":
    main()
