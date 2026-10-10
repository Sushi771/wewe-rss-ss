import {
  Button,
  Image,
  Link,
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  Tooltip,
} from '@nextui-org/react';
import { ThemeSwitcher } from './ThemeSwitcher';
import { UserIcon } from './UserIcon';
import { useLocation, Link as RouterLink } from 'react-router-dom';
import { appVersion, privateOnlineMode, serverOriginUrl } from '@web/utils/env';

const navbarItemLink = [
  {
    href: '/feeds',
    name: '公众号源',
  },
  {
    href: '/xiaohongshu',
    name: '小红书',
  },
  {
    href: '/tools',
    name: '工具',
  },
];

const Nav = () => {
  const { pathname } = useLocation();

  return (
    <div>
      <Navbar isBordered={false} className="mac-toolbar">
        <Tooltip
          content={<div className="p-1">当前版本: v{appVersion}</div>}
          placement="left"
        >
          <NavbarBrand
            className="cursor-default"
            style={{ flexGrow: 0, marginRight: '16px' }}
          >
            <Image
              width={22}
              alt="WeWe RSS"
              className="mr-2"
              src={
                serverOriginUrl
                  ? `${serverOriginUrl}/favicon.ico`
                  : 'https://r2-assets.111965.xyz/wewe-rss.png'
              }
            ></Image>
            <p
              className="font-semibold text-inherit"
              style={{ fontSize: '15px', letterSpacing: '-0.01em' }}
            >
              WeWe RSS
            </p>
          </NavbarBrand>
        </Tooltip>

        {/* macOS-style pill navigation */}
        <NavbarContent className="flex" justify="center">
          <div className="mac-nav-pills flex gap-3">
            {navbarItemLink.map((item) => (
              <RouterLink
                key={item.href}
                to={item.href}
                className={`mac-nav-pill whitespace-nowrap ${item.href === '/feeds' ? 'hidden sm:inline-flex' : ''} ${pathname.startsWith(item.href) ? 'active text-primary font-medium' : ''}`}
              >
                {item.name}
              </RouterLink>
            ))}
          </div>
        </NavbarContent>

        <NavbarContent justify="end" style={{ gap: '12px' }}>
          {pathname !== '/login' && (
            <NavbarItem>
              <Tooltip content="账号管理">
                <Link
                  as={RouterLink}
                  to="/accounts"
                  color="foreground"
                  style={{ opacity: 0.7 }}
                  className={
                    pathname.startsWith('/accounts')
                      ? 'text-primary opacity-100'
                      : ''
                  }
                >
                  <UserIcon />
                </Link>
              </Tooltip>
            </NavbarItem>
          )}
          {privateOnlineMode && pathname !== '/login' && (
            <NavbarItem>
              <Button
                size="sm"
                variant="light"
                onPress={async () => {
                  await fetch(`${serverOriginUrl}/auth/logout`, {
                    method: 'POST',
                    credentials: 'same-origin',
                  });
                  window.location.assign('/dash/login');
                }}
              >
                退出登录
              </Button>
            </NavbarItem>
          )}
          <NavbarItem>
            <ThemeSwitcher></ThemeSwitcher>
          </NavbarItem>
        </NavbarContent>
      </Navbar>
    </div>
  );
};

export default Nav;
