export const isProd = import.meta.env.PROD;

export const serverOriginUrl = isProd
  ? window.__WEWE_RSS_SERVER_ORIGIN_URL__
  : import.meta.env.VITE_SERVER_ORIGIN_URL;

export const appVersion = __APP_VERSION__;

export const acceptanceMode =
  window.__WEWE_RSS_ACCEPTANCE_MODE__ === true ||
  window.__WEWE_RSS_ACCEPTANCE_MODE__ === 'true';

export const privateOnlineMode =
  window.__WEWE_RSS_PRIVATE_ONLINE_MODE__ === true ||
  window.__WEWE_RSS_PRIVATE_ONLINE_MODE__ === 'true';

export const enabledAuthCode =
  window.__WEWE_RSS_ENABLED_AUTH_CODE__ === false ||
  window.__WEWE_RSS_ENABLED_AUTH_CODE__ === 'false' ||
  window.__WEWE_RSS_ENABLED_AUTH_CODE__ === ''
    ? false
    : true;
