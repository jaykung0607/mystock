import { useEffect, useState } from 'react';
import type { MeResponse } from '@mystock/shared';
import { apiGet } from './api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; me: MeResponse['user'] }
  | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    apiGet<MeResponse>('/me')
      .then(({ user }) => setState({ kind: 'ready', me: user }))
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  return (
    <main className="app">
      <h1>家庭股市帳本</h1>
      {state.kind === 'loading' && <p>載入中…</p>}
      {state.kind === 'error' && <p className="error">{state.message}</p>}
      {state.kind === 'ready' && (
        <p>
          嗨，{state.me.display_name}（{state.me.role === 'admin' ? '管理者' : '小孩'}）
        </p>
      )}
    </main>
  );
}
