'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const {pipeline} = require('node:stream/promises');
const {randomUUID} = require('node:crypto');
const APP_VERSION = require('../package.json').version;

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTimestamp(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function sanitizeFilename(filename) {
  const clean = String(filename || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 100);
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean || 'recording';
}

function extensionFromUrl(downloadUrl) {
  try {
    const extension = path.extname(new URL(downloadUrl).pathname);
    return /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension : '';
  } catch {
    return '';
  }
}

function outputNameFor(file, downloadUrl) {
  let filename = sanitizeFilename(file.filename || file.fullname || file.id);
  if (!/\.(mp3|wav|opus|ogg|m4a|aac|flac|webm|mp4)$/i.test(filename)) {
    const extension = extensionFromUrl(downloadUrl)
      || (file.filetype === 'audio/wav' ? '.wav' : file.filetype === 'audio/mp3' ? '.mp3' : '');
    filename += extension;
  }
  return filename;
}

async function availableOutputPath(directory, filename) {
  const parsed = path.parse(filename);
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(
      directory,
      suffix === 0 ? filename : `${parsed.name} (${suffix})${parsed.ext}`,
    );
    try {
      await fsp.access(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

function downloadStream(downloadUrl, destination, redirectCount = 0) {
  const url = new URL(downloadUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`不支持的下载协议：${url.protocol}`);
  }
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: { 'User-Agent': `PlaudCLI/${APP_VERSION}` },
      timeout: 60_000,
    }, (response) => {
      response.on('error', reject);
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error('下载重定向次数过多'));
          return;
        }
        try {
          const redirectedUrl = new URL(response.headers.location, url).toString();
          downloadStream(redirectedUrl, destination, redirectCount + 1).then(resolve, reject);
        } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`下载服务器返回 HTTP ${response.statusCode}`));
        return;
      }

      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      const output = fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' });
      response.on('data', (chunk) => {
        received += chunk.length;
        if (stderrIsInteractive()) {
          const progress = total > 0 ? `${Math.floor(received / total * 100)}%` : formatBytes(received);
          process.stderr.write(`\r    下载中：${progress}`);
        }
      });
      pipeline(response, output).then(() => {
        if (total && received !== total) throw new Error('下载文件长度不匹配');
        if (stderrIsInteractive()) process.stderr.write('\r                    \r');
        resolve({received, contentType: response.headers['content-type']});
      }).catch(reject);
    });
    request.on('timeout', () => request.destroy(new Error('下载超时')));
    request.on('error', reject);
  });
}

function stderrIsInteractive() {
  return Boolean(process.stderr.isTTY);
}

async function downloadFile(client, file, directory = path.join(process.cwd(), 'downloads')) {
  const temporaryUrl = await client.getTemporaryUrl(file.id);
  await fsp.mkdir(directory, { recursive: true });
  const filename = outputNameFor(file, temporaryUrl);
  const finalPath = await availableOutputPath(directory, filename);
  const partialPath = `${finalPath}.${randomUUID()}.part`;

  console.log(`\n下载：${filename}`);
  try {
    const result = await downloadStream(temporaryUrl, partialPath);
    await fsp.link(partialPath, finalPath);
    await fsp.unlink(partialPath);
    console.log(`完成：${finalPath}（${formatBytes(result.received)}）`);
    return finalPath;
  } catch (error) {
    try {
      await fsp.unlink(partialPath);
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') console.warn(`无法清理临时文件：${partialPath}`);
    }
    throw error;
  }
}


module.exports = {formatBytes, formatDuration, formatTimestamp, sanitizeFilename, outputNameFor, availableOutputPath, downloadFile, downloadStream};
