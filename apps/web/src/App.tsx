import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { ReactNode } from 'react';
import Feeds from './pages/feeds';
import Login from './pages/login';
import Accounts from './pages/accounts';
import { BaseLayout } from './layouts/base';
import { TrpcProvider } from './provider/trpc';
import ThemeProvider from './provider/theme';
import ArticleDownload from './pages/tools/article-download';
import XiaohongshuDownload from './pages/tools/xiaohongshu-download';
import Xiaohongshu from './pages/feeds/xiaohongshu';

function ArticleToolsLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <nav
        aria-label="单篇下载工具"
        className="border-divider flex shrink-0 flex-wrap gap-2 border-b p-3"
      >
        {[
          { href: '/tools/article-download', name: '公众号单篇下载' },
          { href: '/tools/xiaohongshu-download', name: '小红书单篇下载' },
        ].map((item) => (
          <Link
            key={item.href}
            to={item.href}
            className={`mac-nav-pill text-sm ${pathname === item.href || (pathname === '/tools' && item.href === '/tools/article-download') ? 'active' : ''}`}
          >
            {item.name}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter basename="/dash">
      <ThemeProvider>
        <TrpcProvider>
          <Routes>
            <Route path="/" element={<BaseLayout />}>
              <Route index element={<Feeds />} />
              <Route path="/feeds/:id?" element={<Feeds />} />
              <Route path="/xiaohongshu" element={<Xiaohongshu />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route
                path="/tools"
                element={
                  <ArticleToolsLayout>
                    <ArticleDownload />
                  </ArticleToolsLayout>
                }
              />
              <Route
                path="/tools/article-download"
                element={
                  <ArticleToolsLayout>
                    <ArticleDownload />
                  </ArticleToolsLayout>
                }
              />
              <Route
                path="/tools/xiaohongshu-download"
                element={
                  <ArticleToolsLayout>
                    <XiaohongshuDownload />
                  </ArticleToolsLayout>
                }
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
