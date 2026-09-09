# Contributing

Use Node.js 22 or newer. Run `npm ci`, `npm run check`, and `npm test` before
opening a pull request. Tests must run offline with synthetic credentials.

Keep authentication and API behavior in `lib/client.js`, download handling in
`lib/download.js`, and terminal interaction in `plaudcli.js`. Do not add another
independent HTTP/authentication implementation to the SDK.

Describe the problem, resulting behavior, and validation in pull requests.
Never attach unredacted HAR files, cookies, signed recording URLs, phone numbers,
or private recordings to issues or pull requests.
