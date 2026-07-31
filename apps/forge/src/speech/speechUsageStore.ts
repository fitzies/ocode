import type { ForgeDatabase, SpeechUsage } from "../store/database.ts";

export type SpeechUsageLimit = "characters" | "requests";

export type SpeechUsageReservation =
  | { accepted: true; usage: SpeechUsage }
  | { accepted: false; usage: SpeechUsage; limit: SpeechUsageLimit };

export class SpeechUsageStore {
  constructor(private readonly database: ForgeDatabase) {}

  reserve(
    date: string,
    characters: number,
    limits: { characters: number; requests: number },
  ): SpeechUsageReservation {
    return this.database.reserveSpeechUsage(date, characters, limits);
  }

  get(date: string): SpeechUsage {
    return this.database.speechUsage(date);
  }
}
