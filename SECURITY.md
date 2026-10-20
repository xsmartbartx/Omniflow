# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting on this repository (**Security → Report a vulnerability**). Include what you
found, how to reproduce it, and the version (`omniflow --version`). We aim to acknowledge within three
working days, agree a fix and disclosure timeline with you, and credit you in the release notes if you wish.

> *Maintainers: if you distribute or operate OmniFlow commercially, add your own security contact and PGP
> key here before publishing.*

## Supported versions

Security fixes are made for the latest minor release of the current major version. Upgrade notes are in
[`CHANGELOG.md`](CHANGELOG.md).

## Scope

In scope: authentication and authorisation bypass, tenant isolation failures, secret disclosure, SSRF or
egress-guard bypass, sandbox/argument-injection in the shell capability, path traversal, injection into the
expression language or manifests, audit-log tampering that goes undetected, and anything that lets an AI
agent's output reach production without the documented gates.

Out of scope: the isolation of processes started by `shell-exec` beyond what is documented (the container
is the boundary — see [docs/security.md](docs/security.md#what-you-are-responsible-for)), denial of service
from an authenticated administrator, and findings that need an already-compromised host.

## How the design is meant to fail

Every control in [docs/security.md](docs/security.md) names the test that proves it. A report that
contradicts one of those claims is the most valuable kind.
