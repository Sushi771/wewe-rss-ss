import {
  Badge,
  Image,
  Link,
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  Tooltip,
} from '@nextui-org/react';
import { ThemeSwitcher } from './ThemeSwitcher';
import { GitHubIcon } from './GitHubIcon';
import { useLocation, Link as RouterLink } from 'react-router-dom';
import { appVersion, serverOriginUrl } from '@web/utils/env';
import { useEffect, useState } from 'react';

const navbarItemLink = [
  {
    href: '/feeds',
    name: '公众号源',
  },
  {
    href: '/accounts',
    name: '账号管理',
  },
];

const Nav = () => {
  const { pathname } = useLocation();
  const [releaseVersion, setReleaseVersion] = useState(appVersion);

  useEffect(() => {
    fetch('https://api.github.com/repos/cooderl/wewe-rss/releases/latest')
      .then((res) => res.json())
      .then((data) => {
        setReleaseVersion(data.name.replace('v', ''));
      });
  }, []);

  const isFoundNewVersion = releaseVersion > appVersion;
  console.log('isFoundNewVersion: ', isFoundNewVersion);

  return (
    <div>
      <Navbar
        isBordered={false}
        className="navbar-glass mac-nav-override"
        style={{
          minHeight: '44px',
          maxHeight: '44px',
          height: '44px',
          borderBottom: '0.5px solid var(--mac-separator-opaque)',
        }}
      >
        <Tooltip
          content={
            <div className="p-1">
              {isFoundNewVersion && (
                <Link
                  href={`https://github.com/cooderl/wewe-rss/releases/latest`}
                  target="_blank"
                  className="mb-1 block text-medium"
                >
                  发现新版本：v{releaseVersion}
                </Link>
              )}
              当前版本: v{appVersion}
            </div>
          }
          placement="left"
        >
          <NavbarBrand className="cursor-default" style={{ flexGrow: 0, marginRight: '16px' }}>
            <Badge
              content={isFoundNewVersion ? '' : null}
              color="danger"
              size="sm"
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
            </Badge>
            <p
              className="font-semibold text-inherit"
              style={{ fontSize: '15px', letterSpacing: '-0.01em' }}
            >
              WeWe RSS
            </p>
          </NavbarBrand>
        </Tooltip>

        {/* macOS-style pill navigation */}
        <NavbarContent className="hidden sm:flex" justify="center">
           <div className="mac-nav-pills">
            {navbarItemLink.map((item) => (
              <RouterLink
                key={item.href}
                to={item.href}
                className={`mac-nav-pill ${pathname.startsWith(item.href) ? 'active' : ''}`}
              >
                {item.name}
              </RouterLink>
            ))}
          </div>
        </NavbarContent>

        <NavbarContent justify="end" style={{ gap: '8px' }}>
          <NavbarItem>
            <ThemeSwitcher></ThemeSwitcher>
          </NavbarItem>
          <NavbarItem>
            <Link
              href="https://github.com/cooderl/wewe-rss"
              target="_blank"
              color="foreground"
              style={{ opacity: 0.7 }}
            >
              <GitHubIcon />
            </Link>
          </NavbarItem>
        </NavbarContent>
      </Navbar>
    </div>
  );
};

export default Nav;
