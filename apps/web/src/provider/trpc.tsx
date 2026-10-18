import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpLink, loggerLink, splitLink } from '@trpc/client';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { toast } from 'sonner';
import { isTRPCClientError, trpc } from '../utils/trpc';
import { getAuthCode, setAuthCode } from '../utils/auth';
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
                  toast.error('无权限', {
                    description: error.message,
                  });

                  handleNoAuth();
                } else {
                  toast.error('请求失败!', {
                    description: error.message,
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
                  toast.error('无权限', {
                    description: error.message,
                  });
                  handleNoAuth();
                } else {
                  toast.error('请求失败!', {
                    description: error.message,
                  });
                }
              }
            },
          },
        },
      }),
  );

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
          // A batch responds only after its slowest procedure. Let each list
          // page render independently of summary/task/verification reads.
          condition: (operation) => operation.path === 'article.list',
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
