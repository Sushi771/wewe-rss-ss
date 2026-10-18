import { Toaster } from 'sonner';
import { Outlet } from 'react-router-dom';

import Nav from '../components/Nav';
import StartupAuditNotice from '../components/StartupAuditNotice';

export function BaseLayout() {
  return (
    <div>
      <main className="h-screen overflow-hidden">
        <Nav></Nav>
        <div className="mx-auto flex h-[calc(100vh-44px)] max-w-[1280px] flex-col pb-0">
          <StartupAuditNotice />
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </div>
      </main>
      <Toaster richColors position="top-right" />
    </div>
  );
}
