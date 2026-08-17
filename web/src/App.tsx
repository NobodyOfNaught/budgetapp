import { useEffect, useState } from 'react';

type HealthResponse = {
  status: string;
  environment: string;
  time: string;
};

// Placeholder shell for the Foundation PR: proves the SPA is served by the
// Worker and can reach the API/D1 through it. Replaced by real screens
// (auth, budget, register) in later PRs.
export function App() {
  const [health, setHealth] = useState<HealthResponse | 'loading' | 'error'>('loading');

  useEffect(() => {
    fetch('/api/v1/health')
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json() as Promise<HealthResponse>;
      })
      .then(setHealth)
      .catch(() => setHealth('error'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>budgetapp</h1>
      <p>Foundation scaffold. API health check:</p>
      <pre>{typeof health === 'string' ? health : JSON.stringify(health, null, 2)}</pre>
    </main>
  );
}
