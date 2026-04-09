/**
 * network.js — PeerJS mesh networking with room codes
 *
 * Room joining strategy:
 *  1. First peer claims ID `xrhangout-<ROOM>` -> becomes host.
 *  2. Later peers connect to the host, receive the full peer list,
 *     then form a full mesh by connecting to all existing peers.
 *  3. Host relays the peer list to every new joiner.
 *
 * Host migration:
 *  When the host disconnects, the remaining peer with the lowest
 *  alphabetical ID becomes the new "logical host" and handles
 *  object sync for future in-mesh events. Note: new joiners to the
 *  room won't be able to discover it via PeerJS (the well-known
 *  host ID is gone). This is a known limitation.
 *
 * Reconnection:
 *  If all connections are lost, auto-reconnect with exponential
 *  backoff (1s -> 2s -> 4s -> 8s -> 16s, max 5 attempts).
 *
 * Message types (JSON over PeerJS DataConnection):
 *  { type: 'peer-list',        peers: [id, ...] }      host -> new joiner
 *  { type: 'state',            payload: <AvatarState> } every frame (throttled)
 *  { type: 'obj-spawn',        payload: <ObjectDef> }   one-shot
 *  { type: 'obj-state',        payload: <ObjectState> } while grabbed (throttled)
 *  { type: 'obj-grab',         payload: { id, owner, ts } } ownership claim
 *  { type: 'obj-release',      payload: { id, p, q } }  ownership release
 *  { type: 'obj-delete',       payload: { id } }         remove object
 *  { type: 'emoji',            payload: { emoji, peerId } } reaction
 *  { type: 'full-sync-request',payload: {} }             re-entry resync
 */

import { dbg, dbgWarn, dbgError } from './debug.js';

const PEER_HOST = '0.peerjs.com';
const PEER_PORT = 443;
const PEER_PATH = '/';
const MAX_RECONNECT = 5;

export class Network {
  constructor({ roomCode, onPeer, onPeerLeave, onMessage }) {
    this.roomCode    = roomCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    this.onPeer      = onPeer;      // (peerId) => void
    this.onPeerLeave = onPeerLeave; // (peerId) => void
    this.onMessage   = onMessage;   // (peerId, msg) => void

    this.peer        = null;
    this.isHost      = false;
    this.connections  = new Map(); // peerId -> DataConnection
    this.localId     = null;

    // State throttle
    this._pendingState  = null;
    this._stateThrottle = null;

    // Reconnection
    this._reconnectAttempts = 0;
    this._reconnecting      = false;
  }

  get hostId() {
    return `xrhangout-${this.roomCode}`;
  }

  /** Connect to PeerJS and join/create the room. Returns a Promise<void>. */
  async connect() {
    return new Promise((resolve, reject) => {
      const { Peer } = window.peerjs || {};
      if (!Peer) { reject(new Error('PeerJS not loaded')); return; }

      const tryHost = () => {
        dbg('NET', `trying to claim host ID: ${this.hostId}`);
        const p = new Peer(this.hostId, {
          host: PEER_HOST, port: PEER_PORT, path: PEER_PATH, secure: true,
        });

        p.on('open', id => {
          dbg('NET', `connected as HOST, id=${id}`);
          this.peer    = p;
          this.localId = id;
          this.isHost  = true;
          this._setupPeerEvents(p);
          this._listenAsHost();
          resolve();
        });

        p.on('error', err => {
          if (err.type === 'unavailable-id') {
            dbg('NET', 'host ID taken, joining as guest');
            p.destroy();
            joinAsGuest();
          } else {
            dbgError('NET', 'host connect error:', err.type, err.message);
            reject(err);
          }
        });
      };

      const joinAsGuest = () => {
        const randId = `xrhangout-${this.roomCode}-${Math.random().toString(36).slice(2, 7)}`;
        dbg('NET', `joining as guest, id=${randId}`);
        const p = new Peer(randId, {
          host: PEER_HOST, port: PEER_PORT, path: PEER_PATH, secure: true,
        });

        p.on('open', id => {
          dbg('NET', `connected as GUEST, id=${id}`);
          this.peer    = p;
          this.localId = id;
          this.isHost  = false;
          this._setupPeerEvents(p);
          this._listenAsGuest();
          // Connect to host
          dbg('NET', `connecting to host: ${this.hostId}`);
          const conn = p.connect(this.hostId, { reliable: false, serialization: 'json' });
          this._registerConn(conn, () => resolve());
        });

        p.on('error', err => {
          dbgError('NET', 'guest connect error:', err.type, err.message);
          reject(err);
        });
      };

      tryHost();
    });
  }

  /** Shared peer-level event handlers (disconnected from PeerJS signaling server). */
  _setupPeerEvents(p) {
    p.on('disconnected', () => {
      dbgWarn('NET', 'disconnected from PeerJS signaling server');
      if (!p.destroyed) {
        dbg('NET', 'attempting PeerJS server reconnect...');
        p.reconnect();
      }
    });

    p.on('close', () => {
      dbgWarn('NET', 'peer destroyed');
    });
  }

  _listenAsHost() {
    this.peer.on('connection', conn => {
      dbg('NET', `host: incoming connection from ${conn.peer}`);
      this._registerConn(conn, () => {
        // Send current peer list to newcomer
        const peerList = [...this.connections.keys()].filter(id => id !== conn.peer);
        dbg('NET', `sent peer-list to ${conn.peer}:`, peerList);
        conn.send({ type: 'peer-list', peers: peerList });
      });
    });
  }

  _listenAsGuest() {
    // Guests also accept incoming connections from peers introduced by host
    this.peer.on('connection', conn => {
      dbg('NET', `guest: incoming connection from ${conn.peer}`);
      this._registerConn(conn);
    });
  }

  _registerConn(conn, onOpenExtra) {
    conn.on('open', () => {
      dbg('NET', `connection open: ${conn.peer}`);
      this.connections.set(conn.peer, conn);
      this._reconnectAttempts = 0; // reset on any successful connection
      this.onPeer(conn.peer);
      if (onOpenExtra) onOpenExtra();
    });

    conn.on('data', data => {
      if (!data || !data.type) return;
      if (data.type === 'peer-list') {
        dbg('NET', `received peer-list from ${conn.peer}:`, data.peers);
        for (const peerId of data.peers) {
          if (!this.connections.has(peerId) && peerId !== this.localId) {
            dbg('NET', `connecting to mesh peer: ${peerId}`);
            const c = this.peer.connect(peerId, { reliable: false, serialization: 'json' });
            this._registerConn(c);
          }
        }
      } else {
        // Log non-spammy messages
        if (data.type !== 'state' && data.type !== 'obj-state') {
          dbg('NET', `recv from ${conn.peer}: ${data.type}`);
        }
        this.onMessage(conn.peer, data);
      }
    });

    conn.on('close', () => {
      dbg('NET', `connection closed: ${conn.peer}`);
      this.connections.delete(conn.peer);
      this.onPeerLeave(conn.peer);

      // Host migration: if the host left and we're not the host, try to become one
      if (conn.peer === this.hostId && !this.isHost) {
        this._tryBecomeHost();
      }

      // Auto-reconnect if all connections lost and we're not host
      if (this.connections.size === 0 && !this.isHost) {
        this._scheduleReconnect();
      }
    });

    conn.on('error', err => {
      dbgWarn('NET', `connection error with ${conn.peer}:`, err.type || err);
      this.connections.delete(conn.peer);
      this.onPeerLeave(conn.peer);

      if (this.connections.size === 0 && !this.isHost) {
        this._scheduleReconnect();
      }
    });
  }

  // ── Host migration ──────────────────────────────────────────────────────────

  _tryBecomeHost() {
    // Elect the peer with the lowest alphabetical ID among survivors
    const allIds = [this.localId, ...this.connections.keys()].sort();
    if (allIds[0] === this.localId) {
      dbg('NET', 'elected as new logical host (existing mesh only)');
      this.isHost = true;
      // Start accepting connections in case someone in the mesh reconnects
      this._listenAsHost();
    } else {
      dbg('NET', `new logical host is ${allIds[0]}, not us`);
    }
  }

  // ── Auto-reconnect ──────────────────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._reconnecting || this._reconnectAttempts >= MAX_RECONNECT) {
      if (this._reconnectAttempts >= MAX_RECONNECT) {
        dbgError('NET', `max reconnect attempts (${MAX_RECONNECT}) reached, giving up`);
      }
      return;
    }
    this._reconnecting = true;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 16000);
    dbg('NET', `scheduling reconnect in ${delay}ms (attempt ${this._reconnectAttempts + 1}/${MAX_RECONNECT})`);

    setTimeout(async () => {
      try {
        // Clean up old peer
        if (this.peer && !this.peer.destroyed) this.peer.destroy();
        await this.connect();
        this._reconnectAttempts = 0;
        this._reconnecting = false;
        dbg('NET', 'reconnected successfully');
      } catch (e) {
        this._reconnectAttempts++;
        this._reconnecting = false;
        dbgWarn('NET', `reconnect failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  // ── Messaging ───────────────────────────────────────────────────────────────

  /** Broadcast a message to all connected peers. */
  broadcast(msg) {
    if (msg.type !== 'state' && msg.type !== 'obj-state') {
      dbg('NET', `broadcast: ${msg.type} to ${this.connections.size} peers`);
    }
    for (const conn of this.connections.values()) {
      if (conn.open) conn.send(msg);
    }
  }

  /** Send to a specific peer. */
  sendTo(peerId, msg) {
    const conn = this.connections.get(peerId);
    if (conn && conn.open) {
      conn.send(msg);
    } else {
      dbgWarn('NET', `sendTo failed: no open connection to ${peerId}`);
    }
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
    dbg('NET', 'disconnecting');
    if (this._stateThrottle) clearTimeout(this._stateThrottle);
    if (this.peer) this.peer.destroy();
  }
}
