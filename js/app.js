/**
 * app.js — Main WebXR AR application entry point
 *
 * Flow:
 *  1. User enters room code on the landing screen.
 *  2. PeerJS connects; room is established.
 *  3. "Enter AR" button appears; user taps it.
 *  4. WebXR AR session starts (immersive-ar, dom-overlay, hand-tracking).
 *  5. Three.js renders remote avatars + shared objects on every frame.
 *  6. Local avatar state is serialized and broadcast each frame.
 */

import * as THREE from 'three';
import { Network }       from './network.js';
import { LocalAvatar, RemoteAvatar } from './avatar.js';
import { SharedObjects } from './objects.js';

// ── PeerJS loaded via CDN script tag (appended below) ───────────────────────

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

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const landing     = $('landing');
const arPrompt    = $('ar-prompt');
const hud         = $('hud');
const landingStatus = $('landing-status');
const arStatus    = $('ar-status');
const hudRoom     = $('hud-room');
const hudPeers    = $('hud-peers');
const canvas      = $('xr-canvas');

// ── App state ────────────────────────────────────────────────────────────────

let renderer, scene, camera;
let xrSession = null;
let refSpace  = null;
let network   = null;
let localAvatar  = null;
let sharedObjects = null;

const remoteAvatars = new Map(); // peerId → RemoteAvatar
const localName = `Guest${Math.floor(Math.random() * 1000)}`;

// ── Three.js init (called once) ──────────────────────────────────────────────

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');

  scene = new THREE.Scene();

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 1.2);
  const dir     = new THREE.DirectionalLight(0xffffff, 1.5);
  dir.position.set(1, 3, 2);
  scene.add(ambient, dir);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
  scene.add(camera);

  window.addEventListener('resize', () => {
    if (!xrSession) {
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }
  });
}

// ── Network setup ────────────────────────────────────────────────────────────

function initNetwork(roomCode) {
  network = new Network({
    roomCode,
    onPeer: (peerId) => {
      // New peer joined — create avatar
      const avatar = new RemoteAvatar(peerId, scene);
      remoteAvatars.set(peerId, avatar);
      updatePeerCount();

      // If we're host, send current scene objects
      if (network.isHost) {
        const defs = sharedObjects?.getAllDefs() ?? [];
        defs.forEach(def => network.sendTo(peerId, { type: 'obj-spawn', payload: def }));
      }
    },
    onPeerLeave: (peerId) => {
      const avatar = remoteAvatars.get(peerId);
      if (avatar) { avatar.dispose(); remoteAvatars.delete(peerId); }
      updatePeerCount();
    },
    onMessage: (peerId, msg) => handleNetworkMessage(peerId, msg),
  });
}

function handleNetworkMessage(peerId, msg) {
  switch (msg.type) {
    case 'state':
      remoteAvatars.get(peerId)?.applyState(msg.payload);
      break;
    case 'emoji':
      remoteAvatars.get(msg.payload.peerId)?.showEmoji(msg.payload.emoji);
      break;
    case 'obj-spawn':
      sharedObjects?.applyRemoteSpawn(msg.payload);
      break;
    case 'obj-grab':
      sharedObjects?.applyRemoteGrab(msg.payload);
      break;
    case 'obj-state':
      sharedObjects?.applyRemoteState(msg.payload);
      break;
    case 'obj-release':
      sharedObjects?.applyRemoteRelease(msg.payload);
      break;
    case 'obj-delete':
      sharedObjects?.applyRemoteDelete(msg.payload);
      break;
  }
}

function updatePeerCount() {
  const n = remoteAvatars.size;
  hudPeers.textContent = n === 1 ? '1 other' : `${n} others`;
}

// ── WebXR session ────────────────────────────────────────────────────────────

async function startAR() {
  arStatus.textContent = 'Starting AR…';

  const sessionInit = {
    requiredFeatures: ['local'],
    optionalFeatures: ['hand-tracking', 'dom-overlay'],
    domOverlay: { root: document.body },
  };

  try {
    xrSession = await navigator.xr.requestSession('immersive-ar', sessionInit);
  } catch (e) {
    arStatus.textContent = `AR failed: ${e.message}`;
    return;
  }

  renderer.xr.setSession(xrSession);
  refSpace = await xrSession.requestReferenceSpace('local');

  // Kick off the render loop
  renderer.setAnimationLoop(onXRFrame);

  // Show HUD, hide prompt
  arPrompt.classList.add('hidden');
  hud.classList.remove('hidden');

  xrSession.addEventListener('end', () => {
    renderer.setAnimationLoop(null);
    xrSession = null;
    refSpace  = null;
    hud.classList.add('hidden');
    arPrompt.classList.remove('hidden');
    arStatus.textContent = 'Session ended. Tap Enter AR to restart.';
  });
}

// ── XR render loop ───────────────────────────────────────────────────────────

function onXRFrame(time, frame) {
  if (!frame) return;

  // Update shared objects (grab, drag)
  const inputSources = [...xrSession.inputSources];
  sharedObjects?.update(frame, refSpace, inputSources);

  // Serialize + broadcast local state
  const state = localAvatar.getState(frame, refSpace, inputSources);
  network?.sendState(state);

  // Check B button (secondary) for delete
  for (const src of inputSources) {
    const secondary = src.gamepad?.buttons[1];
    if (secondary?.pressed) {
      sharedObjects?.tryDeleteUnderRay(frame, refSpace, src);
    }
  }

  renderer.render(scene, renderer.xr.getCamera(camera));
}

// ── UI wiring ────────────────────────────────────────────────────────────────

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

  // Allow Enter key
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-join').click();
  });
}

async function joinRoom(code) {
  landingStatus.textContent = 'Connecting…';
  try {
    await loadPeerJS();
    initNetwork(code);
    await network.connect();

    // Init shared objects now that we have a peer ID
    sharedObjects = new SharedObjects(scene, network, network.localId);

    // Show room code in HUD
    hudRoom.textContent = `Room: ${code}`;

    // Hide landing, show AR prompt
    landing.classList.add('hidden');
    arPrompt.classList.remove('hidden');
    arStatus.textContent = navigator.xr
      ? 'Tap "Enter AR" to start.'
      : 'WebXR not available on this device/browser.';

    if (!navigator.xr) {
      $('btn-start-ar').disabled = true;
      return;
    }

    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
      arStatus.textContent = 'immersive-ar not supported on this device.';
      $('btn-start-ar').disabled = true;
    }
  } catch (e) {
    landingStatus.textContent = `Error: ${e.message}`;
  }
}

function setupARUI() {
  $('btn-start-ar').addEventListener('click', startAR);

  $('btn-exit-xr').addEventListener('click', () => {
    xrSession?.end();
  });

  // Emoji buttons
  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      network?.broadcast({ type: 'emoji', payload: { emoji, peerId: network.localId } });
      // Show locally (treat self as a remote for display)
      showLocalEmoji(emoji);
    });
  });

  // Object spawn buttons
  document.querySelectorAll('.obj-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!xrSession || !refSpace) return;
      // Spawn 0.5 m in front of camera
      const cam = renderer.xr.getCamera(camera);
      const forward = new THREE.Vector3(0, 0, -0.5).applyQuaternion(cam.quaternion);
      const pos = cam.position.clone().add(forward);
      sharedObjects?.spawnAt(btn.dataset.shape, pos, cam.quaternion.clone());
    });
  });
}

// Floating emoji above the local camera using a DOM element
function showLocalEmoji(emoji) {
  const el = document.createElement('div');
  el.textContent = emoji;
  el.className = 'emoji-float-el';
  $('emoji-floats').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Random room code ─────────────────────────────────────────────────────────

function randomCode() {
  const words = ['SUNNY','CLOUD','OCEAN','FLAME','GROVE','PRISM','CEDAR','LUNAR'];
  return words[Math.floor(Math.random() * words.length)];
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

function main() {
  initThree();
  localAvatar = new LocalAvatar(localName);
  setupLandingUI();
  setupARUI();
}

main();
