import { useState } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import { toast } from 'sonner';

export default function LocalCollection({
  mpId,
  directory: initialDirectory,
  name,
  search,
  selectedIds,
  onImported,
  showMetricsExport = true,
}: {
  mpId?: string;
  directory?: string | null;
  name?: string;
  search: string;
  selectedIds: Set<string>;
  onImported?: (message: string) => void;
  showMetricsExport?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [mpName, setMpName] = useState('');
  const utils = trpc.useUtils();
  const preview = trpc.collection.preview.useMutation();
  const importer = trpc.collection.importDirectory.useMutation();
  const exporter = trpc.collection.exportMetrics.useMutation();
  const busy = preview.isLoading || importer.isLoading;
  const reset = () => preview.reset();
  return (
    <>
      <Button
        size="sm"
        className="mac-btn-outline"
        onPress={() => {
          setDirectory(
            initialDirectory ||
              localStorage.getItem('wewe-collection-directory') ||
              '',
          );
          setMpName(name || '');
          reset();
          setOpen(true);
        }}
      >
        导入已有文件
      </Button>
      {showMetricsExport && (
        <Button
          size="sm"
          className="mac-btn-outline"
          isLoading={exporter.isLoading}
          onPress={async () => {
            try {
              const result = await exporter.mutateAsync({
                mpId,
                search: search || undefined,
                ids: selectedIds.size ? [...selectedIds] : undefined,
              });
              const url = URL.createObjectURL(
                new Blob([result.csv], { type: 'text/csv;charset=utf-8' }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = `公众号热度-${new Date().toISOString().slice(0, 10)}.csv`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              toast.success(`已导出 ${result.count} 篇文章的指标`);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          {selectedIds.size ? `导出热度 (${selectedIds.size})` : '导出热度 CSV'}
        </Button>
      )}
      <Modal
        isOpen={open}
        onOpenChange={setOpen}
        size="2xl"
        scrollBehavior="inside"
        isDismissable={!busy}
        hideCloseButton={busy}
      >
        <ModalContent>
          <ModalHeader>一次性导入已有文件</ModalHeader>
          <ModalBody>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                适用于迁移已经持有的 CSV 元数据和 HTML
                正文。填写文件所在的本机目录，可包含下三级子目录。
              </li>
              <li>
                先预览，再导入。本次导入不改变在线采集来源，也不会绑定目录或开启定时读取。
              </li>
            </ol>
            <p className="text-warning-700 text-sm">
              此入口只导入已有文件，不会登录微信或发起公众号批量采集。导入成功不代表历史、翻页及次条已完整获取。
            </p>
            <Input
              label="采集目录完整路径"
              placeholder="D:\公众号采集\某公众号"
              value={directory}
              isDisabled={busy}
              onValueChange={(v) => {
                setDirectory(v);
                reset();
              }}
            />
            <Input
              label="公众号名称（新公众号必填）"
              value={mpName}
              isDisabled={busy || !!mpId}
              onValueChange={(v) => {
                setMpName(v);
                reset();
              }}
            />
            {mpId && (
              <p className="text-default-500 text-sm">
                只导入当前公众号：{name}。其他公众号的 CSV 行会跳过。
              </p>
            )}
            <p className="text-default-500 text-sm">
              阅读、点赞、分享、评论、在看、收藏分别保存。源文件未提供的指标留空；分享不是收藏。“10万+”保留下限标记，数据文件时间不等于精确采集时间。
            </p>
            {preview.data && (
              <div
                className="bg-default-100 rounded-lg p-3 text-sm"
                aria-live="polite"
              >
                <p>
                  识别 {preview.data.csvFiles} 个 CSV、{preview.data.articles}{' '}
                  篇文章、{preview.data.bodies} 篇本地正文。
                </p>
                <p>
                  公众号：{preview.data.feeds.map((f) => f.name).join('、')}
                </p>
                {preview.data.bodies < preview.data.articles && (
                  <p className="text-warning-700 mt-2">
                    部分文章没有匹配的
                    HTML，导出时将尝试在线获取正文，可能失败。推荐先补齐 HTML。
                  </p>
                )}
                <ul className="mt-2 list-disc pl-5">
                  {preview.data.sample.map((a, i) => (
                    <li key={i}>{a.title}</li>
                  ))}
                </ul>
                {preview.data.warnings.slice(0, 10).map((w, i) => (
                  <p key={i} className="text-warning-700">
                    {w}
                  </p>
                ))}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              isDisabled={busy}
              onPress={() => setOpen(false)}
            >
              关闭
            </Button>
            <Button
              isLoading={preview.isLoading}
              isDisabled={importer.isLoading || !directory.trim()}
              onPress={async () => {
                try {
                  await preview.mutateAsync({
                    directory: directory.trim(),
                    mpId,
                    mpName,
                  });
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              预览
            </Button>
            <Button
              color="primary"
              isLoading={importer.isLoading}
              isDisabled={busy || !preview.data}
              onPress={async () => {
                try {
                  const result = await importer.mutateAsync({
                    directory: directory.trim(),
                    mpId,
                    mpName,
                  });
                  localStorage.setItem(
                    'wewe-collection-directory',
                    directory.trim(),
                  );
                  await Promise.all([
                    utils.feed.list.invalidate(),
                    utils.article.list.reset(),
                    utils.article.summary.invalidate(),
                  ]);
                  toast.success(result.message, { duration: 8000 });
                  onImported?.(result.message);
                  setOpen(false);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              导入一次
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
