import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

const GITHUB_API_BASE = "https://api.github.com";

function getGitHubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "otto-pi-agent"
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Executes a GitHub API request with exponential backoff on rate-limiting (403 or 429).
 */
export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<Response> {
  let delay = baseDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    if ((res.status === 403 || res.status === 429) && attempt < maxRetries) {
      // Check for Retry-After header or rate limit reset
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 10_000)));
      delay *= 2;
      continue;
    }
    return res;
  }
  return fetch(url, init);
}

function normalizeRepo(repo: string): string {
  return repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").trim();
}

export function createGitHubTools(env?: { GITHUB_TOKEN?: string }): ToolRegistration[] {
  const getIssueParameters = Type.Object({
    repo: Type.String({ description: "Repository in owner/name format (e.g. vmlgtm/otto-pi)" }),
    issue_number: Type.Number({ description: "GitHub issue or pull request number" })
  });

  const createPrParameters = Type.Object({
    repo: Type.String({ description: "Repository in owner/name format (e.g. vmlgtm/otto-pi)" }),
    title: Type.String({ description: "Pull request title" }),
    head: Type.String({ description: "Feature branch name containing changes (e.g. otto/issue-42-fix-bug)" }),
    base: Type.Optional(Type.String({ description: "Target base branch. Defaults to main." })),
    body: Type.Optional(Type.String({ description: "Pull request description summarizing changes and test proof" })),
    draft: Type.Optional(Type.Boolean({ description: "Create as draft PR. Guardrail defaults to true." }))
  });

  const addCommentParameters = Type.Object({
    repo: Type.String({ description: "Repository in owner/name format (e.g. vmlgtm/otto-pi)" }),
    issue_number: Type.Number({ description: "Issue or pull request number" }),
    body: Type.String({ description: "Comment body text" })
  });

  const getIssueTool: ToolRegistration<typeof getIssueParameters> = {
    name: "github_get_issue",
    description: "Fetch GitHub issue details, description, labels, and recent comments (up to 10).",
    parameters: getIssueParameters,
    replay: "safe",
    async execute(args) {
      try {
        const repo = normalizeRepo(args.repo);
        const headers = getGitHubHeaders(env?.GITHUB_TOKEN);

        const issueRes = await fetchWithBackoff(
          `${GITHUB_API_BASE}/repos/${repo}/issues/${args.issue_number}`,
          { headers }
        );

        if (!issueRes.ok) {
          const errBody = await issueRes.text();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `GitHub API error (${issueRes.status}): ${errBody}`
                })
              }
            ],
            isError: true
          };
        }

        const issue = (await issueRes.json()) as any;

        // Fetch comments with pagination cap (max 10 items)
        let comments: any[] = [];
        try {
          const commentsRes = await fetchWithBackoff(
            `${GITHUB_API_BASE}/repos/${repo}/issues/${args.issue_number}/comments?per_page=10`,
            { headers }
          );
          if (commentsRes.ok) {
            comments = ((await commentsRes.json()) as any[]).slice(0, 10).map((c) => ({
              id: c.id,
              user: c.user?.login,
              body: c.body,
              created_at: c.created_at
            }));
          }
        } catch {}

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                html_url: issue.html_url,
                labels: (issue.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
                comments
              })
            }
          ],
          isError: false
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  const createPrTool: ToolRegistration<typeof createPrParameters> = {
    name: "github_create_pull_request",
    description: "Open a Pull Request on GitHub. Defaults to draft: true with strict branch name validation.",
    parameters: createPrParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        const repo = normalizeRepo(args.repo);
        const head = args.head.trim();
        const base = args.base?.trim() || "main";
        // Guardrail: Draft PR by default
        const draft = args.draft ?? true;

        // Guardrail: Branch name enforcement
        if (!head.startsWith("otto/")) {
          return {
            content: [
              {
                type: "text",
                text: `GuardrailViolation: Head branch '${head}' must follow the pattern 'otto/<issue-id>-<short-description>'`
              }
            ],
            isError: true
          };
        }

        const headers = {
          ...getGitHubHeaders(env?.GITHUB_TOKEN),
          "Content-Type": "application/json"
        };

        const res = await fetchWithBackoff(
          `${GITHUB_API_BASE}/repos/${repo}/pulls`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: args.title,
              head,
              base,
              body: args.body ?? "",
              draft
            })
          }
        );

        if (!res.ok) {
          const errBody = await res.text();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `GitHub API error (${res.status}): ${errBody}`
                })
              }
            ],
            isError: true
          };
        }

        const pr = (await res.json()) as any;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                number: pr.number,
                html_url: pr.html_url,
                title: pr.title,
                state: pr.state,
                draft: pr.draft ?? draft
              })
            }
          ],
          isError: false
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  const addCommentTool: ToolRegistration<typeof addCommentParameters> = {
    name: "github_add_comment",
    description: "Post a comment or progress update on a GitHub issue or pull request.",
    parameters: addCommentParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        const repo = normalizeRepo(args.repo);
        const headers = {
          ...getGitHubHeaders(env?.GITHUB_TOKEN),
          "Content-Type": "application/json"
        };

        const res = await fetchWithBackoff(
          `${GITHUB_API_BASE}/repos/${repo}/issues/${args.issue_number}/comments`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ body: args.body })
          }
        );

        if (!res.ok) {
          const errBody = await res.text();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `GitHub API error (${res.status}): ${errBody}`
                })
              }
            ],
            isError: true
          };
        }

        const comment = (await res.json()) as any;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: comment.id,
                html_url: comment.html_url,
                body: comment.body
              })
            }
          ],
          isError: false
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  return [getIssueTool, createPrTool, addCommentTool];
}
