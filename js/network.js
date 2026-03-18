/**
 * network.js — PeerJS mesh networking with room codes
 *
 * Room joining strategy:
 *  1. First peer claims ID `xrhangout-<ROOM>` → becomes host.
 *  2. Later peers connect to the host, receive the full peer list,
 *     then form a full mesh by connecting to all existing peers.
 *  3. Host relays the peer list to every new joiner.
 *
 * Message types (JSON over PeerJS DataConnection):
 *  { type: 'peer-list',  peers: [id, ...] }         host → new joiner
 *  { type: 'state',      payload: <AvatarState> }    every frame (throttled)
 *  { type: 'obj-spawn',  payload: <ObjectDef> }      one-shot
 *  { type: 'obj-state',  payload: <ObjectState> }    every frame when grabbed
 *  { type: 'obj-grab',   payload: { id, owner } }    ownership claim
 *  { type: 'obj-release',payload: { id, state } }    ownership release
 *  { type: 'obj-delete', payload: { id } }           delete object
 *  { type: 'emoji',      payload: { emoji, peerId } } one-shot reaction
 */

const PEER_HOST = '0.peerjs.com';
const PEER_PORT = 443;
const PEER_PATH = '/';

export class Network {
  constructor({ roomCode, onPeer, onPeerLeave, onMessage }) {
    this.roomCode   = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    this.onPeer     = onPeer;      // (peerId) => void
    this.onPeerLeave= onPeerLeave; // (peerId) => void
    this.onMessage  = onMessage;   // (peerId, msg) => void

    this.peer        = null;
    this.isHost      = false;
    this.connections = new Map(); // peerId → DataConnection
    this.localId     = null;

    this._stateBuffer = {};  // peerId → latest state (deduplicated)
    this._sendInterval = null;
  }

  get hostId() {
    return `xrhangout-${this.roomCode}`;
  }

  /** Connect to PeerJS and join/create the room. Returns a Promise<void>. */
  async connect() {
    return new Promise((resolve, reject) => {
      // Try to claim the host ID first
      const { Peer } = window.peerjs || {};
      if (!Peer) { reject(new Error('PeerJS not loaded')); return; }

      const tryHost = () => {
        const p = new Peer(this.hostId, {
          host: PEER_HOST, port: PEER_PORT, path: PEER_PATH, secure: true,
        });
        p.on('open', id => {
          this.peer    = p;
          this.localId = id;
          this.isHost  = true;
          this._listenAsHost();
          resolve();
        });
        p.on('error', err => {
          if (err.type === 'unavailable-id') {
            p.destroy();
            joinAsGuest();
          } else {
            reject(err);
          }
        });
      };

      const joinAsGuest = () => {
        const randId = `xrhangout-${this.roomCode}-${Math.random().toString(36).slice(2,7)}`;
        const p = new Peer(randId, {
          host: PEER_HOST, port: PEER_PORT, path: PEER_PATH, secure: true,
        });
        p.on('open', id => {
          this.peer    = p;
          this.localId = id;
          this.isHost  = false;
          this._listenAsGuest();
          // Connect to host
          const conn = p.connect(this.hostId, { reliable: false, serialization: 'json' });
          this._registerConn(conn, () => resolve());
        });
        p.on('error', reject);
      };

      tryHost();
    });
  }

  _listenAsHost() {
    this.peer.on('connection', conn => {
      this._registerConn(conn, () => {
        // Send current peer list to newcomer
        const peerList = [...this.connections.keys()].filter(id => id !== conn.peer);
        conn.send({ type: 'peer-list', peers: peerList });
      });
    });
  }

  _listenAsGuest() {
    // Guests also accept incoming connections from peers introduced by host
    this.peer.on('connection', conn => {
      this._registerConn(conn);
    });
  }

  _registerConn(conn, onOpenExtra) {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      this.onPeer(conn.peer);
      if (onOpenExtra) onOpenExtra();
    });

    conn.on('data', data => {
      if (!data || !data.type) return;
      if (data.type === 'peer-list') {
        // Received from host: connect to each listed peer
        for (const peerId of data.peers) {
          if (!this.connections.has(peerId) && peerId !== this.localId) {
            const c = this.peer.connect(peerId, { reliable: false, serialization: 'json' });
            this._registerConn(c);
          }
        }
      } else {
        this.onMessage(conn.peer, data);
      }
    });

    conn.on('close', () => {
      this.connections.delete(conn.peer);
      this.onPeerLeave(conn.peer);
    });

    conn.on('error', () => {
      this.connections.delete(conn.peer);
      this.onPeerLeave(conn.peer);
    });
  }

  /** Broadcast a message to all connected peers. */
  broadcast(msg) {
    for (const conn of this.connections.values()) {
      if (conn.open) conn.send(msg);
    }
  }

  /** Send to a specific peer. */
  sendTo(peerId, msg) {
    const conn = this.connections.get(peerId);
    if (conn && conn.open) conn.send(msg);
  }

  /** Send avatar + hand state (call every frame; internally throttled to ~20 fps). */
  sendState(payload) {
    this._pendingState = payload;
    if (!this._stateThrottle) {
      this._stateThrottle = setTimeout(() => {
        if (this._pendingState) {
          this.broadcast({ type: 'state', payload: this._pendingState });
          this._pendingState = null;
        }
        this._stateThrottle = null;
      }, 50); // 20 fps
    }
  }

  disconnect() {
    if (this.peer) this.peer.destroy();
  }
}
