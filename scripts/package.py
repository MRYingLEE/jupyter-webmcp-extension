from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parent.parent
dist = root / "dist"
archive = root / "jupyter-webmcp-extension.zip"

if not (dist / "manifest.json").is_file():
    raise SystemExit("dist/manifest.json is missing; run `npm run build` first.")

with ZipFile(archive, "w", compression=ZIP_DEFLATED) as output:
    for path in sorted(dist.rglob("*")):
        if path.is_file() and path.suffix != ".map":
            output.write(path, path.relative_to(dist))

print(f"Created {archive}")
