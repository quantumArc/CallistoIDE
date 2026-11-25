import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildPiece, PIECE_TYPES } from './src/pieces.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d1a17);
scene.add(new THREE.HemisphereLight(0xffffff, 0x302820, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 6, 4);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 2.2, 5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.4, 0);

PIECE_TYPES.forEach((type, index) => {
    const piece = buildPiece(type);
    piece.position.x = (index - (PIECE_TYPES.length - 1) / 2) * 1.1;
    scene.add(piece);
});

renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
});
addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});
