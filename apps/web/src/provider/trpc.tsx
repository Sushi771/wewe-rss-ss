import { FailureNotice } from '../components/OperationNotice';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpLink, loggerLink, splitLink } from '@trpc/client';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { installReadingCacheBudget } from '../utils/reading-query-cache';
import { toast } from 'sonner';
import { isTRPCClientError, trpc } from '../utils/trpc';
import { getAuthCode, setAuthCode } from '../utils/auth';
import {
  isStorageFailure,
  STORAGE_DETAILS_PATH,
} from '../utils/startup-status';
import {
  enabledAuthCode,
  privateOnlineMode,
  serverOriginUrl,
} from '../utils/env';

export const TrpcProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const navigate = useNavigate();

  const handleNoAuth = () => {
    if (enabledAuthCode) {
      setAuthCode('');
      navigate('/login');
    }
  };
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            refetchIntervalInBackground: false,
            retryDelay: (retryCount) => Math.min(retryCount * 1000, 60 * 1000),
            retry(failureCount, error) {
              console.log('failureCount: ', failureCount);
              if (isTRPCClientError(error)) {
                if (error.data?.httpStatus === 401) {
                  return false;
                }
              }
              return failureCount < 3;
            },
            onError(error) {
              console.error('queries onError: ', error);
              if (isTRPCClientError(error)) {
                if (error.data?.httpStatus === 401) {
                  toast.error('登录已失效或无权操作，请检查账号。', {
                    id: 'wewe-auth-required',
                    description: <FailureNotice error={error} />,
                  });

                  handleNoAuth();
                } else if (isStorageFailure(error.message)) {
                  toast.error('存储空间受限，本次操作未完成。', {
                    id: 'wewe-storage-limited',
                    action: {
                      label: '查看详情',
                      onClick: () => navigate(STORAGE_DETAILS_PATH),
                    },
                  });
                } else {
                  toast.error('请求未完成，请查看状态和详情。', {
                    description: <FailureNotice error={error} />,
                  });
                }
              }
            },
          },
          mutations: {
            onError(error) {
              console.error('mutations onError: ', error);
              if (isTRPCClientError(error)) {
                if (error.data?.httpStatus === 401) {
                  toast.error('登录已失效或无权操作，请检查账号。', {
                    id: 'wewe-auth-required',
                    description: <FailureNotice error={error} />,
                  });
                  handleNoAuth();
                } else if (isStorageFailure(error.message)) {
                  toast.error('存储空间受限，本次操作未完成。', {
                    id: 'wewe-storage-limited',
                    action: {
                      label: '查看详情',
                      onClick: () => navigate(STORAGE_DETAILS_PATH),
                    },
                  });
                } else {
                  toast.error('请求未完成，请查看状态和详情。', {
                    description: <FailureNotice error={error} />,
                  });
                }
              }
            },
          },
        },
      }),
  );

  useEffect(() => installReadingCacheBudget(queryClient), [queryClient]);

  const [trpcClient] = useState(() => {
    const transport = {
      url: serverOriginUrl + '/trpc',
      async headers() {
        if (privateOnlineMode) return {};
        const token = getAuthCode();
        if (!token) {
          handleNoAuth();
          return {};
        }
        return { Authorization: `${token}` };
      },
    };
    return trpc.createClient({
      links: [
        loggerLink({
          enabled: () => true,
        }),
        splitLink({
          // Each reading response must be independent of slower background
          // tasks in the same batch. Auth, cache and cancellation stay shared.
          condition: (operation) =>
            ['article.list', 'article.summary', 'article.byId'].includes(
              operation.path,
            ),
          true: httpLink(transport),
          false: httpBatchLink(transport),
        }),
      ],
    });
  });
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
};
