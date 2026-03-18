/**
 * app.js — Cross-platform entry point
 *
 * Modes (auto-detected after joining a room):
 *  AR      — immersive-ar WebXR session (Meta Quest passthrough, Android Chrome)
 *  DESKTOP — Regular Three.js scene with OrbitControls (desktop, iOS, unsupported devices)
 *
 * Desktop controls:
 *  Orbit / pan / zoom  — mouse drag / scroll (OrbitControls)
 *  Grab object         — left-click on object, drag
 *  Release object      — mouse-up
 *  Delete object       — Delete / Backspace key while crosshair is over it
 *  Hover highlight     — cursor becomes grab hand
 *
 * XR controls (unchanged):
 *  Grab object         — trigger (controller) or pinch (hand tracking)
 *  Delete object       — B button
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Network }        from './network.js';
import { LocalAvatar, RemoteAvatar } from './avatar.js';
import { SharedObjects }  from './objects.js';

// ── Modes ─────────────────────────────────────────────────────────────────────

const MODE = { NONE: 'none', AR: 'ar', DESKTOP: 'desktop' };
let currentMode = MODE.NONE;

// ── PeerJS CDN loader ────────────────────────────────────────────────────────

function loadPeerJS() {
  return new Promise((resolve, reject) => {
    if (window.peerjs) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const landing       = $('landing');
const arPrompt      = $('ar-prompt');
const hud           = $('hud');
const landingStatus = $('landing-status');
const arStatus      = $('ar-status');
const hudRoom       = $('hud-room');
const hudPeers      = $('hud-peers');
const canvas        = $('xr-canvas');
const btnStart      = $('btn-start-ar');
const btnExit       = $('btn-exit-xr');

// ── App state ─────────────────────────────────────────────────────────────────

let renderer, scene, camera;
let xrSession      = null;
let refSpace       = null;
let orbitControls  = null;
let network        = null;
let localAvatar    = null;
let sharedObjects  = null;

const remoteAvatars = new Map(); // peerId → RemoteAvatar
const localName = `Guest${Math.floor(Math.random() * 1000)}`;

// Desktop drag state
const _mouse     = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _dragPlane = new THREE.Plane();
const _dragOff   = new THREE.Vector3();
let   _dragId    = null;

// ── Three.js bootstrap ────────────────────────────────────────────────────────

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');

  scene = new THREE.Scene();

  // Default lighting (shared across modes; desktop supplements with hemi)
  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  ambient.name = 'ambient';
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(2, 5, 3);
  dir.castShadow = true;
  scene.add(ambient, dir);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 200);
  scene.add(camera);

  window.addEventListener('resize', () => {
    if (currentMode !== MODE.AR) {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
  });
}

// ── Network ───────────────────────────────────────────────────────────────────

function initNetwork(roomCode) {
  network = new Network({
    roomCode,
    onPeer: peerId => {
      remoteAvatars.set(peerId, new RemoteAvatar(peerId, scene));
      updatePeerCount();
      // Host syncs existing objects to the newcomer
      if (network.isHost) {
        sharedObjects?.getAllDefs().forEach(def =>
          network.sendTo(peerId, { type: 'obj-spawn', payload: def })
        );
      }
    },
    onPeerLeave: peerId => {
      remoteAvatars.get(peerId)?.dispose();
      remoteAvatars.delete(peerId);
      updatePeerCount();
    },
    onMessage: (peerId, msg) => handleMessage(peerId, msg),
  });
}

function handleMessage(peerId, msg) {
  switch (msg.type) {
    case 'state':      remoteAvatars.get(peerId)?.applyState(msg.payload);          break;
    case 'emoji':      remoteAvatars.get(msg.payload.peerId)?.showEmoji(msg.payload.emoji); break;
    case 'obj-spawn':  sharedObjects?.applyRemoteSpawn(msg.payload);                break;
    case 'obj-grab':   sharedObjects?.applyRemoteGrab(msg.payload);                 break;
    case 'obj-state':  sharedObjects?.applyRemoteState(msg.payload);                break;
    case 'obj-release':sharedObjects?.applyRemoteRelease(msg.payload);              break;
    case 'obj-delete': sharedObjects?.applyRemoteDelete(msg.payload);               break;
  }
}

function updatePeerCount() {
  const n = remoteAvatars.size;
  hudPeers.textContent = n === 1 ? '1 other' : `${n} others`;
}

// ── AR mode ───────────────────────────────────────────────────────────────────

async function startAR() {
  arStatus.textContent = 'Starting AR…';
  try {
    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['hand-tracking', 'dom-overlay'],
      domOverlay: { root: document.body },
    });
  } catch (e) {
    arStatus.textContent = `AR failed: ${e.message}`;
    return;
  }

  currentMode = MODE.AR;
  renderer.xr.setSession(xrSession);
  refSpace = await xrSession.requestReferenceSpace('local');
  renderer.setAnimationLoop(onARFrame);

  arPrompt.classList.add('hidden');
  hud.classList.remove('hidden');
  btnExit.textContent = 'Exit AR';

  xrSession.addEventListener('end', () => {
    currentMode = MODE.NONE;
    renderer.setAnimationLoop(null);
    xrSession = null;
    refSpace  = null;
    hud.classList.add('hidden');
    arPrompt.classList.remove('hidden');
    arStatus.textContent = 'Session ended. Tap to restart.';
  });
}

function onARFrame(_time, frame) {
  if (!frame) return;
  const inputSources = [...xrSession.inputSources];
  sharedObjects?.update(frame, refSpace, inputSources);

  // Broadcast local XR pose
  const state = localAvatar.getState(frame, refSpace, inputSources);
  network?.sendState(state);

  // B button → delete
  for (const src of inputSources) {
    if (src.gamepad?.buttons[1]?.pressed)
      sharedObjects?.tryDeleteUnderRay(frame, refSpace, src);
  }

  renderer.render(scene, renderer.xr.getCamera(camera));
}

// ── Desktop / mobile mode ─────────────────────────────────────────────────────

function buildDesktopEnvironment() {
  renderer.setClearColor(0x080814, 1);
  scene.fog = new THREE.FogExp2(0x080814, 0.011);

  // Hemisphere light for sky/ground colour contrast
  const hemi = new THREE.HemisphereLight(0x3355bb, 0x110d22, 1.0);
  hemi.name = 'desktop-hemi';
  scene.add(hemi);

  // Reflective floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x060610, roughness: 0.92, metalness: 0.15 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.6;
  floor.receiveShadow = true;
  floor.name = 'desktop-floor';
  scene.add(floor);

  // Subtle grid
  const grid = new THREE.GridHelper(100, 80, 0x141466, 0x0a0a33);
  grid.position.y = -1.594;
  grid.name = 'desktop-grid';
  scene.add(grid);

  // A few ambient light orbs for atmosphere
  const orbs = [
    { color: 0x4433ff, pos: [-6, 2, -6],  intensity: 1.5, dist: 12 },
    { color: 0xff3399, pos: [ 6, 2, -6],  intensity: 1.5, dist: 12 },
    { color: 0x00ccff, pos: [ 0, 3, -12], intensity: 1.0, dist: 14 },
  ];
  for (const { color, pos, intensity, dist } of orbs) {
    const light = new THREE.PointLight(color, intensity, dist);
    light.position.set(...pos);
    scene.add(light);

    // Visible orb mesh
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 8),
      new THREE.MeshBasicMaterial({ color })
    );
    orb.position.set(...pos);
    scene.add(orb);
  }
}

function startDesktop() {
  currentMode = MODE.DESKTOP;
  document.body.classList.add('desktop-mode');

  buildDesktopEnvironment();

  // Camera: eye-height, looking into the scene
  camera.position.set(0, 1.6, 5);
  camera.lookAt(0, 1.6, 0);

  // OrbitControls — works with mouse AND touch
  orbitControls = new OrbitControls(camera, canvas);
  orbitControls.target.set(0, 1.6, 0);
  orbitControls.enableDamping   = true;
  orbitControls.dampingFactor   = 0.07;
  orbitControls.minDistance     = 0.3;
  orbitControls.maxDistance     = 40;
  orbitControls.maxPolarAngle   = Math.PI * 0.88;
  orbitControls.update();

  // Mouse events (skip on pure-touch devices)
  if (!('ontouchstart' in window)) {
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup',   onMouseUp);
    window.addEventListener('keydown',   onKeyDown);
  }

  arPrompt.classList.add('hidden');
  hud.classList.remove('hidden');
  btnExit.textContent = 'Exit';

  renderer.setAnimationLoop(onDesktopFrame);
}

function onDesktopFrame() {
  orbitControls?.update();

  // Broadcast local camera pose as avatar head state
  const p = camera.position, q = camera.quaternion;
  network?.sendState({
    name: localName,
    head: { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] },
    hands: { left: null, right: null },
  });

  renderer.render(scene, camera);
}

function stopDesktop() {
  renderer.setAnimationLoop(null);
  orbitControls?.dispose();
  orbitControls = null;
  canvas.removeEventListener('mousedown', onMouseDown);
  canvas.removeEventListener('mousemove', onMouseMove);
  canvas.removeEventListener('mouseup',   onMouseUp);
  window.removeEventListener('keydown',   onKeyDown);
  // Remove desktop-only scene objects
  ['desktop-floor', 'desktop-grid', 'desktop-hemi'].forEach(name => {
    const obj = scene.getObjectByName(name);
    if (obj) scene.remove(obj);
  });
  document.body.classList.remove('desktop-mode');
  currentMode = MODE.NONE;
}

// ── Desktop mouse / keyboard handlers ─────────────────────────────────────────

function getNDC(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  _mouse.set(
    ((clientX - r.left) / r.width)  *  2 - 1,
    ((clientY - r.top)  / r.height) * -2 + 1
  );
}

function objectMeshes() {
  return sharedObjects ? [...sharedObjects.objects.values()].map(o => o.mesh) : [];
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  getNDC(e.clientX, e.clientY);
  _raycaster.setFromCamera(_mouse, camera);

  const hits = _raycaster.intersectObjects(objectMeshes());
  if (!hits.length) return;

  const id  = hits[0].object.userData.objId;
  const obj = sharedObjects.objects.get(id);
  if (obj.owner && obj.owner !== network.localId) return; // someone else owns it

  _dragId     = id;
  obj.owner   = network.localId;
  network.broadcast({ type: 'obj-grab', payload: { id, owner: network.localId } });

  // Drag plane: perpendicular to camera through the object centre
  const normal = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  _dragPlane.setFromNormalAndCoplanarPoint(normal, obj.mesh.position);

  const isect = new THREE.Vector3();
  _raycaster.ray.intersectPlane(_dragPlane, isect);
  _dragOff.subVectors(obj.mesh.position, isect);

  orbitControls.enabled = false;
  canvas.style.cursor = 'grabbing';
}

function onMouseMove(e) {
  getNDC(e.clientX, e.clientY);

  if (_dragId) {
    _raycaster.setFromCamera(_mouse, camera);
    const isect = new THREE.Vector3();
    if (_raycaster.ray.intersectPlane(_dragPlane, isect)) {
      const obj = sharedObjects?.objects.get(_dragId);
      if (obj) {
        obj.mesh.position.copy(isect.add(_dragOff));
        network.broadcast({
          type: 'obj-state',
          payload: { id: _dragId, p: obj.mesh.position.toArray(), q: obj.mesh.quaternion.toArray() },
        });
      }
    }
    return;
  }

  // Hover cursor hint
  _raycaster.setFromCamera(_mouse, camera);
  const hovering = _raycaster.intersectObjects(objectMeshes()).length > 0;
  canvas.style.cursor = hovering ? 'grab' : '';
}

function onMouseUp() {
  if (!_dragId) return;
  const obj = sharedObjects?.objects.get(_dragId);
  if (obj) {
    obj.owner = null;
    network.broadcast({
      type: 'obj-release',
      payload: { id: _dragId, p: obj.mesh.position.toArray(), q: obj.mesh.quaternion.toArray() },
    });
  }
  _dragId = null;
  orbitControls.enabled = true;
  canvas.style.cursor = '';
}

function onKeyDown(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // Hit-test from screen centre
  _raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = _raycaster.intersectObjects(objectMeshes());
  if (!hits.length) return;
  const id = hits[0].object.userData.objId;
  sharedObjects.applyRemoteDelete({ id });
  network.broadcast({ type: 'obj-delete', payload: { id } });
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function setupLandingUI() {
  const input = $('room-input');

  $('btn-create').addEventListener('click', async () => {
    const code = input.value.trim().toUpperCase() || randomCode();
    input.value = code;
    await joinRoom(code);
  });

  $('btn-join').addEventListener('click', async () => {
    const code = input.value.trim().toUpperCase();
    if (!code) { landingStatus.textContent = 'Enter a room code first.'; return; }
    await joinRoom(code);
  });

  input.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
}

async function joinRoom(code) {
  landingStatus.textContent = 'Connecting…';
  try {
    await loadPeerJS();
    initNetwork(code);
    await network.connect();

    sharedObjects = new SharedObjects(scene, network, network.localId);
    hudRoom.textContent = `Room: ${code}`;

    // Detect best mode and configure the start button
    const arOk = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);

    landing.classList.add('hidden');
    arPrompt.classList.remove('hidden');

    if (arOk) {
      btnStart.textContent = 'Enter AR';
      btnStart.onclick = startAR;
      arStatus.textContent = 'Tap to enter AR on your device.';
    } else {
      btnStart.textContent = 'Enter 3D';
      btnStart.onclick = startDesktop;
      arStatus.textContent = isMobile()
        ? 'Tap to enter the 3D space.'
        : 'Click to enter the 3D space. Drag to orbit, scroll to zoom.';
    }
    btnStart.disabled = false;

  } catch (e) {
    landingStatus.textContent = `Error: ${e.message}`;
  }
}

function setupHudUI() {
  btnExit.addEventListener('click', () => {
    if (currentMode === MODE.AR)      xrSession?.end();
    else if (currentMode === MODE.DESKTOP) {
      stopDesktop();
      hud.classList.add('hidden');
      network?.disconnect();
      landing.classList.remove('hidden');
      landingStatus.textContent = '';
    }
  });

  // Emoji buttons
  document.querySelectorAll('.emoji-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      network?.broadcast({ type: 'emoji', payload: { emoji, peerId: network.localId } });
      showLocalEmoji(emoji);
    })
  );

  // Object spawn buttons
  document.querySelectorAll('.obj-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      // Works in both AR (uses XR camera) and desktop (uses Three.js camera)
      const cam = currentMode === MODE.AR ? renderer.xr.getCamera(camera) : camera;
      if (!cam) return;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const dist = currentMode === MODE.AR ? 0.6 : 2.0;
      const pos = cam.position.clone().addScaledVector(forward, dist);
      sharedObjects?.spawnAt(btn.dataset.shape, pos, cam.quaternion.clone());
    })
  );
}

// Floating emoji DOM element
function showLocalEmoji(emoji) {
  const el = document.createElement('div');
  el.textContent = emoji;
  el.className = 'emoji-float-el';
  $('emoji-floats').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomCode() {
  return ['SUNNY','CLOUD','OCEAN','FLAME','GROVE','PRISM','CEDAR','LUNAR']
    [Math.floor(Math.random() * 8)];
}

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

function main() {
  initThree();
  localAvatar = new LocalAvatar(localName);
  setupLandingUI();
  setupHudUI();
}

main();
