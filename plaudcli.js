#!/usr/bin/env node

'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const APP_VERSION = require('./package.json').version;
const CONFIG_DIR = process.env.PLAUDCLI_CONFIG_DIR
  ? path.resolve(process.env.PLAUDCLI_CONFIG_DIR)
  : path.join(os.homedir(), '.plaudcli');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
const DOWNLOAD_DIR = process.env.PLAUDCLI_DOWNLOAD_DIR
  ? path.resolve(process.env.PLAUDCLI_DOWNLOAD_DIR)
  : path.join(process.cwd(), 'downloads');
const {PlaudClient, AuthRequiredError, PlaudApiError, createEmptySession, normalizeSession, responseNeedsAuth} = require('./lib/client');
const {formatBytes, formatDuration, formatTimestamp, downloadFile} = require('./lib/download');

async function loadSession() {
  try {
    const raw = await fsp.readFile(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeSession(parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`无法读取本地登录状态，将重新登录：${error.message}`);
    }
    return createEmptySession();
  }
}

async function saveSession(session) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporaryFile = `${SESSION_FILE}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryFile, `${JSON.stringify(session, null, 2)}\n`, {
      mode: 0o600, flag: 'wx',
    });
    await fsp.chmod(temporaryFile, 0o600);
    await fsp.rename(temporaryFile, SESSION_FILE);
  } finally {
    await fsp.unlink(temporaryFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function deleteSession() {
  try {
    await fsp.unlink(SESSION_FILE);
    console.log(`已删除本地登录凭据：${SESSION_FILE}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('本地没有已保存的登录凭据。');
      return;
    }
    throw error;
  }
}

function displayFiles(files) {
  console.log(`\n录音列表（${files.length} 个）：\n`);
  files.forEach((file, index) => {
    const flags = [];
    if (file.is_trans) flags.push('已转写');
    if (file.is_summary) flags.push('有摘要');
    if (file.is_trash) flags.push('回收站');
    console.log(`[${index + 1}] ${file.filename || file.fullname || file.id}`);
    console.log(`    时间：${formatTimestamp(file.start_time)}  时长：${formatDuration(file.duration)}  大小：${formatBytes(file.filesize)}`);
    console.log(`    格式：${file.filetype || '-'}  状态：${flags.join('、') || '普通'}  ID：${file.id}`);
  });
}

async function chooseFiles(prompt, files) {
  while (true) {
    const answer = (await prompt.question('\n输入编号下载（可用逗号分隔），输入 all 下载全部，输入 q 退出：'))
      .trim()
      .toLowerCase();
    if (answer === 'q' || answer === 'quit' || answer === 'exit') return [];
    if (answer === 'all' || answer === 'a') return files;

    const indices = answer.split(/[，,\s]+/)
      .filter(Boolean)
      .map((value) => Number(value) - 1);
    if (indices.length && indices.every((index) => Number.isInteger(index) && files[index])) {
      return [...new Set(indices)].map((index) => files[index]);
    }
    console.log('选择无效，请输入列表中的编号。');
  }
}

async function interactiveLogin(client, prompt) {
  console.log('\n本地没有有效登录凭据，需要短信验证码登录。');
  const phoneCode = '+86';
  const phoneNumber = (await prompt.question('中国大陆手机号（+86）：')).trim().replace(/[\s-]/g, '');
  if (!/^1[3-9]\d{9}$/.test(phoneNumber)) throw new Error('中国大陆手机号格式无效。');

  // Persist the device ID before requesting SMS, matching the Web client's
  // stable local-storage identity across retries and process restarts.
  await client.persist();
  console.log('正在发送验证码…');
  let sms = await client.sendSmsCode(phoneCode, phoneNumber);
  console.log(`发送请求已被 Plaud 接受${sms.message ? `：${sms.message}` : ''}。`);
  console.log('短信送达可能有延迟；请同时检查拦截/垃圾短信。未收到可在下方输入 r 手动重发。');

  let loginAttempts = 0;
  let lastSentAt = Date.now();
  while (loginAttempts < 3) {
    const code = (await prompt.question('请输入六位验证码（r 重发，q 退出）：')).trim().toLowerCase();
    if (code === 'q' || code === 'quit' || code === 'exit') {
      throw new Error('已取消登录。');
    }
    if (code === 'r' || code === 'resend') {
      const requiredWait = Math.max(60, sms.cooldown || 0);
      const elapsed = Math.floor((Date.now() - lastSentAt) / 1000);
      if (elapsed < requiredWait) {
        console.log(`请等待 ${requiredWait - elapsed} 秒后再重发，避免触发 Plaud 的频率限制。`);
        continue;
      }
      console.log('正在重新发送验证码…');
      sms = await client.sendSmsCode(phoneCode, phoneNumber);
      lastSentAt = Date.now();
      console.log(`重发请求已被 Plaud 接受${sms.message ? `：${sms.message}` : ''}。`);
      continue;
    }
    if (!/^\d{6}$/.test(code)) {
      console.log('请输入六位数字，或输入 r 重发。');
      continue;
    }
    loginAttempts += 1;
    try {
      await client.login(phoneCode, phoneNumber, code, sms.token);
      console.log('登录成功。');
      break;
    } catch (error) {
      if (loginAttempts === 3) throw error;
      console.log(`登录失败：${error.message}`);
    }
  }
  await client.setupWorkspace();
}

function showHelp() {
  console.log(`PlaudCLI ${APP_VERSION}

用法：
  node plaudcli.js           登录、显示录音并选择下载
  node plaudcli.js --logout  删除本地保存的登录凭据
  node plaudcli.js --help    显示帮助

环境变量：
  PLAUDCLI_CONFIG_DIR        登录凭据目录，默认 ${CONFIG_DIR}
  PLAUDCLI_DOWNLOAD_DIR      下载目录，默认 ${DOWNLOAD_DIR}`);
}

async function main() {
  const argument = process.argv[2];
  if (argument === '--help' || argument === '-h') {
    showHelp();
    return;
  }
  if (argument === '--logout') {
    await deleteSession();
    return;
  }
  if (argument) {
    throw new Error(`未知参数：${argument}。使用 --help 查看帮助。`);
  }

  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    const session = await loadSession();
    const client = new PlaudClient(session, {onSessionChange: saveSession, chooseWorkspace: async (workspaces) => {
      console.log('可用工作区：');
      workspaces.forEach((workspace, index) => console.log(`[${index + 1}] ${workspace.name || workspace.workspace_id}`));
      for (;;) {
        const index = Number((await prompt.question('请选择工作区编号：')).trim()) - 1;
        if (Number.isInteger(index) && workspaces[index]) return workspaces[index];
        console.log('请输入有效编号。');
      }
    }});
    let files;

    try {
      files = await client.listAllFiles();
      console.log('本地登录凭据有效，已自动登录。');
    } catch (error) {
      if (!(error instanceof AuthRequiredError)
        && (!(error instanceof PlaudApiError) || !responseNeedsAuth(error.response))) {
        throw error;
      }
      await interactiveLogin(client, prompt);
      files = await client.listAllFiles();
    }

    if (!files.length) {
      console.log('账号下暂时没有录音。');
      return;
    }
    displayFiles(files);
    const selectedFiles = await chooseFiles(prompt, files);
    if (!selectedFiles.length) {
      console.log('已退出，未下载文件。');
      return;
    }

    const completed = [];
    for (const file of selectedFiles) {
      try { completed.push(await downloadFile(client, file, DOWNLOAD_DIR)); }
      catch (error) { console.error(`下载失败 ${file.id}：${error.message}`); process.exitCode = 1; }
    }
    console.log(`\n已下载 ${completed.length} 个文件到：${DOWNLOAD_DIR}`);
  } finally {
    prompt.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error?.code === 'ABORT_ERR') {
      process.exitCode = 130;
      return;
    }
    console.error(`\n错误：${error.message}`);
    process.exitCode = 1;
  });
}
