import { Case } from "./schema";

export function parseCase(input: unknown): Case {
  return Case.parse(input);
}

export function safeParseCase(input: unknown) {
  return Case.safeParse(input);
}

export function parseCases(input: unknown): Case[] {
  return Case.array().parse(input);
}
