'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const DEFAULT_API_URL = 'https://api.plaud.cn';
const refreshes = new WeakMap();
const AUTH_STATUSES = new Set([-401, -419, -420]);

class AuthRequiredError extends Error {
  constructor(message = '需要重新登录') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

class PlaudApiError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'PlaudApiError';
    this.httpStatus = response?.statusCode;
    this.apiStatus = getApiStatus(response?.data);
    this.response = response;
  }
}

function createEmptySession() {
  return {
    version: 1,
    apiUrl: DEFAULT_API_URL,
    deviceId: crypto.randomBytes(8).toString('hex'),
    cookies: [],
    idHash: null,
    workspace: null,
  };
}

function normalizeCookieValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function defaultCookiePath(requestPath) {
  if (!requestPath || !requestPath.startsWith('/') || requestPath === '/') return '/';
  const lastSlash = requestPath.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : requestPath.slice(0, lastSlash);
}

function storeSetCookies(session, setCookieHeaders, requestUrl) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const url = new URL(requestUrl);

  for (const header of headers) {
    const parts = header.split(';').map((part) => part.trim());
    const separator = parts[0].indexOf('=');
    if (separator < 1) continue;

    const cookie = {
      name: parts[0].slice(0, separator),
      value: normalizeCookieValue(parts[0].slice(separator + 1)),
      domain: url.hostname,
      path: defaultCookiePath(url.pathname),
      hostOnly: true,
      secure: false,
      expiresAt: null,
    };
    let maxAge = null;

    for (const attribute of parts.slice(1)) {
      const attributeSeparator = attribute.indexOf('=');
      const key = (attributeSeparator < 0 ? attribute : attribute.slice(0, attributeSeparator))
        .trim()
        .toLowerCase();
      const value = attributeSeparator < 0 ? '' : attribute.slice(attributeSeparator + 1).trim();

      if (key === 'domain' && value) { cookie.domain = value.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; }
      if (key === 'path' && value) cookie.path = value;
      if (key === 'secure') cookie.secure = true;
      if (key === 'expires') {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) cookie.expiresAt = timestamp;
      }
      if (key === 'max-age') {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) maxAge = seconds;
      }
    }

    if (!cookieDomainMatches(url.hostname, cookie.domain)) continue;
    if (!cookie.hostOnly && cookie.domain !== 'plaud.cn' && !cookie.domain.endsWith('.plaud.cn')) continue;
    if (maxAge !== null) cookie.expiresAt = Date.now() + maxAge * 1000;
    const identityMatches = (item) => item.name === cookie.name
      && item.domain === cookie.domain
      && item.path === cookie.path;
    session.cookies = session.cookies.filter((item) => !identityMatches(item));

    if (cookie.value && (!cookie.expiresAt || cookie.expiresAt > Date.now())) {
      session.cookies.push(cookie);
    }
  }
}

function cookieDomainMatches(hostname, domain) {
  const normalized = domain.replace(/^\./, '').toLowerCase();
  const host = hostname.toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

function cookiePathMatches(requestPath, cookiePath) {
  if (cookiePath === '/') return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return requestPath.length === cookiePath.length
    || cookiePath.endsWith('/')
    || requestPath[cookiePath.length] === '/';
}

function cookieHeaderFor(session, requestUrl) {
  const url = new URL(requestUrl);
  const now = Date.now();
  session.cookies = session.cookies.filter((cookie) => !cookie.expiresAt || cookie.expiresAt > now);
  return session.cookies
    .filter((cookie) => cookie.hostOnly !== false ? url.hostname === cookie.domain : cookieDomainMatches(url.hostname, cookie.domain))
    .filter((cookie) => cookiePathMatches(url.pathname, cookie.path))
    .filter((cookie) => !cookie.secure || url.protocol === 'https:')
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function hasCookie(session, name) {
  const now = Date.now();
  return session.cookies.some((cookie) => cookie.name === name
    && cookie.value
    && (!cookie.expiresAt || cookie.expiresAt > now));
}

function commonHeaders(session) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    // The SMS endpoint may apply Web-client risk controls. These values match
    // the public browser client; authentication still uses server credentials.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    DNT: '1',
    'Sec-CH-UA': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'app-language': 'zh-cn',
    'app-platform': 'web',
    'edit-from': 'web',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-device-id': session.deviceId,
    'x-request-id': crypto.randomBytes(8).toString('base64url').toLowerCase(),
    Origin: 'https://web.plaud.cn',
    Referer: 'https://web.plaud.cn/',
  };
}

function rawRequest(requestUrl, options = {}) {
  const url = validateApiUrl(requestUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const body = options.body === undefined ? null : Buffer.from(options.body);
  const headers = { ...options.headers };
  if (body) headers['Content-Length'] = body.length;

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || 30_000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('响应连接中断')));
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { response.destroy(new Error('响应超过 32 MiB 限制')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
        }
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          data,
          text,
        });
      });
    });

    const deadline = setTimeout(() => request.destroy(new Error('请求超时')), options.timeout || 30_000);
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function getApiStatus(data) {
  if (!data || typeof data !== 'object') return null;
  const value = data.status ?? data.code;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function getApiMessage(data) {
  if (!data || typeof data !== 'object') return '';
  return data.msg || data.message || data.detail || '';
}

function responseSucceeded(response) {
  const apiStatus = getApiStatus(response.data);
  return response.statusCode >= 200
    && response.statusCode < 300
    && response.data !== null && typeof response.data === 'object' && !Array.isArray(response.data)
    && (apiStatus === null || apiStatus === 0);
}

function responseNeedsAuth(response) {
  const apiStatus = getApiStatus(response.data);
  return response.statusCode === 401 || response.statusCode === 403 || AUTH_STATUSES.has(apiStatus);
}

function apiError(label, response) {
  const message = getApiMessage(response.data);
  const apiStatus = getApiStatus(response.data);
  const statusDescription = apiStatus === null
    ? `HTTP ${response.statusCode}`
    : `HTTP ${response.statusCode}, API ${apiStatus}`;
  return new PlaudApiError(`${label}失败（${statusDescription}）${message ? `：${message}` : ''}`, response);
}

function extractDomainSwitch(data) {
  if (getApiStatus(data) !== -302 || !data || typeof data !== 'object') return null;
  return data.data?.domains?.api || data.data?.domain || data.domains?.api || data.domain || null;
}

async function apiRequest(session, endpoint, options = {}, redirectAttempt = 0) {
  const baseUrl = options.baseUrl || session.apiUrl || DEFAULT_API_URL;
  const requestUrl = endpoint.startsWith('http') ? endpoint : new URL(endpoint, baseUrl).toString();
  validateApiUrl(requestUrl);
  const headers = { ...commonHeaders(session), ...options.headers };
  const cookie = cookieHeaderFor(session, requestUrl);
  if (cookie) headers.Cookie = cookie;

  let body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['Content-Type'] = 'application/json';
  }

  const response = await rawRequest(requestUrl, {
    method: options.method || (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    timeout: options.timeout,
  });
  storeSetCookies(session, response.headers['set-cookie'], requestUrl);

  const switchedDomain = extractDomainSwitch(response.data);
  if (switchedDomain && redirectAttempt === 0) {
    validateApiUrl(switchedDomain);
    session.apiUrl = switchedDomain;
    if (session.workspace) session.workspace.domain = switchedDomain;
    return apiRequest(session, endpoint, { ...options, baseUrl: switchedDomain }, 1);
  }
  response.apiUrl = new URL(requestUrl).origin;
  return response;
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const compactToken = token.replace(/^Bearer\s+/i, '');
  const parts = compactToken.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function jwtExpiresAt(token) {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
}

function tokenIsUsable(token, storedExpiresAt, leewayMilliseconds = 60_000) {
  if (!token) return false;
  const expiresAt = jwtExpiresAt(token) || storedExpiresAt;
  return !expiresAt || expiresAt > Date.now() + leewayMilliseconds;
}

class PlaudClient {
  constructor(session = createEmptySession(), options = {}) {
    this.session = normalizeSession(session);
    this.options = options;
  }

  async persist() {
    await this.options.onSessionChange?.(this.session);
  }

  async sendSmsCode(phoneCode, phoneNumber) {
    const response = await apiRequest(this.session, '/auth/sms/code', {
      method: 'POST',
      json: {
        phone_code: phoneCode,
        phone_number: phoneNumber,
        client_id: 'web',
        source: 'login',
      },
    });
    if (!responseSucceeded(response)) throw apiError('发送验证码', response);
    const token = response.data?.token || response.data?.data?.token;
    if (!token) throw new Error('发送请求已被接受，但响应中没有找到登录 token。');
    return {
      token,
      message: getApiMessage(response.data),
      cooldown: Number(response.data?.data?.cooldown ?? response.data?.cooldown ?? 0),
    };
  }

  async login(phoneCode, phoneNumber, code, smsToken) {
    const response = await apiRequest(this.session, '/auth/login', {
      method: 'POST',
      json: {
        phone_code: phoneCode,
        phone_number: phoneNumber,
        code,
        token: smsToken,
      },
    });
    if (!responseSucceeded(response)) throw apiError('登录', response);
    if (!hasCookie(this.session, 'pld_ut')) {
      throw new Error('登录接口返回成功，但没有收到 pld_ut Cookie。');
    }
    await this.persist();
  }

  async refreshUserToken() {
    if (!hasCookie(this.session, 'pld_urt')) return false;
    const response = await apiRequest(this.session, '/auth/refresh-user-token', {
      method: 'POST',
      json: {},
    });
    if (!responseSucceeded(response)) {
      if (responseNeedsAuth(response)) return false;
      throw apiError('认证请求', response);
    }
    await this.persist();
    return hasCookie(this.session, 'pld_ut');
  }

  async fetchWorkspaces(allowRefresh = true) {
    let response = await apiRequest(
      this.session,
      '/team-app/workspaces/list?need_personal_workspace=true',
    );
    if (responseNeedsAuth(response) && allowRefresh && await this.refreshUserToken()) {
      response = await apiRequest(
        this.session,
        '/team-app/workspaces/list?need_personal_workspace=true',
      );
    }
    if (!responseSucceeded(response)) throw apiError('获取工作区', response);
    const workspaces = response.data?.data?.workspaces || response.data?.workspaces;
    if (!Array.isArray(workspaces)) throw new Error('工作区响应格式无效');
    return workspaces;
  }

  async chooseWorkspace(workspaces) {
    if (!workspaces.length) throw new Error('账号下没有可用工作区。');
    const previousId = this.session.workspace?.id;
    const previous = workspaces.find((workspace) => workspace.workspace_id === previousId);
    if (this.options.workspaceId) {
      const selected = workspaces.find((item) => (item.workspace_id || item.id) === this.options.workspaceId);
      if (!selected) throw new Error('找不到指定工作区');
      return selected;
    }
    if (previous) return previous;
    if (workspaces.length === 1) return workspaces[0];

    if (this.options.chooseWorkspace) return this.options.chooseWorkspace(workspaces);
    return workspaces.find((item) => String(item.workspace_type) === '0') || workspaces[0];
  }

  async fetchWorkspaceToken(workspace, allowRefresh = true) {
    const workspaceId = workspace.workspace_id || workspace.id;
    const domain = workspace.domain || workspace.domains?.api || this.session.apiUrl;
    validateApiUrl(domain);
    let response = await apiRequest(
      this.session,
      `/user-app/auth/workspace/token/${encodeURIComponent(workspaceId)}`,
      { method: 'POST', json: {}, baseUrl: domain },
    );
    if (responseNeedsAuth(response) && allowRefresh && await this.refreshUserToken()) {
      response = await apiRequest(
        this.session,
        `/user-app/auth/workspace/token/${encodeURIComponent(workspaceId)}`,
        { method: 'POST', json: {}, baseUrl: domain },
      );
    }
    if (!responseSucceeded(response)) {
      if (responseNeedsAuth(response)) return false;
      throw apiError('认证请求', response);
    }

    const data = response.data?.data || response.data;
    const token = data.workspace_token || data.access_token;
    if (!token) return false;
    this.session.workspace = {
      id: data.workspace_id || workspaceId,
      name: workspace.name || this.session.workspace?.name || '',
      domain: response.apiUrl,
      memberId: data.member_id || workspace.member_id || null,
      role: data.role || workspace.role || null,
      token,
      tokenExpiresAt: data.wt_expires_at
        ? data.wt_expires_at * 1000
        : Date.now() + Number(data.expires_in || 86400) * 1000,
      refreshToken: data.refresh_token || null,
      refreshExpiresAt: data.refresh_expires_at
        ? data.refresh_expires_at * 1000
        : Date.now() + Number(data.refresh_expires_in || 0) * 1000,
    };
    await this.persist();
    await this.loadIdHashBestEffort();
    return true;
  }

  async refreshWorkspaceToken() {
    const workspace = this.session.workspace;
    if (!workspace?.id || !tokenIsUsable(workspace.refreshToken, workspace.refreshExpiresAt)) {
      return false;
    }
    const response = await apiRequest(
      this.session,
      `/user-app/auth/workspace/refresh/${encodeURIComponent(workspace.id)}`,
      {
        method: 'POST',
        json: {},
        baseUrl: workspace.domain || this.session.apiUrl,
        headers: { Authorization: `Bearer ${workspace.refreshToken.replace(/^Bearer\s+/i, '')}` },
      },
    );
    if (!responseSucceeded(response)) {
      if (responseNeedsAuth(response)) return false;
      throw apiError('认证请求', response);
    }
    const data = response.data?.data || response.data;
    const token = data.workspace_token || data.access_token;
    if (!token) return false;

    workspace.token = token;
    workspace.tokenExpiresAt = data.wt_expires_at
      ? data.wt_expires_at * 1000
      : Date.now() + Number(data.expires_in || 86400) * 1000;
    if (data.refresh_token) workspace.refreshToken = data.refresh_token;
    if (data.refresh_expires_at) workspace.refreshExpiresAt = data.refresh_expires_at * 1000;
    if (data.refresh_expires_in) {
      workspace.refreshExpiresAt = Date.now() + Number(data.refresh_expires_in) * 1000;
    }
    await this.persist();
    return true;
  }

  async loadIdHashBestEffort() {
    if (!this.session.workspace?.token) return;
    try {
      const response = await this.workspaceRequestRaw('/user/me');
      const idHash = response.data?.data_user?.id_hash
        || response.data?.data?.basic?.id_hash
        || response.data?.data?.id_hash;
      if (idHash) {
        this.session.idHash = idHash;
        await this.persist();
      }
    } catch {
      // x-pld-user is optional for listing and downloading, so profile failure is non-fatal.
    }
  }

  async setupWorkspace() {
    const workspaces = await this.fetchWorkspaces();
    const workspace = await this.chooseWorkspace(workspaces);
    if (!await this.fetchWorkspaceToken(workspace)) {
      throw new AuthRequiredError('无法取得工作区令牌');
    }
  }

  async recoverWorkspaceToken() {
    const existing = refreshes.get(this.session);
    if (existing) return existing;
    const pending = this.recoverWorkspaceTokenOnce();
    refreshes.set(this.session, pending);
    try { return await pending; }
    finally { if (refreshes.get(this.session) === pending) refreshes.delete(this.session); }
  }

  async recoverWorkspaceTokenOnce() {
    if (await this.refreshWorkspaceToken()) return true;

    const existing = this.session.workspace;
    if (existing?.id && hasCookie(this.session, 'pld_ut')) {
      if (await this.fetchWorkspaceToken({
        id: existing.id,
        workspace_id: existing.id,
        name: existing.name,
        domain: existing.domain,
        member_id: existing.memberId,
        role: existing.role,
      })) return true;
    }

    if (hasCookie(this.session, 'pld_urt') && await this.refreshUserToken()) {
      if (existing?.id && await this.fetchWorkspaceToken({
        id: existing.id,
        workspace_id: existing.id,
        name: existing.name,
        domain: existing.domain,
        member_id: existing.memberId,
        role: existing.role,
      }, false)) return true;
    }

    if (hasCookie(this.session, 'pld_ut') || hasCookie(this.session, 'pld_urt')) {
      try {
        await this.setupWorkspace();
        return true;
      } catch (error) {
        if (!(error instanceof PlaudApiError) || !responseNeedsAuth(error.response)) throw error;
      }
    }
    return false;
  }

  async workspaceRequestRaw(endpoint, options = {}) {
    const workspace = this.session.workspace;
    if (!workspace?.token) throw new AuthRequiredError();
    const token = workspace.token.replace(/^Bearer\s+/i, '');
    const headers = {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    };
    if (this.session.idHash) headers['x-pld-user'] = this.session.idHash;
    return apiRequest(this.session, endpoint, {
      ...options,
      headers,
      baseUrl: workspace.domain || this.session.apiUrl,
    });
  }

  async workspaceRequest(endpoint, options = {}) {
    const workspace = this.session.workspace;
    if (!tokenIsUsable(workspace?.token, workspace?.tokenExpiresAt)) {
      if (!await this.recoverWorkspaceToken()) throw new AuthRequiredError();
    }

    let response = await this.workspaceRequestRaw(endpoint, options);
    if (responseNeedsAuth(response)) {
      if (!await this.recoverWorkspaceToken()) throw new AuthRequiredError();
      response = await this.workspaceRequestRaw(endpoint, options);
    }
    if (!responseSucceeded(response)) throw apiError('Plaud API 请求', response);
    return response;
  }

  async listFiles(options = {}) {
    const skip = options.skip ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('skip 必须为非负整数，limit 必须为正整数');
    }
    const query = new URLSearchParams({skip: String(skip), limit: String(limit),
      is_trash: String(options.isTrash ?? 2), sort_by: options.sortBy || 'start_time',
      is_desc: String(options.descending ?? true)});
    const response = await this.workspaceRequest(`/file/simple/web?${query}`);
    const files = response.data?.data_file_list ?? response.data?.data?.data_file_list;
    if (!Array.isArray(files)) throw new Error('录音列表响应格式无效');
    return files;
  }

  async listAllFiles(options = {}) {
    const files = [];
    const seen = new Set();
    let skip = options.skip ?? 0;
    for (;;) {
      const page = await this.listFiles({...options, skip});
      if (!page.length) return files;
      for (const file of page) {
        if (!file || typeof file.id !== 'string' || seen.has(file.id)) {
          throw new Error('分页返回重复或无效文件 ID，请重试');
        }
        seen.add(file.id);
        files.push(file);
      }
      skip += page.length;
    }
  }

  async getTemporaryUrl(fileId) {
    if (typeof fileId !== 'string' || !fileId.trim()) throw new Error('fileId 必须是非空字符串');
    fileId = fileId.trim();
    const response = await this.workspaceRequest(`/file/temp-url/${encodeURIComponent(fileId)}`);
    const temporaryUrl = response.data?.temp_url
      || response.data?.data?.temp_url
      || response.data?.temp_url_opus
      || response.data?.data?.temp_url_opus;
    if (!temporaryUrl) throw new Error(`文件 ${fileId} 没有可用的临时下载地址。`);
    return temporaryUrl;
  }
}


function validateApiUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(url.hostname === 'api.plaud.cn' || url.hostname.endsWith('.plaud.cn'))) {
    throw new Error('API 地址必须为 Plaud 中国区 HTTPS 域名');
  }
  return url;
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('凭据格式无效');
  session.apiUrl ||= DEFAULT_API_URL;
  const url = validateApiUrl(session.apiUrl);
  session.deviceId ||= crypto.randomBytes(8).toString('hex');
  if (!Array.isArray(session.cookies)) {
    session.cookies = Object.entries(session.cookies || {}).map(([name, value]) => ({
      name, value, domain: url.hostname, path: '/', hostOnly: true, secure: true, expiresAt: null,
    }));
  }
  session.cookies = session.cookies.filter((cookie) => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string' && typeof cookie.path === 'string');
  for (const cookie of session.cookies) {
    cookie.hostOnly ??= !cookie.domain.startsWith('.');
    cookie.domain = cookie.domain.replace(/^\./, '').toLowerCase();
  }
  if (session.workspace) {
    session.workspace.tokenExpiresAt ??= session.workspace.expiresAt;
    delete session.workspace.expiresAt;
    if (session.workspace.domain) validateApiUrl(session.workspace.domain);
  }
  session.version = 2;
  return session;
}

module.exports = { PlaudClient, AuthRequiredError, PlaudApiError, createEmptySession,
  normalizeSession, responseNeedsAuth, cookieHeaderFor, storeSetCookies, decodeJwtPayload,
  tokenIsUsable, responseSucceeded, validateApiUrl };
