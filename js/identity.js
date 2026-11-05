import { REQUIRED_SCOPES } from './constants.js';

const SCOPE_ALIASES = {
  openid: ['openid'],
  'https://www.googleapis.com/auth/userinfo.email': [
    'email',
    'https://www.googleapis.com/auth/userinfo.email'
  ],
  'https://www.googleapis.com/auth/userinfo.profile': [
    'profile',
    'https://www.googleapis.com/auth/userinfo.profile'
  ],
  'https://www.googleapis.com/auth/drive.file': [
    'https://www.googleapis.com/auth/drive.file'
  ]
};

export function grantedAll(scopeString) {
  const have = new Set(String(scopeString || '').split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.every((scope) => (SCOPE_ALIASES[scope] || [scope]).some((name) => have.has(name)));
}

export function createTokenStore(now = () => Date.now()) {
  let token = null;
  let expiresAt = 0;
  return {
    set(tokenResponse) {
      token = tokenResponse.access_token || null;
      const seconds = Number(tokenResponse.expires_in) || 3600;
      expiresAt = now() + seconds * 1000;
    },
    clear() {
      token = null;
      expiresAt = 0;
    },
    get() { return token; },
    fresh(skewMs = 60000) {
      return !!token && expiresAt - now() > skewMs;
    }
  };
}

/**
 * Confirms the access token belongs to one Google account.
 * The token is not written to storage. Caller keeps only sub/email/name.
 */
export async function identifyAccount(tokenResponse, fetchImpl) {
  if (!tokenResponse?.access_token) {
    return { ok: false, code: 'no_token', message: 'Google did not return an access token.' };
  }
  if (!grantedAll(tokenResponse.scope || '')) {
    return {
      ok: false,
      code: 'missing_scope',
      message: 'Grant email, profile, and Drive file access. Drive file access is required to create your private spreadsheet. Nothing was saved.'
    };
  }
  const response = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
  });
  if (response.status === 401) {
    return { ok: false, code: 'auth_expired', message: 'Google rejected the access token. Try connecting again.' };
  }
  if (!response.ok) {
    return { ok: false, code: 'userinfo_failed', message: 'Google did not confirm which account signed in. Nothing was saved.' };
  }
  const profile = await response.json();
  if (!profile || typeof profile.sub !== 'string' || !profile.sub) {
    return { ok: false, code: 'no_sub', message: 'Google did not return an account id, so data cannot be kept separate. Nothing was saved.' };
  }
  return {
    ok: true,
    session: {
      sub: profile.sub,
      email: typeof profile.email === 'string' ? profile.email : '',
      name: typeof profile.name === 'string' ? profile.name : ''
    }
  };
}
