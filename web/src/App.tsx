import { ConfirmSignIn } from './pages/ConfirmSignIn';
import { Home } from './pages/Home';

// No router library yet — there are exactly two top-level screens (confirm
// a magic link, or everything else); switching accounts within the budget
// view is local React state (see Budget.tsx), not a URL route.
export function App() {
  const isConfirmPage = window.location.pathname === '/auth/confirm';

  return (
    <main className="app-shell" style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '75rem' }}>
      {isConfirmPage ? <ConfirmSignIn /> : <Home />}
    </main>
  );
}
