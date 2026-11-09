import { fileURLToPath } from "node:url";

/** The lease/authority CLI shipped in this package; the Orca tools shell out to it. */
export const AUTO_CLI = fileURLToPath(new URL("./auto/cli.mjs", import.meta.url));
