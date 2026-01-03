# lumap

**Luminous UMAP** — Fast, interactive 3D point cloud visualizations with bloom effects. This repo now only contains the web viewer (Vite + Three.js). The previous Python CLI/package is not shipped here.

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

- There is no published `lumap` Python package or CLI in this repo. Use your own preprocessing to generate the `public/data` binaries.
- If you regenerate data, ensure the file names and formats above match exactly.

## Inspired By

Built for high-quality 3D visualization inspired by [Zebrahub](https://zebrahub.sf.czbiohub.org/)
