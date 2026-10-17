import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Feeds from './pages/feeds';
import Login from './pages/login';
import Accounts from './pages/accounts';
import { BaseLayout } from './layouts/base';
import { TrpcProvider } from './provider/trpc';
import ThemeProvider from './provider/theme';
import ArticleDownload from './pages/tools/article-download';

function App() {
  return (
    <BrowserRouter basename="/dash">
      <ThemeProvider>
        <TrpcProvider>
          <Routes>
            <Route path="/" element={<BaseLayout />}>
              <Route index element={<Feeds />} />
              <Route path="/feeds/:id?" element={<Feeds />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/tools" element={<ArticleDownload />} />
              <Route
                path="/tools/article-download"
                element={<ArticleDownload />}
              />
              <Route path="/login" element={<Login />} />
            </Route>
          </Routes>
        </TrpcProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}

export default App;
