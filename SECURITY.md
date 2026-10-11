# Security policy

## Supported versions

Safry is an early development version (0.x). Only the latest commit on the default branch receives security fixes; there are no maintained release branches yet.

## Reporting a vulnerability

Please do not open a public issue or pull request for a security problem.

Use GitHub private vulnerability reporting: on the repository page open **Security > Report a vulnerability**. Include the affected component, steps to reproduce, the impact you observed and, if you have one, a suggested fix. Do not include real personal data; use test accounts.

## What to expect

- Acknowledgement of your report within 5 working days.
- An initial assessment (accepted, needs more information, or out of scope) within 14 days.
- Fixes are developed privately and released together with an advisory; we will credit you if you wish.

These are targets for a small project, not contractual commitments.

## Scope

In scope: the code in this repository (`backend/`, `frontend/`, Docker and CI configuration), for example authentication and session handling, authorization and tenant isolation, injection, and secret handling.

Out of scope: denial-of-service by volume, findings that need a modified or non-default insecure configuration, social engineering, third-party services, and automated-scanner output without a demonstrated impact. Never test against systems you do not own.

No secrets, keys or credentials belong in this repository. If you find one, report it through the same channel.
