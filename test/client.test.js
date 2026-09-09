'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const sdk = require('../plaudsdk');
const {cookieHeaderFor, storeSetCookies, responseSucceeded, validateApiUrl} = require('../lib/client');

function credential() {
  return {...sdk.createEmptySession(), workspace: {id: 'test', token: 'synthetic', tokenExpiresAt: Date.now() + 3600000}};
}
async function serverTest(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  t.mock.method(https, 'request', (url, options, callback) => http.request(
    new URL(url.pathname + url.search, `http://127.0.0.1:${server.address().port}`), options, callback));
}
function json(res, data, status = 200) { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(data)); }

test('legacy SDK credentials migrate in place', () => {
  const value = {apiUrl:'https://api.plaud.cn', cookies:{pld_ut:'synthetic'}, workspace:{expiresAt:123}};
  assert.equal(sdk.normalizeSession(value), value);
  assert.equal(value.version, 2);
  assert.equal(value.workspace.tokenExpiresAt, 123);
  assert.equal(value.cookies[0].hostOnly, true);
});
test('host-only, domain, path, expiry and secure cookies', () => {
  const session = sdk.createEmptySession();
  storeSetCookies(session, ['a=test; Path=/; Secure', 'b=test; Domain=.plaud.cn; Path=/auth; Secure', 'bad=test; Domain=evil.test'], 'https://api.plaud.cn/auth/login');
  assert.equal(cookieHeaderFor(session, 'https://child.api.plaud.cn/'), '');
  assert.equal(cookieHeaderFor(session, 'https://web.plaud.cn/auth/refresh'), 'b=test');
  assert.equal(cookieHeaderFor(session, 'http://api.plaud.cn/'), '');
  storeSetCookies(session, ['a=gone; Max-Age=0; Path=/'], 'https://api.plaud.cn/');
  assert.equal(cookieHeaderFor(session, 'https://api.plaud.cn/'), '');
});
test('reject malformed successful responses and string error codes', async t => {
  assert.equal(responseSucceeded({statusCode:200,data:null}), false);
  assert.equal(responseSucceeded({statusCode:200,data:{status:'-401'}}), false);
  await serverTest(t, (_req,res) => json(res, {status:0}));
  await assert.rejects(sdk.listFiles(credential()), /响应格式/);
});
test('API destinations reject credential forwarding outside HTTPS Plaud CN', () => {
  for (const url of ['http://api.plaud.cn', 'https://plaud.cn.evil.test', 'https://user:pass@api.plaud.cn', 'https://api.plaud.cn:8443']) {
    assert.throws(() => validateApiUrl(url));
  }
});
test('SMS login and SDK/CLI credential lifecycle share one client', async t => {
  await serverTest(t, (req,res) => {
    if (req.url === '/auth/sms/code') return json(res,{status:0,token:'synthetic-sms'});
    if (req.url === '/auth/login') {
      res.setHeader('set-cookie',['pld_ut=synthetic; Path=/; Secure','pld_urt=synthetic-refresh; Path=/; Secure']);
      return json(res,{status:0});
    }
    if (req.url.startsWith('/team-app/')) return json(res,{data:{workspaces:[{workspace_id:'test',workspace_type:0}]}});
    if (req.url.startsWith('/user-app/auth/workspace/token/')) return json(res,{workspace_token:'synthetic-workspace',expires_in:3600});
    if (req.url === '/user/me') return json(res,{data:{id_hash:'synthetic-hash'}});
    json(res,{data_file_list:[]});
  });
  const challenge = await sdk.sendCode('13800138000');
  const session = await sdk.login(challenge,'123456');
  assert.equal(session.workspace.id,'test');
  assert.equal(session.version,2);
  assert.deepEqual(await sdk.listFiles(session),[]);
});
test('401 refreshes once and persists updated token', async t => {
  let refreshed = 0, calls = 0, saved = 0;
  await serverTest(t, (req,res) => {
    if (req.url.includes('/workspace/refresh/')) {refreshed++; return json(res,{workspace_token:'new-token',expires_in:3600});}
    calls++;
    if (req.headers.authorization === 'Bearer synthetic') return json(res,{status:'-401'});
    json(res,{data_file_list:[]});
  });
  const session = credential();
  Object.assign(session.workspace,{refreshToken:'synthetic-refresh',refreshExpiresAt:Date.now()+3600000});
  const client = new sdk.PlaudClient(session,{onSessionChange:()=>{saved++;}});
  assert.deepEqual(await client.listFiles(),[]);
  assert.equal(refreshed,1); assert.equal(calls,2); assert.equal(saved,1);
});
test('pagination follows server caps until empty and rejects repeated IDs', async () => {
  const client = new sdk.PlaudClient(credential());
  const skips = [];
  client.listFiles = async ({skip}) => {skips.push(skip); return skip < 3 ? [{id:String(skip)}] : [];};
  assert.equal((await client.listAllFiles()).length,3);
  assert.deepEqual(skips,[0,1,2,3]);
  client.listFiles = async () => [{id:'same'}];
  await assert.rejects(client.listAllFiles(),/重复/);
});
test('aborted JSON response rejects instead of hanging', async t => {
  await serverTest(t, (_req,res) => {res.writeHead(200,{'content-length':'100'}); res.write('{'); setImmediate(()=>res.destroy());});
  await assert.rejects(sdk.listFiles(credential()));
});
test('concurrent expired-token requests share a refresh', async t => {
  let refreshCount = 0;
  await serverTest(t, (req,res) => {
    if (req.url.includes('/workspace/refresh/')) {
      refreshCount++;
      return setTimeout(()=>json(res,{workspace_token:'renewed',expires_in:3600}),10);
    }
    json(res,{data_file_list:[]});
  });
  const session = credential();
  Object.assign(session.workspace,{tokenExpiresAt:1,refreshToken:'synthetic',refreshExpiresAt:Date.now()+3600000});
  await Promise.all([sdk.listFiles(session),sdk.listFiles(session)]);
  assert.equal(refreshCount,1);
});
test('persistent authentication rejection retries only once', async t => {
  let calls = 0;
  await serverTest(t,(req,res)=>{
    if(req.url.includes('/workspace/refresh/')) return json(res,{workspace_token:'renewed',expires_in:3600});
    calls++; json(res,{status:-401},401);
  });
  const session = credential();
  Object.assign(session.workspace,{refreshToken:'synthetic',refreshExpiresAt:Date.now()+3600000});
  await assert.rejects(sdk.listFiles(session),sdk.PlaudApiError);
  assert.equal(calls,2);
});
test('user refresh fallback exchanges workspace token', async t => {
  const endpoints = [];
  await serverTest(t,(req,res)=>{
    endpoints.push(req.url);
    if(req.url === '/auth/refresh-user-token') {
      res.setHeader('set-cookie','pld_ut=renewed; Path=/; Secure');
      return json(res,{status:0});
    }
    if(req.url.includes('/workspace/token/')) return json(res,{workspace_token:'renewed',expires_in:3600});
    if(req.url === '/user/me') return json(res,{status:0});
    json(res,{data_file_list:[]});
  });
  const session = credential();
  session.workspace.tokenExpiresAt = 1;
  storeSetCookies(session,['pld_urt=synthetic; Path=/; Secure'],'https://api.plaud.cn/');
  assert.deepEqual(await sdk.listFiles(session),[]);
  assert.equal(endpoints[0],'/auth/refresh-user-token');
  assert.equal(session.workspace.token,'renewed');
});
test('domain switch persists the actual token endpoint domain', async t => {
  let exchanges = 0;
  await serverTest(t,(req,res)=>{
    if(req.url.includes('/workspace/token/')) {
      if(exchanges++ === 0) return json(res,{status:-302,domain:'https://regional.plaud.cn'});
      return json(res,{workspace_token:'renewed',expires_in:3600});
    }
    json(res,{status:0});
  });
  const session = credential();
  const client = new sdk.PlaudClient(session);
  assert.equal(await client.fetchWorkspaceToken({id:'test'}),true);
  assert.equal(session.workspace.domain,'https://regional.plaud.cn');
});
