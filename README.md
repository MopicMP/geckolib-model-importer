# GeckoLib Model Importer

A Blockbench plugin that imports **glTF models — including straight from
Sketchfab — into the GeckoLib format**, with bones, cubes, textures and
animations.

Minecraft cannot render arbitrary polygonal geometry. A glTF model opens fine in
Blockbench, but every element is a `Mesh`, and the game needs `Cube`. This plugin
does that conversion, and everything around it.

## What it does

- **Import a ZIP** with a glTF model and textures, and get a finished GeckoLib
  project. Textures may be PNG, JPEG, GIF or WebP.
- **Browse Sketchfab** inside Blockbench, through the official Data API. Author
  and licence are shown on every card; only models the author allowed to be
  downloaded are listed.
- **Several textures** are packed into one atlas, because GeckoLib wants one.
- **Merged meshes** are split back into separate cubes automatically — many
  exporters emit 708 triangles where the model really has 59 boxes.
- **Animations** are carried over, both rotation and position channels.
- **Coplanar faces** are separated through the `Inflate` field, so the model does
  not flicker (z-fighting) while coordinates stay clean.

## What it cannot do

Wedges, bevels and rounded shapes do not exist in Minecraft. Such objects are
replaced with their bounding box, with the texture laid out per face. The import
report states exactly which share of the model was approximated; at 30% or more
it says plainly that the model is a poor fit.

Coordinates are cleaned of floating-point noise (`4.99998` becomes `5`), but a
model that was not built on a 0.25 px grid keeps its exact numbers. Snapping such
a model would grow small details by a quarter and flatten thin overlays — a pupil
of 0.6 × 0.7 × 0.001 px became 0.75 × 0.75 × 0 and disappeared into the head.

## Requirements

The **GeckoLib Animation Utils** plugin: its format is what projects are built
into. The plugin checks for it before importing. Converting an already-open model
from meshes to cubes (Filter menu) works without it.

Downloading from Sketchfab needs a personal API token, available in the Sketchfab
profile settings under *Password & API*. Searching works without one.

## Usage

**Search:** File → *Sketchfab — model search*.

**Import:** File → Import → *GeckoLib from ZIP (glTF + texture)*, or the
*GeckoLib from ZIP* tile on the start screen.

The dialog offers five settings: model size, centring, extra rotation around X
and Y, and whether to transfer animations. Everything else lives behind the
**Advanced settings** checkbox — those are levers for diagnosing breakage, and
they are best changed one at a time.

**Install:** Blockbench → File → Plugins → *Load Plugin from File* →
[`plugin/geckolib_model_importer.js`](plugin/geckolib_model_importer.js).

## Testing without Blockbench

The converter core does not depend on Blockbench, so it can be exercised from
Node. This catches maths errors without opening the editor:

```bash
node tools/verify-conversion.mjs model/model.obj    # box detection and UV layout
node tools/verify-gltf.mjs        model/model.obj    # glTF parsing against a baseline
node tools/verify-snap.mjs                           # grid snapping and its cost
node tools/verify-coplanar.mjs                       # coplanar face separation
node tools/verify-images.mjs                         # PNG/JPEG/GIF/WebP headers
node tools/smoke-plugin.mjs                          # the whole import path
```

`smoke-plugin` substitutes Blockbench objects (`Cube`, `Group`, `Animation`,
`THREE`, `JSZip`…) and runs the entire import twice: once with a PNG archive, once
with a JPEG archive that also contains an unreadable image. It catches what
`node --check` misses — reading a `const` before its declaration, typos in names,
calls to functions that do not exist.

## Licence

MIT, see [LICENSE](LICENSE).

Imported models keep their own licence. Most Sketchfab models require attribution,
so the import report always prints the author and the licence from the archive.
