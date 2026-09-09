# PlaudCli

[![CI](https://github.com/AristraHatsuyu/PlaudCli/actions/workflows/ci.yml/badge.svg)](https://github.com/AristraHatsuyu/PlaudCli/actions/workflows/ci.yml)

用于 **Plaud 中国大陆区** 的非官方录音下载 CLI 和 Node.js SDK。零第三方运行时依赖，MIT 开源。

通过 Plaud Web 端的非公开接口访问你有权访问的账号和录音。项目与 Plaud 官方无关联；接口变更可能导致功能失效。当前不支持国际区账号。

## 快速开始

需要 Node.js **22 或更高版本**。

```bash
git clone https://github.com/AristraHatsuyu/PlaudCli.git
cd PlaudCli
npm ci
node plaudcli.js
```

首次运行输入中国大陆手机号（不带 `+86`）和六位短信验证码。验证码提示处可输入 `r` 重发、`q` 退出。存在多个工作区时会提示选择。

登录后分页读取录音，显示名称、时间、时长、大小和转写/摘要状态。输入编号（支持逗号分隔）或 `all` 下载。单个文件失败后继续处理其他文件，并以非零状态退出。

```bash
node plaudcli.js --help
node plaudcli.js --logout
```

`--logout` 只删除本地凭据，不撤销服务端会话。下载文件保留。

| 配置 | 默认值 | 环境变量 |
| --- | --- | --- |
| 凭据目录 | `~/.plaudcli/`，文件为 `session.json` | `PLAUDCLI_CONFIG_DIR` |
| 下载目录 | 当前目录下的 `downloads/` | `PLAUDCLI_DOWNLOAD_DIR` |

```bash
PLAUDCLI_CONFIG_DIR=/path/to/config \
PLAUDCLI_DOWNLOAD_DIR=/path/to/audio \
node plaudcli.js
```

凭据以 `0600` 权限原子写入（POSIX）。下载采用流式写入，成功后才生成最终文件，已有同名文件使用编号区分。批量下载为串行执行，不提供断点续传或增量去重。

## SDK

CLI 与 SDK 使用同一套 API 客户端及凭据结构，旧 CLI/SDK 凭据会在载入时迁移。

```js
const fs = require('node:fs/promises');
const plaud = require('./plaudsdk');

async function firstLogin(phone, readCode) {
  const challenge = await plaud.sendCode(phone);
  const credential = await plaud.login(challenge, await readCode());
  await fs.writeFile('credential.json', JSON.stringify(credential), { mode: 0o600 });
  return credential;
}

async function recordings() {
  const credential = JSON.parse(await fs.readFile('credential.json', 'utf8'));
  try {
    const files = await plaud.listAllFiles(credential);
    if (files.length) {
      // 临时 URL 包含访问授权，不要公开或用作长期标识。
      const url = await plaud.fileURL(credential, files[0].id);
      return { fileId: files[0].id, url };
    }
  } finally {
    // 刷新会原地更新凭据，即使后续请求失败也应保存。
    await fs.writeFile('credential.json', JSON.stringify(credential), { mode: 0o600 });
  }
}
```

| API | 说明 |
| --- | --- |
| `sendCode(phone)` | 请求短信验证码，返回 challenge |
| `login(challenge, code, { workspaceId })` | 登录，默认优先个人工作区 |
| `listFiles(credential, options)` | 单页录音，默认 `skip: 0, limit: 100` |
| `listAllFiles(credential, options)` | 自动分页，直到空页；重复 ID 会报错 |
| `fileURL(credential, fileId)` | 获取临时录音 URL |
| `new PlaudClient(credential, options)` | 高级客户端，支持 `onSessionChange` 持久化回调和 `workspaceId` |

列表选项包括 `skip`、`limit`、`isTrash`（默认 `2`，原样传给服务端）、`sortBy`（默认 `start_time`）、`descending`（默认 `true`）。SDK 不自动写入磁盘；同一凭据对象的并发令牌恢复会合并。不同进程不共享刷新锁，应避免多个进程同时使用同一凭据文件。

API 请求有 30 秒期限和 32 MiB 响应上限；认证失败时尝试刷新并重试一次。普通网络错误不会自动重试，短信发送也不会自动重试。API 地址限制为 Plaud 中国区 HTTPS 域名，下载支持服务端返回的 HTTP/HTTPS 地址及最多五次重定向。

## 开发

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

- `lib/client.js`：Cookie、认证、工作区、分页和接口校验。
- `lib/download.js`：文件名、流式下载、临时文件及冲突处理。
- `plaudcli.js`：终端交互及凭据持久化。
- `plaudsdk.js`：程序化入口。
- `test/`：使用本地服务器和虚拟凭据的离线测试。

CI 配置覆盖 Node.js 22/24 和 Linux/macOS/Windows。离线测试不代表真实账号接口仍然可用；真实短信和录音访问需要使用者自己的账号验证。尚未发布 npm 包，请从 GitHub 克隆使用。

请勿提交 HAR、账号 Cookie、凭据、签名 URL 或私人录音。参阅 [贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md) 和 [MIT License](LICENSE)。
