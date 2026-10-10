import net from 'node:net';

/**
 * A TCP relay between an agent and the server that can "pull the cable": after cut() every byte is
 * dropped in both directions while both TCP connections stay open. Unlike a hung process, the far end
 * then never answers a WebSocket close frame, so only the server's own timers can end the session.
 */
export interface Cable {
  /** ws:// URL of the agent endpoint, through the relay. */
  readonly url: string;
  cut(): void;
  /** Resolves with performance.now() when the server ends the relay's upstream TCP connection. */
  readonly upstreamClosed: Promise<number>;
  close(): Promise<void>;
}

export async function openCable(target: URL): Promise<Cable> {
  let isCut = false;
  const sockets = new Set<net.Socket>();
  let markClosed: (at: number) => void = () => undefined;
  const upstreamClosed = new Promise<number>((resolve) => {
    markClosed = resolve;
  });
  const relay = net.createServer((down) => {
    const up = net.connect(Number(target.port), target.hostname);
    sockets.add(down);
    sockets.add(up);
    down.on('data', (chunk) => {
      if (!isCut) up.write(chunk);
    });
    up.on('data', (chunk) => {
      if (!isCut) down.write(chunk);
    });
    // The server ending its side (FIN or RST) is what we measure; the agent side is not told.
    const onUpGone = (): void => {
      markClosed(performance.now());
      if (!isCut) down.destroy();
    };
    up.on('end', onUpGone);
    up.on('close', onUpGone);
    up.on('error', () => undefined);
    down.on('error', () => undefined);
    down.on('close', () => {
      if (!isCut) up.destroy();
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const { port } = relay.address() as net.AddressInfo;
  return {
    url: `ws://127.0.0.1:${String(port)}${target.pathname}`,
    cut() {
      isCut = true;
    },
    upstreamClosed,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) =>
        relay.close(() => {
          resolve();
        }),
      );
    },
  };
}
