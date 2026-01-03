# lumap

**Luminous UMAP** — Fast, interactive 3D point cloud visualizations with bloom effects. This repo ships the web viewer (Vite + Three.js) plus a minimal local Python CLI (not published to PyPI).

## Quick Start (Web Viewer)

Prereqs: Node 18+ (npm).

```bash
npm install
npm run dev           # dev server (http://localhost:5173)
npm run build         # production build
npm run preview       # preview the build
```

Place your data under `public/data` before running. The viewer serves everything from that fixed path.

## Data Format (public/data)

- coords.bin — Float32Array of xyz positions (length = 3 * N)
- colors.bin — Uint8Array of base RGB colors (length = 3 * N)
- attributes.json — metadata for categorical attributes
  - Shape:
  ```json
  {
    "default_attribute": "celltype",
    "attributes": {
      "celltype": { "names": ["A", "B", "C"] },
      "timepoint": { "names": ["t0", "t1"] }
    }
  }
  ```
- attribute_<name>.bin — Uint8Array codes for each attribute (one file per attribute)
- colors_<name>.bin — Uint8Array RGB colors for an attribute (optional; used when switching attributes)
- Optional legacy fallback: celltype.bin + celltype_names.json (used if attributes.json is missing).

## Controls

- Orbit, pan, zoom with mouse
- Auto-rotate toggle, point size slider, bloom controls
- Color-by attribute dropdown (from attributes.json)
- Highlight dropdown to dim all but a selected category

## Project Structure

```
lumap/
├── src/             # Three.js viewer code
├── public/          # Static assets; put data in public/data
├── index.html       # Entry HTML
├── package.json     # Web dependencies
├── vite.config.js   # Vite config
└── .venv/           # (Optional) local Python env retained but unused by the app
```

## Notes

- The Python CLI is bundled locally only (not published to PyPI). Install with `pip install -e .`.
- If you regenerate data, ensure the file names and formats above match exactly.

## Minimal CLI (convert + serve)

We ship a tiny Python CLI for local use:

```bash
pip install -e .           # from repo root (uses pyproject)
lumap convert mydata.h5ad        # writes binaries to ./lumap_bundle by default (cwd)
lumap serve lumap_bundle --open  # serves a specific bundle via Vite dev server
lumap zebra --open               # serve bundled zebrafish sample in public/data
```

Notes:
- Requires Python 3.9+ and Node 18+ with npm on PATH.
- `convert` expects a categorical obs column for colors; use `--color` and/or `--attribute` to choose columns. Use `--out` to write elsewhere.
- If you omit `--color/--attribute`, the viewer writes white points only (no attributes).
- `serve` runs `npm run dev` from this repo. Stop with Ctrl+C. Pass the bundle dir as a positional arg.

## Inspired By

Built for high-quality 3D visualization inspired by [Zebrahub](https://zebrahub.sf.czbiohub.org/)
