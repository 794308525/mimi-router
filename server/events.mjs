let sequence = 0;
const clients = new Set();

export function addEventClient(response) {
  clients.add(response);
  response.write(`event: ready\nid: ${sequence}\ndata: {"sequence":${sequence}}\n\n`);
  return () => clients.delete(response);
}

export function publish(type, payload) {
  sequence += 1;
  const message = `event: ${type}\nid: ${sequence}\ndata: ${JSON.stringify({
    sequence,
    ...payload,
  })}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

export function heartbeat() {
  for (const client of clients) {
    try {
      client.write(": heartbeat\n\n");
    } catch {
      clients.delete(client);
    }
  }
}

