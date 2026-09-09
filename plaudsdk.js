'use strict';

const {PlaudClient, createEmptySession, normalizeSession, AuthRequiredError, PlaudApiError} = require('./lib/client');

/** Send an SMS challenge. No credentials are written to disk. */
async function sendCode(phone) {
  const normalized = String(phone).replace(/[\s-]/g, '');
  if (!/^1[3-9]\d{9}$/.test(normalized)) throw new Error('中国大陆手机号格式无效');
  const session = createEmptySession();
  const sms = await new PlaudClient(session).sendSmsCode('+86', normalized);
  return {phone: normalized, deviceId: session.deviceId, apiUrl: session.apiUrl, smsToken: sms.token, session};
}

/** Exchange a challenge for a serializable credential shared with the CLI. */
async function login(challenge, code, options = {}) {
  if (!challenge?.phone || !challenge?.smsToken || !challenge?.deviceId) throw new Error('challenge 无效');
  if (!/^\d{6}$/.test(String(code))) throw new Error('验证码必须是六位数字');
  const session = challenge.session || {...createEmptySession(), deviceId: challenge.deviceId, apiUrl: challenge.apiUrl};
  const client = new PlaudClient(session, options);
  await client.login('+86', challenge.phone, String(code), challenge.smsToken);
  await client.setupWorkspace();
  return session;
}

function listFiles(credential, options) {
  return new PlaudClient(credential).listFiles(options);
}

function listAllFiles(credential, options) {
  return new PlaudClient(credential).listAllFiles(options);
}

function fileURL(credential, fileId) {
  return new PlaudClient(credential).getTemporaryUrl(fileId);
}

module.exports = {sendCode, login, listFiles, listAllFiles, fileURL, PlaudClient,
  createEmptySession, normalizeSession, AuthRequiredError, PlaudApiError};
