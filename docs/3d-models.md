# 3D objects: `view3d` and the modelling notes

A local model writes 3D objects as numbers it cannot picture. In a 3D chess app, Inkling 2 Mini used the right
three.js tools (`LatheGeometry` for the turned pieces, an extruded outline for the knight). But it checked them only
by printing bounding-box sizes. So it never saw the flaws:
- a hollow rook with an open top;
- a knight that was a flat cut-out;
- a bishop's "slit" that was a dark box stuck on the surface;
- king and queen bodies that were the same copied profile;
- outlines with about ten points each, which come out lumpy.

`@Callisto` has two things for this: a tool that lets the model see what it built, and notes on how to build 3D objects
well.

## The `view3d` tool

`view3d` draws an object in Callisto's headless browser (the one the `browser` tool uses; see `docs/browser.md`) and
returns one image and a short report.

**One object** is drawn from four sides:

| | |
|---|---|
| Front (seen from +z) | Side (seen from −x; +z is to the right) |
| Top (seen from +y; +z is down) | 3/4 view from the front right, above |

The front, side and top views are orthographic, so proportions are true. They sit on a grid in scene units with
labelled lines, so the model can read coordinates off the picture ("the ear tip is at y ≈ 0.62").

**Several objects** (up to 8) are drawn side by side. The top row shows their fronts at one scale on a shared floor, so
heights and widths compare. The bottom row shows the same objects from the front right.

Objects are drawn in plain grey clay, which shows shape better than dark or textured materials. `materials: true`
draws their own materials instead.

**The report** gives each object's size, where its base is, and its parts, with each part's type, size and position.
It also lists what the geometry checks found:

- **Loose parts**: parts whose surfaces never meet, cross, or sit inside another part. The report gives the gap and
  where the part is.
- **Holes**: open edges in a surface, for example a lathe profile that does not end at radius 0. Holes the object
  stands on, and holes another part covers, are left out.
- **Coarse curves**: a lathe profile with fewer than 16 points, or fewer than 24 segments around.
- **Flat slabs**: an extruded outline less than about a third as thick as it is wide.
- **Missing normals**, and positions that are not numbers.
- **Identical parts across objects**: two objects that differ overall but share an identical part, usually a copied
  shape that should have changed (the king and queen above).

Each problem names its part and says how to fix it.

### What it can show

- **A JavaScript module** (`.js`, `.mjs`) and the export that builds the object: a function that returns a
  `THREE.Object3D` (a `Mesh` or `Group`) or a `BufferGeometry`, or a promise of one. `calls` gives argument lists, one
  object each, for example `[["n", "w"], ["k", "w"]]`. Without `export`, the default export is used.
- **A model file**: `.glb`, `.gltf`, `.obj`, `.stl`, `.ply` or `.fbx`, opened with three.js's own loaders.

The module runs in the browser with the project's own three.js, so the objects and the viewer share one copy.
three.js is looked for in three places, in order:
1. The project's `node_modules`, where every package the project depends on is mapped through an import map, so
   imports such as `three/addons/…` or `three-bvh-csg` work.
2. The import map in the project's `index.html` (for example a CDN copy of three.js).
3. The CDN URL the module itself imports three.js from.

Limits:
- **No TypeScript.** Export the builder from a `.js` file, or build the project first and pass the built file.
- **Modules with side effects run too.** A module that creates a renderer or starts an animation when it loads should
  move its builders into a module of their own. The modelling notes ask the model to do this.
- **Very large objects are drawn but not checked.** The checks are skipped above 400,000 triangles.
- **Only models that can see images get the picture.** Other models get the text report alone, as with the browser's
  screenshots.

`view3d` is turned on and off with the browser (`callisto.browser.enabled`), and it uses the same Chrome
(`callisto.browser.executablePath`). It draws on its own browser tab, so a page the agent has open with `browser` stays
as it was.

## The modelling notes

When a request involves 3D, Callisto adds short notes on building 3D objects after the request. A request involves 3D
when either:
- its text mentions 3D work, for example "3D", three.js, WebGL, glTF, Blender, OpenSCAD, or a file such as `.stl`;
- the workspace's `package.json` depends on three.js, React Three Fiber, Babylon.js, A-Frame or PlayCanvas.

The notes cover:
- **Workflow**: look at each object with `view3d`, compare it with the real thing, and look again after each change.
  Plan the parts and their proportions before writing code.
- **Code layout**: builders go in modules without side effects. Units: the base on y = 0, the front facing +z.
- **Techniques**:
  - lathe profiles made from a smooth `SplineCurve`, closed at radius 0 at both ends;
  - bevelled, thick-enough extrusions;
  - organic forms made from overlapping primitives;
  - parts that overlap slightly instead of floating;
  - cuts made with CSG rather than painted on;
  - materials and normals.

They are added once per chat, the first time a request involves 3D, and again only after a summary has replaced that
request. They are not in the system prompt, so other chats don't pay for them. Because they are added after the
request's own message, LM Studio's cached prompt still matches. The text is in
`theia-extensions/product/src/common/modelling-guide.ts`.

After the agent writes a JavaScript or TypeScript file that builds three.js geometry, the write's result tells it to look
at the objects with `view3d` next, where other code files get "run it".
