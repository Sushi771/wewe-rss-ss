import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Feeds from './pages/feeds';
import Login from './pages/login';
import Accounts from './pages/accounts';
import { BaseLayout } from './layouts/base';
import { TrpcProvider } from './provider/trpc';
import ThemeProvider from './provider/theme';
import { privateOnlineMode } from './utils/env';

function App() {
  return (
    <BrowserRouter basename="/dash">
      <ThemeProvider>
        <TrpcProvider>
          <Routes>
            <Route path="/" element={<BaseLayout />}>
              <Route index element={<Feeds />} />
              <Route path="/feeds/:id?" element={<Feeds />} />
              {!privateOnlineMode && (
                <Route path="/accounts" element={<Accounts />} />
              )}
              <Route path="/login" element={<Login />} />
            </Route>
          </Routes>
        </TrpcProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}

export default App;
