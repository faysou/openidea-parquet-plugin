"""Package the built web editor and WebAssembly component for OpenIDEA."""

import argparse
import json
import tomllib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--tag", help="verify the release tag against the package version")
args = parser.parse_args()

manifest = tomllib.loads((root / "plugin.toml").read_text())
version = manifest["version"]
cargo = tomllib.loads((root / "Cargo.toml").read_text())
if {cargo["package"]["version"], json.loads((root / "package.json").read_text())["version"]} != {version}:
    parser.error("plugin.toml, Cargo.toml, and package.json must have the same version")
if args.tag is not None and args.tag != f"v{version}":
    parser.error(f"expected tag v{version}, got {args.tag}")
web = root / manifest["contributes"]["customEditors"][0]["web"]
wasm = root / manifest["wasm"]
if not web.is_file() or not wasm.is_file():
    parser.error("build the web editor and WebAssembly component before packaging")
files = [root / "plugin.toml", wasm, root / "LICENSE", root / "README.md"]
files.extend(sorted((root / "docs/images").glob("*.png")))
files.extend(path for path in web.parent.rglob("*") if path.is_file())
package = root / "dist" / f"{manifest['id']}-{version}.oiplugin"
with ZipFile(package, "w", ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, path.relative_to(root))
print(package)
