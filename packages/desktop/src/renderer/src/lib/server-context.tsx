import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ServerClient, type ConnectionStatus } from '@gosai/shared/client';
import { SERVER_TOKEN, SERVER_WS_URL } from './server-url.js';

interface ServerContextValue {
  client: ServerClient;
  status: ConnectionStatus;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: ReactNode }): React.ReactElement {
  const client = useMemo(() => new ServerClient({ url: SERVER_WS_URL, token: SERVER_TOKEN }), []);
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
