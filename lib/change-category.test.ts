import assert from "node:assert/strict";
import { test } from "bun:test";
import { changeCategory, lineTotals, publishedLines } from "./change-category";
import type { GitStatusEntry } from "./git-status";

test("each path lands in one category, test before conf before docs", () => {
  const cases: Record<string, string> = {
    // test
    "apps/money/backend/tests/unit/test_payout.py": "test",
    "tests/fixtures/payload.json": "test",
    "src/__tests__/tree.tsx": "test",
    "apps/web/e2e/login.ts": "test",
    "lib/fuzzy.test.ts": "test",
    "components/Button.spec.tsx": "test",
    "pkg/test_util.py": "test",
    "pkg/util_test.py": "test",
    "server/handler_test.go": "test",
    "apps/x/conftest.py": "test",
    "test/README.md": "test",
    // conf
    "package.json": "conf",
    "tsconfig.base.json": "conf",
    "pyproject.toml": "conf",
    ".github/workflows/ci.yml": "conf",
    ".github/pull_request_template.md": "conf",
    "infra/values.yaml": "conf",
    "setup.cfg": "conf",
    "pytest.ini": "conf",
    ".env": "conf",
    ".env.local": "conf",
    "deploy/prod.env": "conf",
    "uv.lock": "conf",
    "package-lock.json": "conf",
    "pnpm-lock.yaml": "conf",
    "Cargo.lock": "conf",
    "Makefile": "conf",
    "apps/web/Dockerfile": "conf",
    "Dockerfile.dev": "conf",
    ".mcp.json": "conf",
    ".codex/config.toml": "conf",
    ".codex/hooks/run.sh": "conf",
    ".claude/settings.json": "conf",
    ".claude/settings.local.json": "conf",
    "vite.config.ts": "conf",
    "tailwind.config.cjs": "conf",
    ".gitignore": "conf",
    "requirements-dev.txt": "conf",
    // docs
    "README.md": "docs",
    "apps/money/docs/FR-money.md": "docs",
    "docs/guide.mdx": "docs",
    "docs/index.rst": "docs",
    "docs/notes.txt": "docs",
    ".claude/rules/markets.md": "docs",
    // code
    "server.ts": "code",
    "components/ChangesPanel.tsx": "code",
    "apps/money/backend/src/money_app/config.py": "code",
    ".claude/bin/pr-risk.py": "code",
    "scripts/deploy.sh": "code",
    "notes.txt": "code",
    "contest.py": "code",
    "latest.ts": "code",
  };
  const actual = Object.fromEntries(Object.keys(cases).map((path) => [path, changeCategory(path)]));
  assert.deepEqual(actual, cases);
});

const entries: GitStatusEntry[] = [
  { path: "src/a.ts", status: "modified", additions: 10, deletions: 2, binary: false },
  { path: "src/b.ts", status: "added", additions: 5, deletions: 0, binary: false },
  { path: "assets/logo.png", status: "added", binary: true },
  { path: "package.json", status: "modified", additions: 1, deletions: 1, binary: false },
  { path: "tests/test_a.py", status: "modified", additions: 7, deletions: 3, binary: false },
];

test("totals sum each category's counted lines; binary files count as files only", () => {
  const totals = lineTotals(entries);
  assert.deepEqual(totals.code, { files: 3, additions: 15, deletions: 2, binary: 1, uncounted: 0 });
  assert.deepEqual(totals.conf, { files: 1, additions: 1, deletions: 1, binary: 0, uncounted: 0 });
  assert.deepEqual(totals.test, { files: 1, additions: 7, deletions: 3, binary: 0, uncounted: 0 });
  assert.deepEqual(totals.docs, { files: 0, additions: 0, deletions: 0, binary: 0, uncounted: 0 });
});

test("published totals are null when a text file has no count, never an undercount", () => {
  assert.deepEqual(publishedLines(entries), {
    code: { files: 3, additions: 15, deletions: 2 },
    conf: { files: 1, additions: 1, deletions: 1 },
    test: { files: 1, additions: 7, deletions: 3 },
    docs: { files: 0, additions: 0, deletions: 0 },
  });
  assert.equal(publishedLines([...entries, { path: "README.md", status: "modified" }]), null);
  assert.equal(lineTotals([{ path: "README.md", status: "modified" }]).docs.uncounted, 1);
});
