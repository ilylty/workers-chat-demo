async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        return new Response("Chat server is running.", {headers: {"Content-Type": "text/plain"}});
      }

      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        return new Response("Method not allowed", {status: 405});
      }

      let name = path[1];
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

      let roomObject = env.rooms.get(id);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      return roomObject.fetch(newUrl, request);
    }
    default:
      return new Response("Not found", {status: 404});
  }
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();

    // On wakeup, reconnect any existing websockets.
    let websockets = this.state.getWebSockets();
    websockets.forEach(ws => {
      this.sessions.set(ws, {});
    });

    // If there are two, they are peers.
    if (this.sessions.size === 2) {
        let [ws1, ws2] = Array.from(this.sessions.keys());
        this.sessions.get(ws1).peer = ws2;
        this.sessions.get(ws2).peer = ws1;
    }
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          // We only accept two connections.
          if (this.sessions.size >= 2) {
            return new Response("Room is full.", {status: 429});
          }

          let pair = new WebSocketPair();
          await this.handleSession(pair[1]);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  async handleSession(webSocket) {
    this.state.acceptWebSocket(webSocket);
    this.sessions.set(webSocket, {});

    if (this.sessions.size === 2) {
      let [ws1, ws2] = Array.from(this.sessions.keys());
      this.sessions.get(ws1).peer = ws2;
      this.sessions.get(ws2).peer = ws1;

      // Notify clients they are connected.
      // ws1.send("connected");
      // ws2.send("connected");
    }
  }

  async webSocketMessage(webSocket, message) {
    let session = this.sessions.get(webSocket);
    if (session && session.peer) {
        try {
            session.peer.send(message);
        } catch (e) {
            // The peer probably disconnected.
            this.closeOrErrorHandler(session.peer);
        }
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket);
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket);
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket);
    if (session) {
      this.sessions.delete(webSocket);
      if (session.peer) {
        session.peer.close(1000, "Peer disconnected.");
        this.sessions.delete(session.peer);
      }
    }
  }
}
