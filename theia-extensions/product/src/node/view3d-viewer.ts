/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/*
 * The page behind the `view3d` tool. It runs in the agent's headless Chrome with the project's own three.js (through an
 * import map), loads the object the agent built, checks its geometry, and draws it from several sides into one image.
 *
 * Kept as a string and served as a module rather than compiled: the backend bundler rewrites named functions (see
 * `inPage` in browser-service.ts) and the page needs `import * as THREE from 'three'`, which only the import map
 * resolves. So: no backticks and no dollar-brace in the source below.
 */

/** Styles of the viewer page: a neutral backdrop the object is drawn on, and the labels laid over it. */
export const VIEW3D_CSS = String.raw`
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: linear-gradient(#9aa1aa, #7d848d); font: 13px/1.25 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #15181c; }
canvas { position: absolute; left: 0; top: 0; }
.overlay { position: absolute; inset: 0; pointer-events: none; }
.cell { position: absolute; box-sizing: border-box; border: 1px solid rgba(20, 24, 28, 0.35); }
.title { position: absolute; left: 6px; top: 5px; right: 6px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title span { background: rgba(255, 255, 255, 0.72); padding: 1px 5px; border-radius: 3px; }
.tick { position: absolute; font-size: 11px; color: #22262b; background: rgba(255, 255, 255, 0.55); padding: 0 3px; border-radius: 2px; white-space: nowrap; }
.axis { position: absolute; font-size: 12px; font-weight: 700; color: #101316; }
`;

/** The viewer module, served at /__callisto/view3d.js. Reads its job from `window.__callistoView3d.spec`. */
export const VIEW3D_SCRIPT = String.raw`
import * as THREE from 'three';

const host = window.__callistoView3d;
const spec = host.spec;
const REVISION = parseInt(THREE.REVISION, 10) || 0;
// three r155 switched to physically based light units: older versions need intensities divided by pi to look the same.
const LIGHT = REVISION < 155 ? 1 / Math.PI : 1;
const CLAY_COLOR = 0xd9d3c7;
const MAX_PARTS_LISTED = 12;
const HEAVY_TRIANGLES = 400000;

class UserError extends Error {}

main().then(function (result) {
    host.result = result;
}, function (error) {
    host.result = error instanceof UserError ? { error: error.message } : { error: describeError(error), thrown: true };
});

async function main() {
    const items = await loadItems();
    const clay = new THREE.MeshStandardMaterial({ color: CLAY_COLOR, roughness: 0.72, metalness: 0 });
    let largest = 0;
    for (const item of items) {
        if (!spec.materials) {
            useClay(item.object, clay);
        }
        item.object.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(item.object);
        largest = Math.max(largest, box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length());
    }
    // One precision for all objects, from the largest, so that their numbers compare.
    const digits = Math.min(5, Math.max(0, 2 - Math.floor(Math.log10(largest || 1))));
    const analyses = items.map(function (item) { return analyze(item.object, digits); });
    const notes = compare(items, analyses);
    const draw = createView(items, analyses);
    draw();
    if (spec.materials) {
        // Image textures arrive after the first frame.
        await sleep(700);
        draw();
    }
    await frames(2);
    return {
        revision: THREE.REVISION,
        objects: items.map(function (item, index) { return Object.assign({ label: item.label }, analyses[index].report); }),
        notes: notes
    };
}

// ------------------------------------------------------------------ loading

async function loadItems() {
    if (spec.kind === 'model') {
        return [{ label: spec.name, object: await loadModel(spec.url, spec.ext) }];
    }
    let module;
    try {
        module = await import(spec.url);
    } catch (error) {
        throw annotate(error, 'Loading ' + spec.name, 'failed');
    }
    const names = Object.keys(module);
    let name = spec.exportName;
    let value;
    if (name) {
        if (!(name in module)) {
            throw new UserError(spec.name + ' has no export "' + name + '". Its exports: ' + listNames(names) + '.');
        }
        value = module[name];
    } else if ('default' in module) {
        name = 'default';
        value = module.default;
    } else {
        const showable = names.filter(function (key) { return typeof module[key] === 'function' || isShowable(module[key]); });
        if (showable.length !== 1) {
            throw new UserError('Say which export of ' + spec.name + ' builds the object, with "export". Its exports: ' + listNames(names) + '.');
        }
        name = showable[0];
        value = module[name];
    }
    if (typeof value !== 'function') {
        if (spec.calls && spec.calls.length > 0) {
            throw new UserError('"' + name + '" is not a function, so "calls" cannot be used with it.');
        }
        return [{ label: name, object: toObject(await value, name) }];
    }
    const calls = spec.calls && spec.calls.length > 0 ? spec.calls : [[]];
    const items = [];
    for (const args of calls) {
        const list = Array.isArray(args) ? args : [args];
        const label = name + '(' + list.map(function (arg) { return JSON.stringify(arg); }).join(', ') + ')';
        let made;
        try {
            made = value.apply(null, list);
        } catch (error) {
            if (error instanceof TypeError && /class constructor/i.test(error.message)) {
                made = Reflect.construct(value, list);
            } else {
                throw annotate(error, label);
            }
        }
        try {
            made = await made;
        } catch (error) {
            throw annotate(error, label);
        }
        items.push({ label: label, object: toObject(made, label) });
    }
    return items;
}

async function loadModel(url, ext) {
    const loaders = {
        '.glb': 'GLTFLoader', '.gltf': 'GLTFLoader', '.obj': 'OBJLoader', '.stl': 'STLLoader', '.ply': 'PLYLoader', '.fbx': 'FBXLoader'
    };
    const loaderName = loaders[ext];
    const module = await import('three/addons/loaders/' + loaderName + '.js');
    const loader = new module[loaderName]();
    const loaded = await loader.loadAsync(url);
    if (loaded && loaded.isBufferGeometry) {
        if (!loaded.attributes.normal) {
            loaded.computeVertexNormals();
        }
        return new THREE.Mesh(loaded, new THREE.MeshStandardMaterial({ color: CLAY_COLOR, roughness: 0.72 }));
    }
    return toObject(loaded, spec.name);
}

function toObject(value, label) {
    if (value && value.isObject3D) {
        return value;
    }
    if (value && value.isBufferGeometry) {
        return new THREE.Mesh(value, new THREE.MeshStandardMaterial({ color: CLAY_COLOR, roughness: 0.72 }));
    }
    if (value && value.scene && value.scene.isObject3D) {
        return value.scene;
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isShowable)) {
        const group = new THREE.Group();
        value.forEach(function (entry) { group.add(toObject(entry, label)); });
        return group;
    }
    throw new UserError(label + ' returned ' + describeValue(value) + ', not a THREE.Object3D (a Mesh or Group) or a BufferGeometry. '
        + 'Return the object it builds.');
}

function isShowable(value) {
    return !!value && (value.isObject3D || value.isBufferGeometry || (value.scene && value.scene.isObject3D));
}

function useClay(root, clay) {
    root.traverse(function (object) {
        if (object.isMesh) {
            object.material = Array.isArray(object.material) ? object.material.map(function () { return clay; }) : clay;
        }
    });
}

// ------------------------------------------------------------------ checks

function analyze(root, digits) {
    const box = new THREE.Box3().setFromObject(root);
    const parts = collectParts(root);
    if (box.isEmpty() || parts.length === 0) {
        return {
            box: box, parts: parts, signatures: [], digits: digits,
            report: {
                sizeText: '0', minText: '-', centerText: '-', bottomText: '-', parts: 0, triangles: 0, partTypes: '', partList: [],
                partsOmitted: 0, warnings: [{ text: 'It has no visible meshes, so there is nothing to see.' }]
            }
        };
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const diag = size.length() || 1;
    const f = function (value) { return formatNumber(value, digits); };
    const tol = diag * 0.004;
    const warnings = [];
    let triangles = 0;
    parts.forEach(function (part) { triangles += part.triCount; });

    for (const part of parts) {
        const name = partName(part);
        const partSize = part.box.getSize(new THREE.Vector3());
        if (part.invalid) {
            warnings.push({ text: name + ' has vertex positions that are not numbers (NaN or Infinity).', fix: 'Check the maths that builds it.' });
        }
        if (!part.hasNormals && part.triCount > 0) {
            warnings.push({ text: name + ' has no normals, so it renders black or flat.', fix: 'Call geometry.computeVertexNormals() after building it.' });
        }
        if (part.type === 'LatheGeometry' && part.params && part.params.points) {
            const count = part.params.points.length;
            if (count < 16) {
                warnings.push({
                    text: name + ': its profile has only ' + count + ' points, so its outline is ' + (count - 1)
                        + ' straight segments with sharp corners (rings and kinks in the views).',
                    fix: 'Build lathe profiles from a smooth curve with more points, e.g. new THREE.SplineCurve(controlPoints).getPoints(48).'
                });
            }
            if (part.params.segments && part.params.segments < 24) {
                warnings.push({ text: name + ' has only ' + part.params.segments + ' segments around, so it looks faceted.', fix: 'Use 48 or more.' });
            }
        }
        if (part.type === 'ExtrudeGeometry') {
            const dims = [partSize.x, partSize.y, partSize.z].sort(function (a, b) { return a - b; });
            if (dims[0] < dims[1] * 0.35) {
                warnings.push({
                    text: name + ' is a flat slab: ' + f(dims[0]) + ' thick against an outline of ' + f(dims[1]) + ' × ' + f(dims[2])
                        + ', so from the side it looks like a cut-out.',
                    fix: 'If it should look solid, make it thicker, bevel it, or build it from several shapes.'
                });
            }
        }
    }

    if (triangles <= HEAVY_TRIANGLES) {
        for (const part of parts) {
            for (const hole of openings(part, parts, box, size, diag, tol)) {
                const partSize = part.box.getSize(new THREE.Vector3());
                const where = hole.center.y >= part.box.max.y - partSize.y * 0.05 ? ' at the top'
                    : hole.center.y <= part.box.min.y + partSize.y * 0.05 ? ' at the bottom' : '';
                const fix = part.type === 'LatheGeometry'
                    ? 'End the lathe profile at radius 0 (x = 0) so it closes, or cap it with another part.'
                    : 'Close the surface, or cover the hole with another part.';
                warnings.push({
                    text: partName(part) + ' is open' + where + ': a hole ' + f(hole.extent) + ' across at ' + point(hole.center, f)
                        + ' shows that it is a hollow shell.',
                    fix: fix
                });
            }
        }
        warnings.push.apply(warnings, looseParts(parts, tol, f));
    } else {
        warnings.push({ text: 'It has ' + triangles + ' triangles, too many to check for loose parts and holes.', fix: 'Fewer would also draw faster.' });
    }

    const typeCounts = new Map();
    parts.forEach(function (part) { typeCounts.set(part.type, (typeCounts.get(part.type) || 0) + 1); });
    const partTypes = Array.from(typeCounts.entries()).map(function (entry) { return entry[1] + ' ' + entry[0]; }).join(', ');
    const partList = parts.slice(0, MAX_PARTS_LISTED).map(function (part) {
        const partSize = part.box.getSize(new THREE.Vector3());
        return 'part ' + part.index + ' ' + part.type + (part.name ? ' "' + part.name + '"' : '') + ' ' + f(partSize.x) + '×' + f(partSize.y)
            + '×' + f(partSize.z) + ' at ' + point(part.box.getCenter(new THREE.Vector3()), f);
    });
    return {
        box: box, parts: parts, digits: digits,
        signatures: parts.map(signatureOf),
        report: {
            sizeText: f(size.x) + ' wide (x) × ' + f(size.y) + ' tall (y) × ' + f(size.z) + ' deep (z)',
            bottomText: f(box.min.y),
            centerText: 'x ' + f(center.x) + ', z ' + f(center.z),
            parts: parts.length,
            triangles: triangles,
            partTypes: partTypes,
            partList: partList,
            partsOmitted: Math.max(0, parts.length - MAX_PARTS_LISTED),
            warnings: warnings
        }
    };
}

function collectParts(root) {
    const parts = [];
    root.traverse(function (object) {
        const geometry = object.geometry;
        if (!object.isMesh || !geometry || !geometry.attributes || !geometry.attributes.position || !visibleInTree(object)) {
            return;
        }
        parts.push(makePart(object, parts.length + 1));
    });
    return parts;
}

function visibleInTree(object) {
    for (let current = object; current; current = current.parent) {
        if (current.visible === false) {
            return false;
        }
    }
    return true;
}

function makePart(mesh, index) {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const count = position.count;
    const world = new Float32Array(count * 3);
    const vector = new THREE.Vector3();
    const box = new THREE.Box3();
    let invalid = false;
    for (let i = 0; i < count; i++) {
        vector.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        if (!isFinite(vector.x) || !isFinite(vector.y) || !isFinite(vector.z)) {
            invalid = true;
            vector.set(0, 0, 0);
        } else {
            box.expandByPoint(vector);
        }
        world[i * 3] = vector.x;
        world[i * 3 + 1] = vector.y;
        world[i * 3 + 2] = vector.z;
    }
    let tris;
    if (geometry.index) {
        tris = geometry.index.array;
    } else {
        tris = new Uint32Array(count - (count % 3));
        for (let i = 0; i < tris.length; i++) {
            tris[i] = i;
        }
    }
    return {
        index: index, mesh: mesh, name: mesh.name || '', type: geometry.type || 'BufferGeometry', params: geometry.parameters,
        world: world, tris: tris, triCount: Math.floor(tris.length / 3), vertexCount: count, box: box, invalid: invalid,
        hasNormals: !!geometry.attributes.normal, geometry: geometry
    };
}

function partName(part) {
    return 'part ' + part.index + ' (' + part.type + (part.name ? ' "' + part.name + '"' : '') + ')';
}

/** Holes in a part's surface: loops of edges that only one triangle uses, ignoring tiny ones, ones it stands on, and covered ones. */
function openings(part, parts, box, size, diag, tol) {
    const n = part.vertexCount;
    const partSize = part.box.getSize(new THREE.Vector3());
    if (n === 0 || part.triCount === 0 || Math.min(partSize.x, partSize.y, partSize.z) < diag * 1e-4) {
        return [];
    }
    const eps = diag * 1e-5;
    const idByKey = new Map();
    const ids = new Int32Array(n);
    const firstOf = [];
    const w = part.world;
    for (let i = 0; i < n; i++) {
        const key = Math.round(w[i * 3] / eps) + ',' + Math.round(w[i * 3 + 1] / eps) + ',' + Math.round(w[i * 3 + 2] / eps);
        let id = idByKey.get(key);
        if (id === undefined) {
            id = firstOf.length;
            idByKey.set(key, id);
            firstOf.push(i);
        }
        ids[i] = id;
    }
    const m = firstOf.length;
    const edges = new Map();
    const count = function (a, b) {
        const key = a < b ? a * m + b : b * m + a;
        edges.set(key, (edges.get(key) || 0) + 1);
    };
    const t = part.tris;
    for (let i = 0; i + 2 < t.length; i += 3) {
        const a = ids[t[i]];
        const b = ids[t[i + 1]];
        const c = ids[t[i + 2]];
        if (a === b || b === c || a === c) {
            continue;
        }
        count(a, b);
        count(b, c);
        count(c, a);
    }
    const parent = new Map();
    const find = function (x) {
        while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x)));
            x = parent.get(x);
        }
        return x;
    };
    edges.forEach(function (uses, key) {
        if (uses !== 1) {
            return;
        }
        const a = Math.floor(key / m);
        const b = key % m;
        if (!parent.has(a)) { parent.set(a, a); }
        if (!parent.has(b)) { parent.set(b, b); }
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) {
            parent.set(ra, rb);
        }
    });
    const loops = new Map();
    const vector = new THREE.Vector3();
    parent.forEach(function (unused, v) {
        const root = find(v);
        let loop = loops.get(root);
        if (!loop) {
            loop = new THREE.Box3();
            loops.set(root, loop);
        }
        loop.expandByPoint(vector.fromArray(w, firstOf[v] * 3));
    });
    const holes = [];
    loops.forEach(function (loop) {
        const loopSize = loop.getSize(new THREE.Vector3());
        const extent = Math.max(loopSize.x, loopSize.y, loopSize.z);
        if (extent < diag * 0.02 || loop.max.y <= box.min.y + size.y * 0.01 + eps) {
            return;
        }
        const center = loop.getCenter(new THREE.Vector3());
        const covered = parts.some(function (other) {
            return other !== part && other.box.clone().expandByScalar(tol).containsPoint(center);
        });
        if (!covered) {
            holes.push({ center: center, extent: extent });
        }
    });
    return holes;
}

/** Parts that do not touch the rest: groups of parts whose surfaces never meet, cross, or sit inside one another. */
function looseParts(parts, tol, f) {
    if (parts.length < 2) {
        return [];
    }
    const parent = parts.map(function (unused, index) { return index; });
    const find = function (x) {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
            if (find(i) === find(j) || boxGap(parts[i].box, parts[j].box) > tol) {
                continue;
            }
            if (touches(parts[i], parts[j], tol) || touches(parts[j], parts[i], tol)) {
                parent[find(i)] = find(j);
            }
        }
    }
    const groups = new Map();
    parts.forEach(function (part, index) {
        const root = find(index);
        if (!groups.has(root)) {
            groups.set(root, []);
        }
        groups.get(root).push(part);
    });
    if (groups.size < 2) {
        return [];
    }
    const list = Array.from(groups.values()).map(function (members) {
        const groupBox = new THREE.Box3();
        let volume = 0;
        members.forEach(function (part) {
            groupBox.union(part.box);
            const s = part.box.getSize(new THREE.Vector3());
            volume += s.x * s.y * s.z;
        });
        return { members: members, box: groupBox, volume: volume };
    });
    list.sort(function (a, b) { return b.volume - a.volume; });
    const main = list[0];
    const rest = list.slice(1);
    if (rest.length > 8) {
        return [{
            text: 'It is ' + list.length + ' separate pieces that do not touch each other.',
            fix: 'If it is meant to be one object, its parts must meet or overlap slightly.'
        }];
    }
    // Loose groups that are the same kind of single part (six battlements, eight balls) are reported together.
    const similar = new Map();
    rest.forEach(function (group) {
        const first = group.members[0];
        const s = first.box.getSize(new THREE.Vector3());
        const key = group.members.length === 1 ? first.type + ' ' + f(s.x) + '×' + f(s.y) + '×' + f(s.z) : 'group ' + similar.size;
        if (!similar.has(key)) {
            similar.set(key, []);
        }
        similar.get(key).push(group);
    });
    const warnings = [];
    similar.forEach(function (groups, key) {
        const gaps = groups.map(function (group) { return boxGap(group.box, main.box); });
        const minGap = Math.min.apply(null, gaps);
        const maxGap = Math.max.apply(null, gaps);
        const where = relation(groups[0].box, main.box, tol);
        const gapText = maxGap > tol
            ? 'gap ' + (f(minGap) === f(maxGap) ? f(maxGap) : f(minGap) + '–' + f(maxGap)) + (where ? ', ' + where + ' it' : '')
            : 'close to it, but no surfaces meet';
        let subject;
        let single = false;
        if (groups.length === 1 && groups[0].members.length === 1) {
            const part = groups[0].members[0];
            subject = partName(part) + ' at ' + point(part.box.getCenter(new THREE.Vector3()), f) + ' does';
            single = true;
        } else if (groups.every(function (group) { return group.members.length === 1; })) {
            subject = groups.length + ' parts (' + key + ': ' + numberList(groups.map(function (group) { return group.members[0].index; }))
                + ') do';
        } else {
            const members = [].concat.apply([], groups.map(function (group) { return group.members; }));
            subject = 'Parts ' + numberList(members.map(function (part) { return part.index; })) + ' do';
        }
        warnings.push({
            text: capitalize(subject) + ' not touch the rest of the object (' + gapText + ').',
            fix: 'Move or resize ' + (single ? 'it' : 'them') + ' so the parts overlap slightly; floating pieces look broken.'
        });
    });
    return warnings;
}

function relation(box, main, tol) {
    if (box.min.y >= main.max.y - tol) { return 'above'; }
    if (box.max.y <= main.min.y + tol) { return 'below'; }
    return 'beside';
}

function boxGap(a, b) {
    const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
    const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
    const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Whether a's surface reaches b's: a vertex of a on or near b's surface, an edge of a through it, or a inside b. */
function touches(a, b, tol) {
    if (a.triCount === 0 || b.triCount === 0) {
        return false;
    }
    const grid = gridOf(b);
    const region = b.box.clone().expandByScalar(tol);
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const closest = new THREE.Vector3();
    const triangle = new THREE.Triangle();
    const tolSq = tol * tol;
    const vertexStep = Math.max(1, Math.ceil(a.vertexCount / 4000));
    let insideCandidate = -1;
    for (let i = 0; i < a.vertexCount; i += vertexStep) {
        p.fromArray(a.world, i * 3);
        if (!region.containsPoint(p)) {
            continue;
        }
        if (insideCandidate < 0) {
            insideCandidate = i;
        }
        const near = nearTriangles(grid, p.x - tol, p.y - tol, p.z - tol, p.x + tol, p.y + tol, p.z + tol);
        for (const k of near) {
            setTriangle(triangle, b, k);
            triangle.closestPointToPoint(p, closest);
            if (closest.distanceToSquared(p) <= tolSq) {
                return true;
            }
        }
    }
    const ray = new THREE.Ray();
    const hit = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const edgeBox = new THREE.Box3();
    const triangleStep = Math.max(1, Math.ceil(a.triCount / 3000));
    const pairs = [[0, 1], [1, 2], [2, 0]];
    for (let k = 0; k < a.triCount; k += triangleStep) {
        for (const pair of pairs) {
            p.fromArray(a.world, a.tris[k * 3 + pair[0]] * 3);
            q.fromArray(a.world, a.tris[k * 3 + pair[1]] * 3);
            edgeBox.makeEmpty().expandByPoint(p).expandByPoint(q);
            if (!edgeBox.intersectsBox(region)) {
                continue;
            }
            const length = p.distanceTo(q);
            if (length === 0) {
                continue;
            }
            ray.set(p, direction.subVectors(q, p).divideScalar(length));
            const near = nearTriangles(grid, edgeBox.min.x, edgeBox.min.y, edgeBox.min.z, edgeBox.max.x, edgeBox.max.y, edgeBox.max.z);
            for (const index of near) {
                setTriangle(triangle, b, index);
                if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit) && hit.distanceTo(p) <= length) {
                    return true;
                }
            }
        }
    }
    if (insideCandidate >= 0 && b.triCount <= 60000) {
        p.fromArray(a.world, insideCandidate * 3);
        return isInside(b, p);
    }
    return false;
}

function isInside(part, p) {
    const ray = new THREE.Ray(p.clone(), new THREE.Vector3(0.5771, 0.5779, 0.5767).normalize());
    const triangle = new THREE.Triangle();
    const hit = new THREE.Vector3();
    let hits = 0;
    for (let k = 0; k < part.triCount; k++) {
        setTriangle(triangle, part, k);
        if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) {
            hits++;
        }
    }
    return hits % 2 === 1;
}

function setTriangle(triangle, part, k) {
    triangle.a.fromArray(part.world, part.tris[k * 3] * 3);
    triangle.b.fromArray(part.world, part.tris[k * 3 + 1] * 3);
    triangle.c.fromArray(part.world, part.tris[k * 3 + 2] * 3);
}

/** A uniform grid over a part's triangles, so that "which triangles are near here" does not scan them all. */
function gridOf(part) {
    if (part.grid) {
        return part.grid;
    }
    const size = part.box.getSize(new THREE.Vector3());
    const cell = (Math.max(size.x, size.y, size.z) || 1) / 24;
    const nx = Math.max(1, Math.ceil(size.x / cell) + 1);
    const ny = Math.max(1, Math.ceil(size.y / cell) + 1);
    const nz = Math.max(1, Math.ceil(size.z / cell) + 1);
    const min = part.box.min.clone();
    const cells = new Map();
    const w = part.world;
    const t = part.tris;
    for (let k = 0; k < part.triCount; k++) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let v = 0; v < 3; v++) {
            const o = t[k * 3 + v] * 3;
            x0 = Math.min(x0, w[o]); x1 = Math.max(x1, w[o]);
            y0 = Math.min(y0, w[o + 1]); y1 = Math.max(y1, w[o + 1]);
            z0 = Math.min(z0, w[o + 2]); z1 = Math.max(z1, w[o + 2]);
        }
        const i0 = cellOf(x0, min.x, cell, nx), i1 = cellOf(x1, min.x, cell, nx);
        const j0 = cellOf(y0, min.y, cell, ny), j1 = cellOf(y1, min.y, cell, ny);
        const l0 = cellOf(z0, min.z, cell, nz), l1 = cellOf(z1, min.z, cell, nz);
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                for (let l = l0; l <= l1; l++) {
                    const key = i + nx * (j + ny * l);
                    let list = cells.get(key);
                    if (!list) {
                        list = [];
                        cells.set(key, list);
                    }
                    list.push(k);
                }
            }
        }
    }
    part.grid = { cell: cell, nx: nx, ny: ny, nz: nz, min: min, cells: cells, stamp: new Int32Array(part.triCount), mark: 0 };
    return part.grid;
}

function cellOf(value, min, cell, n) {
    return Math.min(n - 1, Math.max(0, Math.floor((value - min) / cell)));
}

function nearTriangles(grid, x0, y0, z0, x1, y1, z1) {
    grid.mark++;
    const found = [];
    const i0 = cellOf(x0, grid.min.x, grid.cell, grid.nx), i1 = cellOf(x1, grid.min.x, grid.cell, grid.nx);
    const j0 = cellOf(y0, grid.min.y, grid.cell, grid.ny), j1 = cellOf(y1, grid.min.y, grid.cell, grid.ny);
    const l0 = cellOf(z0, grid.min.z, grid.cell, grid.nz), l1 = cellOf(z1, grid.min.z, grid.cell, grid.nz);
    for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
            for (let l = l0; l <= l1; l++) {
                const list = grid.cells.get(i + grid.nx * (j + grid.ny * l));
                if (!list) {
                    continue;
                }
                for (const k of list) {
                    if (grid.stamp[k] !== grid.mark) {
                        grid.stamp[k] = grid.mark;
                        found.push(k);
                    }
                }
            }
        }
    }
    return found;
}

function signatureOf(part) {
    const position = part.geometry.attributes.position;
    let sum = 0;
    let squares = 0;
    for (let i = 0; i < position.count; i++) {
        const value = position.getX(i) * 1.1 + position.getY(i) * 2.3 + position.getZ(i) * 3.7;
        sum += value;
        squares += value * value;
    }
    return { key: part.type + ':' + position.count + ':' + sum.toFixed(4) + ':' + squares.toFixed(4), type: part.type, vertices: position.count };
}

/** Objects that share an identical part although they differ as a whole: usually a copied shape that should have changed. */
function compare(items, analyses) {
    if (items.length < 2) {
        return [];
    }
    const wholes = analyses.map(function (analysis) {
        return analysis.signatures.map(function (s) { return s.key; }).sort().join('|');
    });
    const shared = new Map();
    analyses.forEach(function (analysis, index) {
        analysis.signatures.forEach(function (signature) {
            if (signature.vertices < 64) {
                return;
            }
            let entry = shared.get(signature.key);
            if (!entry) {
                entry = { type: signature.type, vertices: signature.vertices, objects: [] };
                shared.set(signature.key, entry);
            }
            if (entry.objects.indexOf(index) < 0) {
                entry.objects.push(index);
            }
        });
    });
    const notes = [];
    shared.forEach(function (entry) {
        const distinct = new Set(entry.objects.map(function (index) { return wholes[index]; }));
        if (entry.objects.length < 2 || distinct.size < 2) {
            return;
        }
        notes.push('Objects ' + numberList(entry.objects.map(function (index) { return index + 1; })) + ' ('
            + entry.objects.map(function (index) { return items[index].label; }).join(', ') + ') share an identical ' + entry.type + ' ('
            + entry.vertices + ' vertices). If they should look different, give each its own shape.');
    });
    return notes;
}

// ------------------------------------------------------------------ drawing

const ORTHO = {
    front: { title: 'Front (seen from +z)', dir: [0, 0, 1], up: [0, 1, 0], right: [0, 1], vertical: [1, 1], depth: 2 },
    side: { title: 'Side (seen from −x; +z is to the right)', dir: [-1, 0, 0], up: [0, 1, 0], right: [2, 1], vertical: [1, 1], depth: 0 },
    top: { title: 'Top (seen from +y; +z is down)', dir: [0, 1, 0], up: [0, 0, -1], right: [0, 1], vertical: [2, -1], depth: 1 }
};
const AXES = ['x', 'y', 'z'];
const PERSPECTIVE_DIRECTION = new THREE.Vector3(0.9, 0.75, 1.6).normalize();

function createView(items, analyses) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(true);
    document.body.appendChild(renderer.domElement);
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    document.body.appendChild(overlay);

    const stages = items.map(function (item) { return stage(item); });
    const views = [];
    if (items.length === 1) {
        const w = Math.floor(W / 2);
        const h = Math.floor(H / 2);
        const a = analyses[0];
        views.push(orthoView(stages[0], a, ORTHO.front, { x: 0, y: 0, w: w, h: h }, overlay, ORTHO.front.title));
        views.push(orthoView(stages[0], a, ORTHO.side, { x: w, y: 0, w: W - w, h: h }, overlay, ORTHO.side.title));
        views.push(orthoView(stages[0], a, ORTHO.top, { x: 0, y: h, w: w, h: H - h }, overlay, ORTHO.top.title));
        views.push(perspectiveView(stages[0], a, { x: w, y: h, w: W - w, h: H - h }, overlay, '3/4 view (from the front right, above)'));
    } else {
        const n = items.length;
        const w = Math.floor(W / n);
        const h = Math.floor(H / 2);
        const cells = items.map(function (item, index) {
            return { x: index * w, y: 0, w: index === n - 1 ? W - index * w : w, h: h };
        });
        const frame = lineupFrame(analyses, w, h);
        items.forEach(function (item, index) {
            views.push(orthoView(stages[index], analyses[index], ORTHO.front, cells[index], overlay, (index + 1) + '  ' + item.label, frame, index === 0));
        });
        const distance = Math.max.apply(null, analyses.map(function (a) { return fitDistance(a.box, w, H - h); }));
        items.forEach(function (item, index) {
            const cell = { x: cells[index].x, y: h, w: cells[index].w, h: H - h };
            const size = analyses[index].box.getSize(new THREE.Vector3());
            const f = function (value) { return formatNumber(value, analyses[index].digits); };
            views.push(perspectiveView(stages[index], analyses[index], cell, overlay, (index + 1) + '  ' + f(size.x) + ' × ' + f(size.y) + ' × ' + f(size.z), distance));
        });
    }
    return function () {
        for (const view of views) {
            renderer.setViewport(view.cell.x, H - view.cell.y - view.cell.h, view.cell.w, view.cell.h);
            renderer.setScissor(view.cell.x, H - view.cell.y - view.cell.h, view.cell.w, view.cell.h);
            aimLights(view.stage, view.camera, view.center, view.diag);
            view.extras.forEach(function (extra) { view.stage.scene.add(extra); });
            renderer.render(view.stage.scene, view.camera);
            view.extras.forEach(function (extra) { view.stage.scene.remove(extra); });
        }
    };
}

function stage(item) {
    const scene = new THREE.Scene();
    scene.add(item.object);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3c3832, 1.15 * LIGHT));
    const key = new THREE.DirectionalLight(0xffffff, 2.1 * LIGHT);
    const fill = new THREE.DirectionalLight(0xdde6ff, 0.75 * LIGHT);
    scene.add(key, key.target, fill, fill.target);
    return { scene: scene, key: key, fill: fill };
}

function aimLights(stage, camera, center, diag) {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    stage.key.position.copy(center).addScaledVector(forward, -diag * 3).addScaledVector(up, diag * 2.4).addScaledVector(right, -diag * 1.6);
    stage.fill.position.copy(center).addScaledVector(forward, -diag * 3).addScaledVector(right, diag * 2.5).addScaledVector(up, -diag * 0.4);
    stage.key.target.position.copy(center);
    stage.fill.target.position.copy(center);
    [stage.key, stage.key.target, stage.fill, stage.fill.target].forEach(function (object) { object.updateMatrixWorld(); });
}

/** One frame for a row of front views: the same scale for every object, and a shared floor, so heights compare. */
function lineupFrame(analyses, w, h) {
    let bottom = Infinity;
    let top = -Infinity;
    let widest = 0;
    analyses.forEach(function (a) {
        bottom = Math.min(bottom, a.box.min.y);
        top = Math.max(top, a.box.max.y);
        const size = a.box.getSize(new THREE.Vector3());
        widest = Math.max(widest, size.x);
    });
    const height = Math.max(top - bottom, 1e-6);
    const unit = Math.max(widest * 1.3 / w, height * 1.35 / h);
    const t0 = bottom - (unit * h - height) * 0.42;
    return { unit: unit, t0: t0, t1: t0 + unit * h };
}

function orthoView(stage, analysis, def, cell, overlay, title, frame, ticksOnLeft) {
    const box = analysis.box;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const diag = size.length() || 1;
    const c = center.toArray();
    const s = size.toArray();
    const sc = c[def.right[0]] * def.right[1];
    let unit;
    let t0;
    let t1;
    if (frame) {
        unit = frame.unit;
        t0 = frame.t0;
        t1 = frame.t1;
    } else {
        unit = Math.max(s[def.right[0]] * 1.32 / cell.w, s[def.vertical[0]] * 1.32 / cell.h, 1e-9);
        const tc = c[def.vertical[0]] * def.vertical[1];
        t0 = tc - unit * cell.h / 2;
        t1 = tc + unit * cell.h / 2;
    }
    const s0 = sc - unit * cell.w / 2;
    const s1 = sc + unit * cell.w / 2;
    const camera = new THREE.OrthographicCamera(-(s1 - s0) / 2, (s1 - s0) / 2, (t1 - t0) / 2, -(t1 - t0) / 2, diag * 0.05, diag * 10);
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    setAxis(position, def.right[0], ((s0 + s1) / 2) * def.right[1]);
    setAxis(position, def.vertical[0], ((t0 + t1) / 2) * def.vertical[1]);
    setAxis(position, def.depth, c[def.depth] + def.dir[def.depth] * diag * 2);
    target.copy(position);
    setAxis(target, def.depth, c[def.depth]);
    camera.up.set(def.up[0], def.up[1], def.up[2]);
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateMatrixWorld();

    // A grid in scene units behind the object, labelled along the bottom and left edges.
    const step = niceStep(unit * 46);
    const behind = c[def.depth] - def.dir[def.depth] * (s[def.depth] / 2 + diag * 0.05);
    const minor = [];
    const axes = [];
    const point = function (sv, tv) {
        const v = new THREE.Vector3();
        setAxis(v, def.right[0], sv * def.right[1]);
        setAxis(v, def.vertical[0], tv * def.vertical[1]);
        setAxis(v, def.depth, behind);
        return v;
    };
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    const sValues = [];
    const tValues = [];
    for (let v = Math.ceil(s0 / step) * step; v <= s1; v += step) {
        sValues.push(v);
        (Math.abs(v) < step / 2 ? axes : minor).push(point(v, t0), point(v, t1));
    }
    for (let v = Math.ceil(t0 / step) * step; v <= t1; v += step) {
        tValues.push(v);
        (Math.abs(v) < step / 2 ? axes : minor).push(point(s0, v), point(s1, v));
    }
    const extras = [];
    if (minor.length) {
        extras.push(lines(minor, 0x4d535b, 0.32));
    }
    if (axes.length) {
        extras.push(lines(axes, 0x1f2328, 0.75));
    }

    const element = cellElement(overlay, cell, title);
    const label = function (text, x, y, className) {
        const tick = document.createElement('div');
        tick.className = className || 'tick';
        tick.textContent = text;
        tick.style.left = x + 'px';
        tick.style.top = y + 'px';
        element.appendChild(tick);
        return tick;
    };
    let lastX = -Infinity;
    if (cell.w >= 300 || !frame) {
        sValues.forEach(function (v) {
            const x = (v - s0) / (s1 - s0) * cell.w;
            if (x - lastX < 34 || x < 14 || x > cell.w - 30) {
                return;
            }
            lastX = x;
            label(formatNumber(v * def.right[1], decimals), x - 10, cell.h - 18);
        });
    }
    if (!frame || ticksOnLeft) {
        let lastY = Infinity;
        tValues.forEach(function (v) {
            const y = (t1 - v) / (t1 - t0) * cell.h;
            if (lastY - y < 22 || y < 46 || y > cell.h - 26) {
                return;
            }
            lastY = y;
            label(formatNumber(v * def.vertical[1], decimals), 4, y - 8);
        });
    }
    label(AXES[def.right[0]] + ' →', cell.w - 30, cell.h - 36, 'axis');
    label(AXES[def.vertical[0]] + (def.vertical[1] > 0 ? ' ↑' : ' ↓'), 6, 26, 'axis');
    return { stage: stage, camera: camera, cell: cell, extras: extras, center: center, diag: diag };
}

function perspectiveView(stage, analysis, cell, overlay, title, distance) {
    const box = analysis.box;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const diag = size.length() || 1;
    const camera = new THREE.PerspectiveCamera(30, cell.w / cell.h, diag * 0.01, diag * 100);
    const d = distance || fitDistance(box, cell.w, cell.h);
    camera.near = d * 0.02;
    camera.far = d * 20;
    camera.updateProjectionMatrix();
    camera.position.copy(center).addScaledVector(PERSPECTIVE_DIRECTION, d);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const span = niceStep(Math.max(size.x, size.z, size.y * 0.5) * 0.4) * 8;
    const grid = new THREE.GridHelper(span, 8, 0x30353b, 0x59606a);
    grid.position.set(center.x, box.min.y - diag * 0.002, center.z);
    const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
    materials.forEach(function (material) { material.transparent = true; material.opacity = 0.45; material.depthWrite = false; });
    cellElement(overlay, cell, title);
    return { stage: stage, camera: camera, cell: cell, extras: [grid], center: center, diag: diag };
}

/** How far the 3/4 camera must stand for every corner of the box to fit the view, with a small margin. */
function fitDistance(box, w, h) {
    const center = box.getCenter(new THREE.Vector3());
    const forward = PERSPECTIVE_DIRECTION.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const tanV = Math.tan(30 * Math.PI / 360) * 0.86;
    const tanH = tanV * w / h;
    const offset = new THREE.Vector3();
    let distance = 0;
    for (let i = 0; i < 8; i++) {
        offset.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
        const toward = offset.dot(PERSPECTIVE_DIRECTION);
        distance = Math.max(distance, toward + Math.abs(offset.dot(right)) / tanH, toward + Math.abs(offset.dot(up)) / tanV);
    }
    return distance || 1;
}

function lines(points, color, opacity) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false }));
}

function cellElement(overlay, cell, title) {
    const element = document.createElement('div');
    element.className = 'cell';
    element.style.left = cell.x + 'px';
    element.style.top = cell.y + 'px';
    element.style.width = cell.w + 'px';
    element.style.height = cell.h + 'px';
    const heading = document.createElement('div');
    heading.className = 'title';
    const span = document.createElement('span');
    span.textContent = title;
    heading.appendChild(span);
    element.appendChild(heading);
    overlay.appendChild(element);
    return element;
}

function setAxis(vector, axis, value) {
    if (axis === 0) { vector.x = value; } else if (axis === 1) { vector.y = value; } else { vector.z = value; }
}

// ------------------------------------------------------------------ helpers

function niceStep(raw) {
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const scaled = raw / power;
    return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

function formatNumber(value, digits) {
    const text = value.toFixed(digits);
    return /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;
}

function point(vector, f) {
    return '(' + f(vector.x) + ', ' + f(vector.y) + ', ' + f(vector.z) + ')';
}

function numberList(numbers) {
    return numbers.join(', ');
}

function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function listNames(names) {
    return names.length ? names.map(function (name) { return '"' + name + '"'; }).join(', ') : 'none';
}

function describeValue(value) {
    if (value === undefined) { return 'undefined'; }
    if (value === null) { return 'null'; }
    if (typeof value !== 'object') { return 'a ' + typeof value; }
    const name = value.constructor && value.constructor.name;
    return name && name !== 'Object' ? 'a ' + name : 'a plain object with keys ' + listNames(Object.keys(value).slice(0, 6));
}

function annotate(error, label, verb) {
    const what = label + ' ' + (verb || 'threw') + ': ';
    if (error instanceof Error) {
        error.message = what + (error.name && error.name !== 'Error' ? error.name + ': ' : '') + error.message;
        return error;
    }
    return new Error(what + String(error));
}

/** The message and the stack frames in the project's code (not the viewer's). */
function describeError(error) {
    if (error && error.stack) {
        const frames = String(error.stack).split('\n').filter(function (line) {
            return /^\s+at /.test(line) && line.indexOf('/__callisto/') < 0;
        }).slice(0, 4);
        return String(error.message) + (frames.length ? '\n' + frames.join('\n') : '');
    }
    return String(error);
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function frames(count) {
    return new Promise(function (resolve) {
        let left = count;
        const tick = function () { if (--left <= 0) { resolve(); } else { requestAnimationFrame(tick); } };
        requestAnimationFrame(tick);
    });
}
`;
