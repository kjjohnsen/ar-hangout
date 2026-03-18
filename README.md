# AR Hangout

A collaborative WebXR AR social space. Meet friends in augmented reality, see each other's avatars with hand tracking, grab and move shared 3D objects, and react with emojis.

## Features

- **AR mode** — WebXR `immersive-ar` (Meta Quest 3/Pro passthrough)
- **Avatars** — Head + hands with full finger-joint rendering (hand tracking) or controller grip boxes
- **Shared objects** — Spawn cubes, spheres, and tori; grab and drag them together in real time
- **Emoji reactions** — Tap an emoji; it floats above your avatar for all to see
- **P2P networking** — WebRTC via PeerJS, no backend required
- **Room codes** — Share a short code (e.g. `SUNNY`) to join the same space

## How to use

1. Open the app on your Meta Quest browser (or any WebXR-capable browser)
2. Enter a room code and tap **Create Room** or share a code and tap **Join Room**
3. Tap **Enter AR** to start the AR session
4. Use the HUD toolbar to spawn objects and send emoji reactions
5. Grab objects with your trigger (controller) or pinch gesture (hand tracking)
6. Press B to delete an object you're pointing at

## Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/ar-hangout.git
git push -u origin main
# Enable GitHub Pages in repo Settings → Pages → Source: main branch / root
```

## Local development

Since WebXR requires HTTPS, use a local HTTPS server:

```bash
npx serve . --ssl-cert cert.pem --ssl-key key.pem
# or
npx http-server . -S -C cert.pem
```

Then open `https://localhost:8080` on your Quest browser (or via a tunnel like ngrok).

## Tech stack

- [Three.js r170](https://threejs.org/) — 3D rendering + WebXR integration
- [PeerJS 1.5](https://peerjs.com/) — WebRTC peer-to-peer via PeerJS cloud signaling
- Vanilla JS (ES modules, no build step)

## Controls

| Input | Action |
|-------|--------|
| Trigger (controller) | Grab object |
| B button | Delete pointed object |
| Pinch (hand tracking) | Grab / release object |
| HUD emoji buttons | Send emoji reaction |
| HUD shape buttons | Spawn object 0.5 m ahead |
| Exit AR | End session |
