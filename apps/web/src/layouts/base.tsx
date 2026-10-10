import { Toaster } from 'sonner';
import { Outlet } from 'react-router-dom';

import Nav from '../components/Nav';
import OwnerVerificationNotice from '../components/OwnerVerificationNotice';

export function BaseLayout() {
  return (
    <div>
      <main className="app-shell">
        <Nav></Nav>
        <div className="app-route mx-auto max-w-[1280px] pb-0">
          <Outlet />
        </div>
      </main>
      <Toaster richColors position="top-right" />
      <OwnerVerificationNotice />
    </div>
  );
}
