import argon2 from "argon2";

export const PASSWORD_MIN_LENGTH = 10;

export class WeakPasswordError extends Error {
  constructor() {
    super(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    this.name = "WeakPasswordError";
  }
}

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < PASSWORD_MIN_LENGTH) throw new WeakPasswordError();
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
