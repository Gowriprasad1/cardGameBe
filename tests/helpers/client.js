'use strict';

const { io: connectSocket } = require('socket.io-client');

let counter = 0;
const rid = () => `req-${Date.now()}-${(counter += 1)}-abcdef`;

/** socket.io client that records every event it receives. */
function connectClient(base, token) {
  const socket = connectSocket(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const events = [];
  const waiters = [];
  socket.onAny((name, payload) => {
    const entry = { name, payload };
    events.push(entry);
    for (const w of [...waiters]) if (w.match(entry)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(entry); }
  });

  const ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (err) => reject(err));
  });

  const client = {
    socket, events, ready,
    /** emit with acknowledgement */
    emit: (event, payload = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), Number(process.env.EMIT_TIMEOUT_MS) || 5000);
      socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
    }),
    /** index to use with waitFor({after}) so earlier events are ignored */
    mark: () => events.length,
    waitFor(name, { where = () => true, after = 0, timeout = 4000 } = {}) {
      const match = (e) => e.name === name && where(e.payload);
      const existing = events.slice(after).find(match);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        let timer = null;
        const waiter = { match, resolve: (entry) => { clearTimeout(timer); resolve(entry); } };
        waiters.push(waiter);
        timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) { waiters.splice(i, 1); reject(new Error(`timed out waiting for "${name}"`)); }
        }, timeout);
      });
    },
    all: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    lastState: () => {
      const states = events.filter((e) => e.name === 'game-state');
      return states.length ? states[states.length - 1].payload : null;
    },
  };
  return client;
}


module.exports = { connectClient, rid };
