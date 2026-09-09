# Security

Report vulnerabilities privately through the repository's GitHub security
advisory reporting feature when available. Do not include live credentials or
private audio in public issues. If private reporting is unavailable, open an
issue asking for a private contact without disclosing exploit details.

Credentials contain account access and refresh tokens. The CLI writes them with
owner-only file permissions on POSIX systems; Windows users should restrict the
configuration directory with filesystem ACLs. SDK callers are responsible for
secure persistence, including saving credentials after token refresh.

HAR exports and signed download URLs may grant access to private account data.
They must not be committed. `--logout` deletes local credentials only and does
not revoke server-side sessions.
