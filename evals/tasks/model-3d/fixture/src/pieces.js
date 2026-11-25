// Chess pieces, built from three.js primitives. One unit is one board square; each piece stands on y = 0.
import * as THREE from 'three';

export const PIECE_TYPES = ['pawn', 'rook', 'knight', 'bishop', 'queen', 'king'];

const material = new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.5 });

function lathe(points) {
    return new THREE.Mesh(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 32), material);
}

/** A chess piece as a THREE.Group, standing on y = 0. `type` is one of PIECE_TYPES. */
export function buildPiece(type) {
    const group = new THREE.Group();
    switch (type) {
        case 'pawn':
            group.add(lathe([[0, 0], [0.3, 0], [0.3, 0.06], [0.14, 0.18], [0.1, 0.32], [0.16, 0.36], [0.1, 0.38], [0, 0.38]]));
            group.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), material), 0, 0.46, 0));
            break;
        case 'rook':
            group.add(lathe([[0.32, 0], [0.32, 0.06], [0.2, 0.14], [0.18, 0.46], [0.26, 0.5], [0.26, 0.56]]));
            for (let i = 0; i < 4; i++) {
                const angle = i * Math.PI / 2;
                group.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), material), Math.cos(angle) * 0.2, 0.66, Math.sin(angle) * 0.2));
            }
            break;
        case 'knight': {
            const shape = new THREE.Shape();
            shape.moveTo(-0.25, 0);
            shape.lineTo(0.25, 0);
            shape.lineTo(0.15, 0.35);
            shape.lineTo(0.3, 0.5);
            shape.lineTo(0.05, 0.7);
            shape.lineTo(-0.2, 0.5);
            shape.lineTo(-0.25, 0);
            const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
            geometry.translate(0, 0, -0.04);
            group.add(new THREE.Mesh(geometry, material));
            break;
        }
        case 'bishop':
            group.add(lathe([[0, 0], [0.3, 0], [0.3, 0.06], [0.14, 0.2], [0.1, 0.5], [0.18, 0.6], [0.08, 0.78], [0, 0.82]]));
            break;
        case 'queen':
            group.add(lathe([[0, 0], [0.34, 0], [0.34, 0.06], [0.16, 0.22], [0.12, 0.62], [0.24, 0.72], [0.18, 0.8], [0, 0.86]]));
            break;
        case 'king':
            group.add(lathe([[0, 0], [0.34, 0], [0.34, 0.06], [0.16, 0.22], [0.12, 0.66], [0.24, 0.76], [0.18, 0.86], [0, 0.9]]));
            group.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), material), 0, 1.0, 0));
            group.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.05), material), 0, 1.04, 0));
            break;
        default:
            throw new Error(`Unknown piece: ${type}`);
    }
    return group;
}

function at(mesh, x, y, z) {
    mesh.position.set(x, y, z);
    return mesh;
}
