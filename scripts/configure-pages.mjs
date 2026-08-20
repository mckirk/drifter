import { writeFile } from "node:fs/promises";

const clockEndpoint = (process.env.DRIFTER_CLOCK_URL ?? "").trim();

if (clockEndpoint && !clockEndpoint.startsWith("https://")) {
  throw new Error("DRIFTER_CLOCK_URL must be an HTTPS URL");
}

await writeFile(
  new URL("../runtime-config.js", import.meta.url),
  `window.DRIFTER_CONFIG = ${JSON.stringify({ clockEndpoint }, null, 2)};\n`,
);

console.log(clockEndpoint ? "Configured the precision clock endpoint." : "No precision clock endpoint configured; fallbacks remain enabled.");
