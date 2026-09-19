import { loadConfig } from "../config";
import { startTarget } from "./server";

const config = loadConfig();
const variant = process.env.TARGET_VARIANT === "alt" ? "alt" : "classic";
const target = await startTarget({ port: config.targetPort, host: "0.0.0.0", variant });
console.log(`controlled target (${variant}) on ${target.url}; browser-facing URL ${config.controlledTargetUrl}`);
