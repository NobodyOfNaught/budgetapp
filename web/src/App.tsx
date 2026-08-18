import { ConfirmSignIn } from './pages/ConfirmSignIn';
import { Home } from './pages/Home';

// No router library yet — there are exactly two screens until the budget
// screen (a later PR) actually needs client-side navigation between more
// than "signed out / signed in" and "confirming a magic link".
export function App() {
  const isConfirmPage = window.location.pathname === '/auth/confirm';

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '32rem' }}>
      {isConfirmPage ? <ConfirmSignIn /> : <Home />}
    </main>
  );
}
