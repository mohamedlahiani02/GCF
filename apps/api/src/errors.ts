/** Errors carrying an HTTP status and a stable machine code the web client can translate. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = () => new HttpError(403, "forbidden", "you do not have access to this resource");
export const unauthenticated = () => new HttpError(401, "unauthenticated", "authentication required");
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);
