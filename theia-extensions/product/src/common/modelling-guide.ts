/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * Craft notes for building 3D objects in code. A local model knows three.js's API but not how to make an object look
 * like the real thing: Inkling's chess pieces used the right geometry types with ten-point lathe profiles, an open-topped
 * rook, a cardboard-thin knight and a "slit" made of a dark box. These notes go with a request that involves 3D, once
 * per chat, after the request's own message (not in the system prompt, so other chats do not pay for them and
 * LM Studio's prompt cache is unaffected).
 */

export const MODELLING_GUIDE_TITLE = '[Callisto] Notes for modelling 3D objects';

export const MODELLING_GUIDE = `${MODELLING_GUIDE_TITLE} (this task involves 3D; follow them where they apply):
- Look at every object you build or change with view3d and fix what it reports. Then compare the picture with the real thing \
(silhouette, proportions, the features that make it recognisable) and change what differs. Look again after each change.
- Before writing code, list the object's parts with their proportions (for a chess king: base, stem, collar, crown, cross, \
with widths and heights). Build each part as a mesh and put them in a Group.
- Builders go in modules without side effects: export a function that returns the object (a Mesh or Group) and takes what \
varies as arguments, so that view3d and the app can both call it.
- Units: the base on y = 0, centred on x = z = 0, the front facing +z. Size everything against one reference (e.g. a board square = 1).
- Turned shapes (vases, bottles, chess pieces): LatheGeometry. Write a few control points from the bottom centre to the top \
centre, starting and ending at radius 0 so the shape is closed, and smooth them: \`new THREE.SplineCurve(points).getPoints(48)\`, \
with 48–64 segments around. A crisp edge (a base's rim) needs two points close together.
- Shapes with an outline (a horse's head, a logo, a leaf): ExtrudeGeometry from a THREE.Shape drawn with curves \
(quadraticCurveTo, bezierCurveTo), bevelled (bevelEnabled, bevelSize and bevelThickness about 5–10% of its size), and thick \
enough to look solid from the side unless it is meant to be flat. Stand it on a base.
- Organic forms (animals, heads, hands): several overlapping primitives (spheres, capsules, cones) scaled and rotated, or a \
sphere whose vertices you move; check the silhouette from the front and from the side.
- Parts must touch: sink each part slightly (1–2% of its size) into the one it sits on. Floating or barely touching parts look broken.
- Cuts, slots and holes: subtract with CSG (three-bvh-csg) when the project has it, or shape the gap into the profile or \
outline. A dark box on the surface does not look like a cut.
- Surfaces: MeshStandardMaterial with roughness 0.3–0.7; computeVertexNormals() after moving vertices. Share geometries and \
materials between copies.`;

/** Packages that make a workspace a 3D project. */
export const THREE_D_PACKAGES = [
    'three', '@react-three/fiber', '@react-three/drei', 'three-stdlib', 'babylonjs', '@babylonjs/core', 'aframe', 'playcanvas'
];

const THREE_D_WORDS = new RegExp('\\b(3-?d|three\\.?js|webgl|webgpu|gltf|glb|lathe|babylon(?:js)?|react-three|r3f|blender|openscad|cadquery|'
    + 'low[- ]poly|voxels?)\\b|\\.(?:stl|obj|glb|gltf|fbx|ply)\\b', 'i');

/** Whether a request's text is about 3D work. */
export function mentions3d(text: string): boolean {
    return THREE_D_WORDS.test(text);
}

/** Whether a source file builds 3D geometry with three.js, after which the agent is pointed at view3d. */
export function buildsThreeGeometry(source: string): boolean {
    return /from\s+['"]three['"]|require\(\s*['"]three['"]\s*\)/.test(source)
        && /\b\w*(Geometry|Mesh)\s*\(|\bShape\s*\(/.test(source);
}
