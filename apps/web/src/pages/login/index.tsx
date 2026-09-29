import { Button, Input } from '@nextui-org/react';
import { setAuthCode } from '@web/utils/auth';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { privateOnlineMode, serverOriginUrl } from '@web/utils/env';
import { toast } from 'sonner';

const LoginPage = () => {
  const [codeValue, setCodeValue] = useState('');

  const navigate = useNavigate();

  return (
    <div className="rounded-large bg-content1 shadow-small m-auto mt-[10vh] flex w-full max-w-sm flex-col gap-4 px-8 pb-10 pt-6">
      <Input
        value={codeValue}
        onValueChange={setCodeValue}
        label="AuthCode"
        placeholder="请输入auth code"
      />
      <Button
        color="primary"
        onPress={async () => {
          if (privateOnlineMode) {
            const response = await fetch(`${serverOriginUrl}/auth/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ code: codeValue }),
            });
            if (!response.ok) {
              toast.error('登录码无效');
              return;
            }
            setCodeValue('');
            window.location.assign('/dash/');
            return;
          }
          setAuthCode(codeValue);
          navigate('/');
        }}
      >
        确认
      </Button>
    </div>
  );
};

export default LoginPage;
