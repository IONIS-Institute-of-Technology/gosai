import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ServerClient, type ConnectionStatus } from '@gosai/shared/client';
import type { EventPayload } from '@gosai/shared/protocol';
import { SERVER_TOKEN, SERVER_WS_URL } from './server-url.js';

const DEFAULT_URL = SERVER_WS_URL;

interface ServerContextValue {
  client: ServerClient;
  status: ConnectionStatus;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({
  url = DEFAULT_URL,
  children,
}: {
  url?: string;
  children: ReactNode;
}): React.ReactElement {
  const client = useMemo(() => new ServerClient({ url, token: SERVER_TOKEN }), [url]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  useEffect(() => {
    const off = client.onStatus(setStatus);
    client.connect();
    return () => {
      off();
      client.close();
    };
  }, [client]);

  const value = useMemo(() => ({ client, status }), [client, status]);
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer must be used within ServerProvider');
  return ctx;
}

export function useServerEvent<E extends string>(
  event: E,
  listener: (payload: EventPayload<E>) => void,
): void {
  const { client } = useServer();
  useEffect(() => client.on(event, listener), [client, event, listener]);
}
