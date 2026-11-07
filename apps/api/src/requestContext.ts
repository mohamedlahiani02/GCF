import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  apiTokenId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs the rest of a request (its route hooks and handler) with the access token that authenticated it, so the
 * audit log can record the token without every route passing it along. Outside a request (background jobs,
 * command-line tools) there is no context and no token.
 */
export function runWithApiToken(apiTokenId: string | null, next: () => void): void {
  storage.run({ apiTokenId }, next);
}

export function currentApiTokenId(): string | null {
  return storage.getStore()?.apiTokenId ?? null;
}
