import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * What the container may reach right now. PiAgent swaps these props by
 * re-registering the intercept; in-flight connections pick up the new
 * handler without being dropped.
 *
 * - `setup`: clone and install. Every request is forwarded, with no
 *   credentials. Only `prepare_workspace` runs in this phase.
 * - `locked`: the model's own commands. Only git's read protocol to the
 *   session's repo is forwarded, still without credentials. A push is
 *   forwarded, with the token, only when `push` names its repo and branch.
 */
export type EgressProps =
  | { readonly phase: "setup" }
  | {
      readonly phase: "locked";
      /** `owner/name` on github.com, the prepared repo. */
      readonly repo?: string;
      /** Set by git_push for the duration of one push. */
      readonly push?: { readonly repo: string; readonly branch: string };
    };

const GITHUB_HOST = "github.com";
const ZERO_OID = /^0+$/;

function deny(reason: string): Response {
  console.log(JSON.stringify({ event: "egress_denied", reason }));
  return new Response(`otto egress: ${reason}\n`, { status: 403 });
}

/** `/owner/name.git/...` or `/owner/name/...` → `owner/name`, lowercased. */
export function repoOfPath(pathname: string): string | undefined {
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    pathname
  );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
}

/**
 * The ref updates at the start of a receive-pack request body, in git's
 * pkt-line format: optional `shallow <oid>` lines, then
 * `<old> <new> <ref>[\0capabilities]` per line, ended by a flush packet `0000`.
 */
export function parseReceivePackCommands(
  body: Uint8Array
): { old: string; new: string; ref: string }[] {
  const decoder = new TextDecoder();
  const commands: { old: string; new: string; ref: string }[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
    if (!Number.isFinite(length)) throw new Error("malformed pkt-line");
    if (length === 0) return commands;
    if (length < 4 || offset + length > body.length) throw new Error("malformed pkt-line");
    const line = decoder.decode(body.subarray(offset + 4, offset + length));
    offset += length;
    // A push from a shallow clone (prepare_workspace clones at depth 1) names
    // its shallow commits first; they are not ref updates.
    if (line.startsWith("shallow ")) continue;
    const [command] = line.split("\0");
    const [oldOid, newOid, ref] = command.trim().split(" ");
    if (!oldOid || !newOid || !ref) throw new Error("malformed ref update");
    commands.push({ old: oldOid, new: newOid, ref });
  }
  throw new Error("receive-pack request has no flush packet");
}

/**
 * Every HTTP(S) request the workspace container makes lands here
 * (`enableInternet: false` plus a catch-all intercept). The container never
 * holds a credential: the token is added on the way out, and only to a push
 * that git_push allowed for one branch.
 */
export class OttoEgress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const url = new URL(request.url);
    // Credentials the container tried to send are never forwarded. Built only
    // when forwarding: copying a Request consumes its body, which a push still needs.
    const forward = () => {
      const outbound = new Request(request);
      outbound.headers.delete("authorization");
      return fetch(outbound);
    };

    if (props.phase === "setup") return forward();

    if (url.hostname !== GITHUB_HOST) {
      return deny(`${url.hostname} is not reachable outside prepare_workspace`);
    }
    const repo = repoOfPath(url.pathname);
    if (!repo) return deny(`${url.pathname} is not a git endpoint`);

    const service = url.searchParams.get("service") ?? url.pathname.split("/").at(-1);
    if (service === "git-upload-pack") {
      if (props.repo && repo !== props.repo.toLowerCase()) {
        return deny(`fetches are limited to ${props.repo}`);
      }
      return forward();
    }
    if (service !== "git-receive-pack") return deny(`unknown git service ${service}`);

    const push = props.push;
    if (!push) return deny("push without git_push: no credentials");
    if (repo !== push.repo.toLowerCase()) return deny(`push to ${repo} was not allowed`);
    const token = this.env.GITHUB_TOKEN;
    if (!token) return deny("GITHUB_TOKEN is not configured");

    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === "POST") {
      body = new Uint8Array(await request.arrayBuffer());
      let commands;
      try {
        commands = parseReceivePackCommands(body);
      } catch (error) {
        return deny(error instanceof Error ? error.message : String(error));
      }
      const allowedRef = `refs/heads/${push.branch}`;
      for (const command of commands) {
        if (command.ref !== allowedRef) return deny(`push to ${command.ref} was not allowed`);
        if (ZERO_OID.test(command.new)) return deny(`deleting ${command.ref} is not allowed`);
      }
    }

    const headers = new Headers(request.headers);
    headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
    return fetch(request.url, { method: request.method, headers, body });
  }
}
