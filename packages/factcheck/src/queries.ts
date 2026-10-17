import type { Language, VideoInfo } from "./types.js";

const FACT_CHECK: Record<Language, string> = { en: "fact check", zh: "事實查核" };

/** Search for reviews of the whole video. Undefined when there is no title or channel to search on. */
export function videoQuery(video: VideoInfo, language: Language): string | undefined {
  const parts = [video.title, video.channel].map((p) => p?.trim()).filter(Boolean);
  return parts.length > 0 ? `${parts.join(" ")} ${FACT_CHECK[language]}` : undefined;
}

/** The channel prefix steers search toward reviews of this video, which beat generic pages. */
export function claimQuery(claim: string, language: Language, video?: VideoInfo): string {
  const channel = video?.channel?.trim();
  return `${channel ? `${channel}: ` : ""}${claim.trim()} ${FACT_CHECK[language]}`;
}
