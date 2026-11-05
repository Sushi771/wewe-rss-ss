import { Card, CardBody, Tab, Tabs } from '@nextui-org/react';
import { useLocation, useNavigate } from 'react-router-dom';
import ArticleDownload from './article-download';
import XiaohongshuDownload from './xiaohongshu-download';
import StorageBackupStatus from '@web/components/StorageBackupStatus';

export default function DownloadTools() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const platform = pathname.endsWith('/xiaohongshu-download')
    ? 'xiaohongshu'
    : 'wechat';

  return (
    <div className="h-full min-w-0 overflow-y-auto px-4 py-6 sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight">下载</h1>
          <p className="text-default-500 mt-1 text-sm">
            选择平台，粘贴链接并保存到本地。
          </p>
        </header>
        <Tabs
          aria-label="下载平台"
          destroyInactiveTabPanel={false}
          selectedKey={platform}
          onSelectionChange={(key) => {
            if (key === platform) return;
            navigate(
              key === 'xiaohongshu'
                ? '/tools/xiaohongshu-download'
                : '/tools/article-download',
            );
          }}
          classNames={{
            base: 'mb-4 w-full',
            tabList: 'w-full sm:w-auto',
            panel: 'p-0 data-[inert=true]:hidden',
          }}
        >
          {/* Keep both forms mounted: tab changes must not abort requests,
              cancel browser tasks, reset inputs, or restart task polling. */}
          <Tab key="wechat" title="公众号">
            <Card shadow="none" className="border-divider border">
              <CardBody className="p-4 sm:p-6">
                <section aria-label="公众号下载">
                  <ArticleDownload />
                </section>
              </CardBody>
            </Card>
          </Tab>
          <Tab key="xiaohongshu" title="小红书">
            <Card shadow="none" className="border-divider border">
              <CardBody className="p-4 sm:p-6">
                <section aria-label="小红书下载">
                  <XiaohongshuDownload />
                </section>
              </CardBody>
            </Card>
          </Tab>
        </Tabs>
        <StorageBackupStatus />
      </div>
    </div>
  );
}
