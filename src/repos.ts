/**
 * The repositories Otto may prepare, keyed by clone URL. `prepare_workspace`
 * clones and installs from here, and `run_checks` runs `lint` and `test`. A
 * repository that is not listed is refused, not guessed at. Phase 5 can move
 * this into an AGENTS.md in each repository.
 */
export type RepoConfig = {
  /** Node major version on PATH: "24" (the image default) or "22". */
  readonly node: "22" | "24";
  /** Branch to clone; the remote's default branch when absent. */
  readonly ref?: string;
  readonly install: readonly string[];
  readonly test: readonly string[] | null;
  readonly lint: readonly string[] | null;
  readonly instance: "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";
};

export const REPOS: Readonly<Record<string, RepoConfig>> = {
  // A pnpm repo (packageManager pnpm@10.28.0, pnpm-lock.yaml): `npm ci` fails
  // with EUSAGE. Checked in the Phase 4 spike: all vitest files pass in ~13 s.
  "https://github.com/vmlgtm/ufo.git": {
    node: "24",
    install: ["pnpm", "install", "--frozen-lockfile"],
    test: ["pnpm", "exec", "vitest", "run"],
    lint: null,
    instance: "standard-1"
  },
  "https://github.com/vmlgtm/wp-calypso.git": {
    node: "24",
    ref: "trunk",
    install: ["yarn", "install", "--immutable"],
    // Set once the Calypso run confirms one small package's Jest command (NOTES.md).
    test: null,
    lint: null,
    instance: "standard-4"
  }
};

/** `https://github.com/Owner/Repo` and `.../Repo.git/` both name the same entry. */
export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return (trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`).toLowerCase();
}

export function findRepo(url: string): { url: string; config: RepoConfig } | undefined {
  const wanted = normalizeRepoUrl(url);
  for (const [key, config] of Object.entries(REPOS)) {
    if (normalizeRepoUrl(key) === wanted) return { url: key, config };
  }
  return undefined;
}

/** `https://github.com/vmlgtm/ufo.git` → `vmlgtm/ufo`, the egress gateway's repo name. */
export function githubRepoName(url: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** `/workspace/<name>`, where a prepared repository lives. */
export function repoDir(url: string): string {
  const name = url.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/, "") || "repo";
  return `/workspace/${name}`;
}
