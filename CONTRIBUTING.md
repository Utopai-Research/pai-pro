# Contributing to PAI Pro

Thanks for your interest in PAI Pro. This document covers what kinds of contributions we accept, what we don't, and how to get a change in.

This is a real project under active development by [Utopai Studios](https://www.utopaistudios.com/). We welcome thoughtful contributions — bug reports, infrastructure improvements, documentation — and we're equally clear about the categories we keep proprietary so the project's economics stay sustainable.

## License recap

PAI Pro ships under the [PAI PRO Sustainable Use License](LICENSE.md). Key points for would-be contributors:

- **Personal use, internal business use, and non-commercial research** are all permitted without any agreement.
- **The Skills layer** (`skills/`, including agent workflows, prompt templates, and generation logic) is proprietary. You may use it, but you may not modify or repackage it to create commercial derivative works.
- **Enterprise / commercial use of the Skills** or any source designated for Enterprise use requires a separate commercial agreement with Utopai Studios.

The full license is in [LICENSE.md](LICENSE.md). Read it before you spend time on a change.

## What we accept

- **Bug fixes** — anything that brings observed behavior in line with documented behavior.
- **Documentation improvements** — README, this file, code comments, examples.
- **Infrastructure improvements** — Dockerfile, docker-compose, build scripts, the canvas viewer, the mutator, the web UI, the asset mirror, the test harness.
- **Performance improvements** to the infrastructure layer, with benchmarks.
- **Compatibility fixes** for new versions of supported coding agents (Claude Code, Cursor, Codex).

## What we don't accept

- **Wholesale Skill rewrites.** Each Skill embodies a specific authored workflow that is proprietary under our license. We do not accept community rewrites of Skill logic, even if the diff is clean.
- **New Skills without prior agreement.** If you've designed a new Skill you think should ship with PAI Pro, please open a discussion (link below) describing the scope and use cases first. PRs that introduce a new Skill without that prior discussion will be closed.
- **Typo-only PRs.** Typos are still worth fixing, but we batch them — file an issue with the typo or include the fix as part of a larger PR.
- **Forks repackaged as competing products.** Our license forbids this; we'll close PRs that appear to be staging changes for a fork rather than improving PAI Pro itself.

## PR process

1. Fork the repo and create a branch off `main`.
2. Make your change. Keep PRs focused — one feature or fix per PR.
3. Include tests where applicable.
4. Open the PR. Fill out the [PR template](.github/pull_request_template.md).
5. Sign the [Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md) when the bot prompts you. (First-time contributors only; sign once, all future PRs auto-pass.)
6. A maintainer will review. We'll either approve, request changes, or explain why the PR doesn't fit project scope.

## PR requirements

- **Small** — one purpose per PR. Large multi-concern PRs will be asked to split.
- **Tested** — include tests where applicable. A bug isn't fixed until a test prevents it from recurring.
- **CLA signed** — required for all contributors before merge. Auto-prompted by our CLA bot on first PR.
- **Conventional commit title** — we use [Conventional Commits](https://www.conventionalcommits.org/) style for PR titles (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, etc.). Recommended, not strictly enforced — see past PRs for examples. A maintainer may ask you to amend the title during review.

## Reporting bugs

File bugs as GitHub issues using the [bug template](.github/ISSUE_TEMPLATE/bug.yml). Include reproduction steps, environment details, and logs where possible.

## Asking questions or proposing features

GitHub Issues is bug-only. For questions, ideas, and feature proposals, please use [Discussions](https://github.com/Utopai-Research/pai-pro/discussions). The Q&A category supports marking accepted answers; the Ideas category is the right place for "I think PAI Pro should also do X" proposals (which the maintainers will evaluate but do not auto-merge).

## Reporting security issues

Please do not file security vulnerabilities as public GitHub issues. Use GitHub's [private vulnerability reporting](https://github.com/Utopai-Research/pai-pro/security/advisories/new) instead. See [SECURITY.md](SECURITY.md) for details.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.
