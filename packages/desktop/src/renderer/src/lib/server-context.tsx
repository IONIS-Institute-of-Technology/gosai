import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ServerClient, type ConnectionStatus } from './server-client.js';

const DEFAULT_URL = 'ws://127.0.0.1:7777/ws';

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
  const client = useMemo(() => new ServerClient({ url }), [url]);
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

export function useServerEvent<T = unknown>(event: string, listener: (payload: T) => void): void {
  const { client } = useServer();
  useEffect(() => {
    const off = client.on(event, (payload) => listener(payload as T));
    return off;
  }, [client, event, listener]);
}
